const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const dataDir = path.join(__dirname, '..', 'data');
const masterPath = path.join(dataDir, 'master.csv');

const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 7);
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 6 * 60 * 60 * 1000);

let isRefreshing = false;

async function fileAgeMs(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

async function maybeRefresh() {
  if (isRefreshing) return;

  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const ageMs = await fileAgeMs(masterPath);

  if (ageMs <= maxAgeMs) return;

  isRefreshing = true;
  console.log('FAA data is stale; refreshing...');

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'refresh-faa.js')], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`refresh-faa.js exited with code ${code}`));
    });
  }).finally(() => {
    isRefreshing = false;
  });
}

async function main() {
  await fs.mkdir(dataDir, { recursive: true });

  await maybeRefresh();
  setInterval(maybeRefresh, CHECK_INTERVAL_MS);

  console.log(
    `Refresh cron running (maxAgeDays=${MAX_AGE_DAYS}, checkIntervalMs=${CHECK_INTERVAL_MS})`
  );
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
