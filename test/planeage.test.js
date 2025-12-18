const test = require('node:test');
const assert = require('assert/strict');
const path = require('path');

const {
  normalizeFlightNumber,
  normalizeDate,
  normalizeNNumberFromRegistration,
  extractRegistrationFromFlightResponse,
  findAircraftInMasterCsv,
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
  const csvPath = path.join(__dirname, 'fixtures', 'master.sample.csv');
  const r1 = await findAircraftInMasterCsv('123AB', csvPath);
  assert.equal(r1.year, '2015');

  const r2 = await findAircraftInMasterCsv('100', csvPath);
  assert.equal(r2.year, '1998');
});

test('CSV lookup uses header names (KIT MFR / KIT MODEL fallback)', async () => {
  const csvPath = path.join(__dirname, 'fixtures', 'master.kit.schema.csv');
  const r = await findAircraftInMasterCsv('12345', csvPath);
  assert.equal(r.year, '2010');
  assert.equal(r.manufacturer, 'BEECHCRAFT');
  assert.equal(r.model, 'KING AIR 350');
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
