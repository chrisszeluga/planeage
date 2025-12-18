const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');

const {
  normalizeFlightNumber,
  normalizeDate,
  normalizeNNumberFromRegistration,
  extractRegistrationFromFlightResponse,
  findAircraftInMasterCsv,
} = require('../server');

const masterPath = path.join(__dirname, '..', 'data', 'master.csv');

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

async function firstNNumberFromMasterCsv() {
  const fsSync = require('fs');
  const readline = require('readline');

  const stream = fsSync.createReadStream(masterPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  return await new Promise((resolve, reject) => {
    let settled = false;

    function resolveOnce(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    function rejectOnce(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    function done(value) {
      resolveOnce(value);
      rl.close();
      stream.destroy();
    }

    rl.on('line', (line) => {
      if (!line) return;
      const comma = line.indexOf(',');
      if (comma <= 0) return;
      const raw = line.slice(0, comma).replace(/"/g, '').trim();
      if (/^(?=.*\d)[0-9A-Z]+$/i.test(raw)) done(raw);
    });

    rl.on('close', () => resolveOnce(null));
    rl.on('error', rejectOnce);
    stream.on('error', rejectOnce);
  });
}

async function runUnitChecks() {
  assert.equal(normalizeFlightNumber('DL 47'), 'DL47');
  assert.equal(normalizeFlightNumber('  klm 1395  '), 'klm1395');
  assert.equal(normalizeDate('2025-01-02'), '2025-01-02');
  assert.equal(normalizeDate('01/02/2025'), null);
  assert.equal(normalizeNNumberFromRegistration('N12345'), '12345');
  assert.equal(normalizeNNumberFromRegistration(' n-123ab '), '123ab');

  assert.equal(extractRegistrationFromFlightResponse([]), null);
  assert.equal(extractRegistrationFromFlightResponse([{ aircraft: { registration: 'N1' } }]), 'N1');
  assert.equal(
    extractRegistrationFromFlightResponse([
      { aircraft: { registration: 'FIRST' } },
      { aircraft: { registration: 'SECOND' } },
    ]),
    'FIRST'
  );
}

async function runCsvLookupChecks({ fullScan }) {
  try {
    const stat = await fs.stat(masterPath);
    console.log(`master.csv: ${mb(stat.size)}MB`);
  } catch {
    console.log('master.csv: missing (run `npm run refresh`)');
    return;
  }

  const before = memSnapshot();
  printMem('before', before);

  let nNumber = null;
  if (!fullScan) nNumber = await firstNNumberFromMasterCsv();

  const target = fullScan ? '__NO_MATCH_FULL_SCAN__' : nNumber;
  if (!target) {
    console.log('CSV probe skipped (could not read an N-number from file).');
    return;
  }

  console.log(fullScan ? 'CSV scan: full (no-match)' : `CSV scan: early match (N=${target})`);
  const result = await findAircraftInMasterCsv(target);
  if (!fullScan) assert.ok(result && result.nNumber === target);

  if (global.gc) global.gc();

  const after = memSnapshot();
  printMem('after', after);
  console.log(`delta: rss=${mb(after.rss - before.rss)}MB heap=${mb(after.heapUsed - before.heapUsed)}MB`);
}

async function main() {
  const fullScan = process.argv.includes('--full-scan');

  await runUnitChecks();
  console.log('Unit checks: ok');

  await runCsvLookupChecks({ fullScan });
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
