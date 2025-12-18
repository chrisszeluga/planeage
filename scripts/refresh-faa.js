const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');

const FAA_ZIP_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';

function dataDir() {
  const raw = String(process.env.FAA_DATA_DIR || '').trim();
  return raw ? path.resolve(raw) : path.join(__dirname, '..', 'data');
}

function normalizeGcsObjectName(value) {
  const raw = String(value || '').trim();
  const stripped = raw.replace(/^\/+/, '');
  return stripped.replace(/\/+$/, '');
}

const GCS_BUCKET = String(process.env.GCS_BUCKET || '').trim();
const GCS_PREFIX = normalizeGcsObjectName(process.env.GCS_PREFIX || 'faa');
const GCS_MANIFEST_OBJECT =
  normalizeGcsObjectName(process.env.GCS_MANIFEST_OBJECT) ||
  (GCS_PREFIX ? `${GCS_PREFIX}/current.json` : 'current.json');

function paths() {
  const dir = dataDir();
  return {
    dataDir: dir,
    zipPath: path.join(dir, 'temp.zip'),
    extractedMasterPath: path.join(dir, 'MASTER.txt'),
    extractedAcftRefPath: path.join(dir, 'ACFTREF.txt'),
    masterPath: path.join(dir, 'master.csv'),
    acftRefPath: path.join(dir, 'acftref.csv'),
    oldMasterPath: path.join(dir, 'master.old'),
    oldAcftRefPath: path.join(dir, 'acftref.old'),
  };
}

function envPositiveMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envNonNegativeInt(raw, fallback) {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DOWNLOAD_TIMEOUT_MS = envPositiveMs(process.env.DOWNLOAD_TIMEOUT_MS, 2 * 60 * 1000);
const MAX_REDIRECTS = envNonNegativeInt(process.env.MAX_REDIRECTS, 5);

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function downloadToFile(url, destPath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const isRedirect =
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location;

      if (isRedirect) {
        response.resume();
        if (redirectsLeft <= 0) {
          return reject(new Error('Download failed (too many redirects)'));
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        return resolve(downloadToFile(nextUrl, destPath, redirectsLeft - 1));
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed (HTTP ${response.statusCode})`));
      }

      const fileStream = fs.createWriteStream(destPath);
      pipeline(response, fileStream)
        .then(resolve)
        .catch(async (err) => {
          try {
            await fsp.rm(destPath, { force: true });
          } catch {}
          reject(err);
        });
    });

    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
    });

    request.on('response', (response) => {
      response.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        response.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
      });
    });

    request.on('error', reject);
  });
}

async function extractTxtFromZip(zipFilePath, suffixLower, destPath) {
  const zip = new AdmZip(zipFilePath);
  const entry = zip
    .getEntries()
    .find((e) => (e.entryName || '').toLowerCase().endsWith(suffixLower));

  if (!entry) throw new Error(`${suffixLower} not found in zip`);

  const destDir = path.dirname(destPath);
  await fsp.rm(destPath, { force: true });
  zip.extractEntryTo(entry.entryName, destDir, false, true);

  if (!(await pathExists(destPath))) {
    throw new Error(`Extraction failed (${suffixLower} missing after extract)`);
  }
}

async function atomicSwap(p) {
  const hasMaster = await pathExists(p.masterPath);
  const hasAcftRef = await pathExists(p.acftRefPath);

  try {
    if (hasMaster) await fsp.rename(p.masterPath, p.oldMasterPath);
    if (hasAcftRef) await fsp.rename(p.acftRefPath, p.oldAcftRefPath);

    await fsp.rename(p.extractedMasterPath, p.masterPath);
    await fsp.rename(p.extractedAcftRefPath, p.acftRefPath);
  } catch (err) {
    if (hasMaster && (await pathExists(p.oldMasterPath)) && !(await pathExists(p.masterPath))) {
      try { await fsp.rename(p.oldMasterPath, p.masterPath); } catch {}
    }
    if (hasAcftRef && (await pathExists(p.oldAcftRefPath)) && !(await pathExists(p.acftRefPath))) {
      try { await fsp.rename(p.oldAcftRefPath, p.acftRefPath); } catch {}
    }
    throw err;
  }

  if (hasMaster) await fsp.rm(p.oldMasterPath, { force: true });
  if (hasAcftRef) await fsp.rm(p.oldAcftRefPath, { force: true });
  await fsp.rm(p.zipPath, { force: true });
}

async function cleanupTemps(p) {
  await fsp.rm(p.extractedMasterPath, { force: true });
  await fsp.rm(p.extractedAcftRefPath, { force: true });
  await fsp.rm(p.zipPath, { force: true });
}

function objectInPrefix(prefix, objectName) {
  const cleanPrefix = normalizeGcsObjectName(prefix);
  const cleanObject = normalizeGcsObjectName(objectName);
  if (!cleanPrefix) return cleanObject;
  if (!cleanObject) return cleanPrefix;
  return `${cleanPrefix}/${cleanObject}`;
}

function refreshStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function uploadFileToGcs(bucket, localPath, objectName) {
  const file = bucket.file(objectName);
  await pipeline(
    fs.createReadStream(localPath),
    file.createWriteStream({
      resumable: true,
      metadata: { contentType: 'text/plain; charset=utf-8' },
    })
  );
}

async function uploadManifest(bucket, objectName, payload) {
  const body = JSON.stringify(payload, null, 2) + '\n';
  await bucket.file(objectName).save(body, {
    resumable: false,
    contentType: 'application/json; charset=utf-8',
  });
}

async function uploadToGcsIfConfigured(p) {
  if (!GCS_BUCKET) return;
  const { Storage } = require('@google-cloud/storage');
  const storage = new Storage();
  const bucket = storage.bucket(GCS_BUCKET);

  const stamp = refreshStamp();
  const masterObject = objectInPrefix(GCS_PREFIX, `master-${stamp}.csv`);
  const acftRefObject = objectInPrefix(GCS_PREFIX, `acftref-${stamp}.csv`);

  console.log(`Uploading to gs://${GCS_BUCKET}/${GCS_PREFIX || ''}...`);
  await uploadFileToGcs(bucket, p.masterPath, masterObject);
  await uploadFileToGcs(bucket, p.acftRefPath, acftRefObject);

  await uploadManifest(bucket, GCS_MANIFEST_OBJECT, {
    updatedAt: new Date().toISOString(),
    master: masterObject,
    acftref: acftRefObject,
  });

  console.log(`Updated manifest: gs://${GCS_BUCKET}/${GCS_MANIFEST_OBJECT}`);
}

async function main() {
  const p = paths();
  await fsp.mkdir(p.dataDir, { recursive: true });

  try {
    console.log('Downloading FAA registry zip...');
    await downloadToFile(FAA_ZIP_URL, p.zipPath);

    console.log('Extracting MASTER.txt...');
    await extractTxtFromZip(p.zipPath, 'master.txt', p.extractedMasterPath);

    console.log('Extracting ACFTREF.txt...');
    await extractTxtFromZip(p.zipPath, 'acftref.txt', p.extractedAcftRefPath);

    console.log('Swapping in new data files...');
    await atomicSwap(p);

    await uploadToGcsIfConfigured(p);

    console.log('Done.');
  } catch (err) {
    await cleanupTemps(p);
    throw err;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
