const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const { findAircraftInMasterCsv } = require('../server');

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function memSnapshot() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed };
}

function printMem(label, snap) {
  console.log(`${label}: rss=${mb(snap.rss)}MB heap=${mb(snap.heapUsed)}MB`);
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

async function firstNNumberFromCsv(csvPath) {
  const stream = fs.createReadStream(csvPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
      rl.close();
      stream.destroy();
    };

    const ok = settle(resolve);
    const fail = settle(reject);

    rl.on('line', (line) => {
      if (!line) return;
      const comma = line.indexOf(',');
      if (comma <= 0) return;

      const raw = line
        .slice(0, comma)
        .replace(/"/g, '')
        .replace(/^\uFEFF/, '')
        .trim();

      if (/^(?=.*\d)[0-9A-Z]+$/i.test(raw)) ok(raw);
    });

    rl.on('close', () => ok(null));
    rl.on('error', fail);
    stream.on('error', fail);
  });
}

async function main() {
  const fullScan = process.argv.includes('--full-scan');
  const csvArg = argValue('--csv');
  const nArg = argValue('--n');

  const csvPath = csvArg
    ? path.resolve(process.cwd(), csvArg)
    : path.join(__dirname, '..', 'data', 'master.csv');

  let stat;
  try {
    stat = await fsp.stat(csvPath);
  } catch {
    console.log(`master.csv: missing (${csvPath})`);
    console.log('Run `npm run refresh` first.');
    return;
  }

  console.log(`master.csv: ${mb(stat.size)}MB`);

  const before = memSnapshot();
  printMem('before', before);

  let target = nArg ? String(nArg).trim() : null;
  if (!target && !fullScan) target = await firstNNumberFromCsv(csvPath);
  if (fullScan) target = '__NO_MATCH_FULL_SCAN__';

  if (!target) {
    console.log('No N-number found for probe.');
    return;
  }

  const label = fullScan ? 'CSV scan: full (no-match)' : `CSV scan: early match (N=${target})`;
  console.log(label);

  const start = process.hrtime.bigint();
  const result = await findAircraftInMasterCsv(target, csvPath);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  if (!fullScan && !result) {
    console.log('Lookup failed (unexpected).');
    process.exitCode = 1;
  }

  if (global.gc) global.gc();

  const after = memSnapshot();
  printMem('after', after);
  console.log(`delta: rss=${mb(after.rss - before.rss)}MB heap=${mb(after.heapUsed - before.heapUsed)}MB`);
  console.log(`time: ${Math.round(elapsedMs)}ms`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});

