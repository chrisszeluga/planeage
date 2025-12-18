const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');

const FAA_ZIP_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';

const dataDir = path.join(__dirname, '..', 'data');
const zipPath = path.join(dataDir, 'temp.zip');
const extractedPath = path.join(dataDir, 'MASTER.txt');
const masterPath = path.join(dataDir, 'master.csv');
const oldPath = path.join(dataDir, 'master.old');

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const isRedirect =
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location;

      if (isRedirect) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        return resolve(downloadToFile(nextUrl, destPath));
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed (HTTP ${response.statusCode})`));
      }

      const fileStream = fs.createWriteStream(destPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => fileStream.close(resolve));
      fileStream.on('error', (err) => {
        response.destroy();
        fs.unlink(destPath, () => reject(err));
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
