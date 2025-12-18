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
} = require('../server');

test('normalization', () => {
  assert.equal(normalizeFlightNumber('DL 47'), 'DL47');
  assert.equal(normalizeDate('2025-01-02'), '2025-01-02');
  assert.equal(normalizeDate('01/02/2025'), null);
  assert.equal(normalizeNNumberFromRegistration('N123AB'), '123AB');
});

test('codeshare array handling uses first result', () => {
  const data = [
    { aircraft: { registration: 'FIRST' } },
    { aircraft: { registration: 'SECOND' } },
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

test('fetchTailNumber reads response[0].aircraft.registration', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ aircraft: { registration: 'N12345' } }],
  });
  const reg = await fetchTailNumber({
    flightNumber: 'DL47',
    date: '2025-01-02',
    apiKey: 'test',
    fetchImpl,
    timeoutMs: 50,
  });
  assert.equal(reg, 'N12345');
});

