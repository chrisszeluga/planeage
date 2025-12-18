const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');

const FAA_ZIP_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';

const dataDir = path.join(__dirname, '..', 'data');
const zipPath = path.join(dataDir, 'temp.zip');
const extractedPath = path.join(dataDir, 'MASTER.txt');
const masterPath = path.join(dataDir, 'master.csv');
const oldPath = path.join(dataDir, 'master.old');

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

async function extractMasterTxt(zipFilePath) {
  const zip = new AdmZip(zipFilePath);
  const entry = zip
    .getEntries()
    .find((e) => (e.entryName || '').toLowerCase().endsWith('master.txt'));

  if (!entry) throw new Error('MASTER.txt not found in zip');

  await fsp.rm(extractedPath, { force: true });
  zip.extractEntryTo(entry.entryName, dataDir, false, true);

  if (!(await pathExists(extractedPath))) {
    throw new Error('Extraction failed (MASTER.txt missing after extract)');
  }
}

async function atomicSwap() {
  const hasCurrent = await pathExists(masterPath);
  if (hasCurrent) await fsp.rename(masterPath, oldPath);

  try {
    await fsp.rename(extractedPath, masterPath);
  } catch (err) {
    if (hasCurrent && (await pathExists(oldPath)) && !(await pathExists(masterPath))) {
      try {
        await fsp.rename(oldPath, masterPath);
      } catch {}
    }
    throw err;
  }

  if (hasCurrent) await fsp.rm(oldPath, { force: true });
  await fsp.rm(zipPath, { force: true });
}

async function cleanupTemps() {
  await fsp.rm(extractedPath, { force: true });
  await fsp.rm(zipPath, { force: true });
}

async function main() {
  await fsp.mkdir(dataDir, { recursive: true });

  try {
    console.log('Downloading FAA registry zip...');
    await downloadToFile(FAA_ZIP_URL, zipPath);

    console.log('Extracting MASTER.txt...');
    await extractMasterTxt(zipPath);

    console.log('Swapping in new master.csv...');
    await atomicSwap();

    console.log('Done.');
  } catch (err) {
    await cleanupTemps();
    throw err;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
