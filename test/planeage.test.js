const test = require('node:test');
const assert = require('assert/strict');
const path = require('path');

const {
  normalizeFlightNumber,
  normalizeDate,
  normalizeNNumberFromRegistration,
  extractRegistrationFromFlightResponse,
  findAircraftInMasterCsv,
  findAircraftInAcftRef,
  resolveAircraftSpecsByNNumber,
  fetchTailNumber,
  getPublicBypassResult,
} = require('../server');

test('normalization', () => {
  assert.equal(normalizeFlightNumber('DL 47'), 'DL47');
  assert.equal(normalizeFlightNumber('dl 47'), 'DL47');
  assert.equal(normalizeDate('2025-01-02'), '2025-01-02');
  assert.equal(normalizeDate('01/02/2025'), null);
  assert.equal(normalizeNNumberFromRegistration('N123AB'), '123AB');
});

test('codeshare array handling uses first result', () => {
  const data = [
    { aircraft: { reg: 'FIRST' } },
    { aircraft: { reg: 'SECOND' } },
  ];
  assert.equal(extractRegistrationFromFlightResponse(data), 'FIRST');
});

test('CSV lookup finds by N-number (trimmed)', async () => {
  const csvPath = path.join(__dirname, 'fixtures', 'master.real.header.csv');
  const r1 = await findAircraftInMasterCsv('123AB', csvPath);
  assert.equal(r1.year, '2015');
  assert.equal(r1.mfrMdlCode, '0001234');

  const r2 = await findAircraftInMasterCsv('100', csvPath);
  assert.equal(r2.year, '1998');
  assert.equal(r2.mfrMdlCode, '0009999');
  assert.equal(r2.kitManufacturer, 'KITCO');
  assert.equal(r2.kitModel, 'MODEL-X');
});

test('CSV lookup reads kit fields from MASTER', async () => {
  const csvPath = path.join(__dirname, 'fixtures', 'master.real.header.csv');
  const r = await findAircraftInMasterCsv('100', csvPath);
  assert.equal(r.year, '1998');
  assert.equal(r.kitManufacturer, 'KITCO');
  assert.equal(r.kitModel, 'MODEL-X');
});

test('ACFTREF lookup returns aircraft type text', async () => {
  const csvPath = path.join(__dirname, 'fixtures', 'acftref.sample.csv');
  const r = await findAircraftInAcftRef('0001234', csvPath);
  assert.equal(r.manufacturer, 'BOEING');
  assert.equal(r.model, '737-800');
  assert.equal(r.typeAcft, '4');
});

test('Resolve specs joins MASTER -> ACFTREF when MANUFACTURER/MODEL missing', async () => {
  const masterPath = path.join(__dirname, 'fixtures', 'master.real.header.csv');
  const acftRefPath = path.join(__dirname, 'fixtures', 'acftref.sample.csv');
  const r = await resolveAircraftSpecsByNNumber('123AB', { masterPath, acftRefPath });
  assert.equal(r.year, '2015');
  assert.equal(r.manufacturer, 'BOEING');
  assert.equal(r.model, '737-800');
  assert.equal(r.aircraftType, 'BOEING 737-800');
});

test('fetchTailNumber reads response[0].aircraft.reg', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ aircraft: { reg: 'N12345' } }],
  });
  const result = await fetchTailNumber({
    flightNumber: 'DL47',
    date: '2025-01-02',
    apiKey: 'test',
    fetchImpl,
    timeoutMs: 50,
  });
  assert.equal(result.ok, true);
  assert.equal(result.registration, 'N12345');
});

test('fetchTailNumber ok=true but reg missing returns registration=null', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ aircraft: {} }],
  });
  const result = await fetchTailNumber({
    flightNumber: 'DL47',
    date: '2025-01-02',
    apiKey: 'test',
    fetchImpl,
    timeoutMs: 50,
  });
  assert.equal(result.ok, true);
  assert.equal(result.registration, null);
});

test('public bypass returns star wars demo aircraft', () => {
  const demo = getPublicBypassResult('TT111', '2025-01-01');
  assert.ok(demo);
  assert.equal(demo.age, 10);
  assert.ok(String(demo.model).toLowerCase().includes('x-wing'));
});
