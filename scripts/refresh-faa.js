const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');

const FAA_ZIP_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';

const dataDir = path.join(__dirname, '..', 'data');
const zipPath = path.join(dataDir, 'temp.zip');
const extractedMasterPath = path.join(dataDir, 'MASTER.txt');
const extractedAcftRefPath = path.join(dataDir, 'ACFTREF.txt');
const masterPath = path.join(dataDir, 'master.csv');
const acftRefPath = path.join(dataDir, 'acftref.csv');
const oldMasterPath = path.join(dataDir, 'master.old');
const oldAcftRefPath = path.join(dataDir, 'acftref.old');

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

  await fsp.rm(destPath, { force: true });
  zip.extractEntryTo(entry.entryName, dataDir, false, true);

  if (!(await pathExists(destPath))) {
    throw new Error(`Extraction failed (${suffixLower} missing after extract)`);
  }
}

async function atomicSwap() {
  const hasMaster = await pathExists(masterPath);
  const hasAcftRef = await pathExists(acftRefPath);

  try {
    if (hasMaster) await fsp.rename(masterPath, oldMasterPath);
    if (hasAcftRef) await fsp.rename(acftRefPath, oldAcftRefPath);

    await fsp.rename(extractedMasterPath, masterPath);
    await fsp.rename(extractedAcftRefPath, acftRefPath);
  } catch (err) {
    if (hasMaster && (await pathExists(oldMasterPath)) && !(await pathExists(masterPath))) {
      try { await fsp.rename(oldMasterPath, masterPath); } catch {}
    }
    if (hasAcftRef && (await pathExists(oldAcftRefPath)) && !(await pathExists(acftRefPath))) {
      try { await fsp.rename(oldAcftRefPath, acftRefPath); } catch {}
    }
    throw err;
  }

  if (hasMaster) await fsp.rm(oldMasterPath, { force: true });
  if (hasAcftRef) await fsp.rm(oldAcftRefPath, { force: true });
  await fsp.rm(zipPath, { force: true });
}

async function cleanupTemps() {
  await fsp.rm(extractedMasterPath, { force: true });
  await fsp.rm(extractedAcftRefPath, { force: true });
  await fsp.rm(zipPath, { force: true });
}

async function main() {
  await fsp.mkdir(dataDir, { recursive: true });

  try {
    console.log('Downloading FAA registry zip...');
    await downloadToFile(FAA_ZIP_URL, zipPath);

    console.log('Extracting MASTER.txt...');
    await extractTxtFromZip(zipPath, 'master.txt', extractedMasterPath);

    console.log('Extracting ACFTREF.txt...');
    await extractTxtFromZip(zipPath, 'acftref.txt', extractedAcftRefPath);

    console.log('Swapping in new data files...');
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
