if (require.main === module) require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const app = express();

function envNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envPositiveInt(raw, fallback) {
  return Math.max(0, Math.trunc(envNumber(raw, fallback)));
}

function envPositiveMs(raw, fallback) {
  const n = envNumber(raw, fallback);
  return n > 0 ? n : fallback;
}

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com';
const RAPIDAPI_TIMEOUT_MS = Number(process.env.RAPIDAPI_TIMEOUT_MS || 10000);
const TRUST_PROXY = process.env.TRUST_PROXY;

const FLIGHT_CACHE_TTL_MS = envPositiveMs(process.env.FLIGHT_CACHE_TTL_MS, 5 * 60 * 1000);
const FLIGHT_CACHE_MAX = envPositiveInt(process.env.FLIGHT_CACHE_MAX, 500);
const AIRCRAFT_CACHE_TTL_MS = envPositiveMs(
  process.env.AIRCRAFT_CACHE_TTL_MS,
  6 * 60 * 60 * 1000
);
const AIRCRAFT_CACHE_MAX = envPositiveInt(process.env.AIRCRAFT_CACHE_MAX, 5000);
const CSV_MAX_INFLIGHT = Math.max(1, envPositiveInt(process.env.CSV_MAX_INFLIGHT, 4));
const CSV_READ_HIGH_WATER_MARK = envPositiveInt(
  process.env.CSV_READ_HIGH_WATER_MARK,
  256 * 1024
);

const masterCsvPath = path.join(__dirname, 'data', 'master.csv');

const MSG_INVALID_INPUT = 'Invalid input.';
const MSG_SERVER_ERROR = 'Server error.';
const MSG_NOT_FOUND = 'Not found.';

const flightCache = new Map();
const inflightFlight = new Map();
const aircraftCache = new Map();
const inflightAircraft = new Map();

let csvInFlight = 0;
const csvWaiters = [];

function getPublicBypassResult(flightNumber, date) {
  if (flightNumber !== 'TT111') return null;
  if (date !== '2025-01-01') return null;

  return {
    registration: 'TT-111',
    nNumber: null,
    year: '2015',
    manufacturer: 'Incom Corporation',
    model: 'T-65B X-wing Starfighter',
    age: 10,
  };
}

function normalizeFlightNumber(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return null;
}

function normalizeNNumberFromRegistration(registration) {
  const cleaned = String(registration || '').trim().replace(/[^0-9a-z]/gi, '');
  return cleaned.replace(/^N/i, '').toUpperCase();
}

function extractRegistrationFromFlightResponse(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  return data?.[0]?.aircraft?.registration || null;
}

function cacheGetLru(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }

  map.delete(key);
  map.set(key, entry);
  return entry.value;
}

function cacheSetLru(map, key, value, ttlMs, maxEntries) {
  if (maxEntries <= 0) return;

  const expiresAt = Date.now() + Math.max(1, ttlMs);
  if (map.has(key)) map.delete(key);
  map.set(key, { expiresAt, value });

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function getOrCreateInflight(map, key, factory) {
  const existing = map.get(key);
  if (existing) return existing;

  const promise = Promise.resolve()
    .then(factory)
    .finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
}

function acquireCsvPermit() {
  if (csvInFlight < CSV_MAX_INFLIGHT) {
    csvInFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => csvWaiters.push(resolve));
}

function releaseCsvPermit() {
  csvInFlight = Math.max(0, csvInFlight - 1);
  const next = csvWaiters.shift();
  if (next) {
    csvInFlight++;
    next();
  }
}

async function withCsvPermit(fn) {
  await acquireCsvPermit();
  try {
    return await fn();
  } finally {
    releaseCsvPermit();
  }
}

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }

  out.push(field);
  return out;
}

function stripLeadingBom(value) {
  const str = String(value || '');
  if (str.length > 0 && str.charCodeAt(0) === 0xfeff) return str.slice(1);
  return str;
}

function stripAllQuotes(value) {
  const str = String(value || '');
  if (str.indexOf('"') === -1) return str;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '"') out += ch;
  }
  return out;
}

function toUpperIfNeeded(value) {
  const str = String(value || '');
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 97 && code <= 122) return str.toUpperCase();
  }
  return str;
}

function normalizeNNumberField(value) {
  return toUpperIfNeeded(stripAllQuotes(stripLeadingBom(value)).trim());
}

function readFirstCsvField(line) {
  const str = String(line || '');
  if (!str) return '';

  if (str[0] !== '"') {
    const comma = str.indexOf(',');
    if (comma === -1) return str;
    return str.slice(0, comma);
  }

  let inQuotes = true;
  let field = '';

  for (let i = 1; i < str.length; i++) {
    const ch = str[i];
    if (inQuotes) {
      if (ch === '"') {
        if (str[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === ',') break;
  }

  return field;
}

function makeWantedCsvIndices(indices) {
  const unique = Array.from(new Set(indices)).filter((n) => Number.isFinite(n) && n >= 0);
  unique.sort((a, b) => a - b);
  return {
    indices: unique,
    set: new Set(unique),
    max: unique.length ? unique[unique.length - 1] : -1,
  };
}

function parseCsvFieldsAt(line, wanted) {
  const str = String(line || '');
  if (!str) return new Map();

  let fieldIndex = 0;
  let inQuotes = false;
  let collect = wanted.set.has(0);
  let field = collect ? '' : null;

  const out = new Map();

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inQuotes) {
      if (ch === '"') {
        if (str[i + 1] === '"') {
          if (collect) field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (collect) {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      if (collect) out.set(fieldIndex, field);
      if (fieldIndex >= wanted.max) return out;

      fieldIndex++;
      collect = wanted.set.has(fieldIndex);
      field = collect ? '' : null;
      continue;
    }

    if (collect) field += ch;
  }

  if (collect) out.set(fieldIndex, field);
  return out;
}

function normalizeHeaderName(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toUpperCase();
}

function inferMasterCsvSchemaFromHeaderLine(line) {
  const cols = parseCsvLine(String(line || ''));
  if (!cols || cols.length === 0) return null;

  const indexByName = new Map();
  for (let i = 0; i < cols.length; i++) {
    const key = normalizeHeaderName(cols[i]);
    if (!key) continue;
    if (!indexByName.has(key)) indexByName.set(key, i);
  }

  const nNumberIdx = indexByName.get('N-NUMBER');
  const yearIdx = indexByName.get('YEAR MFR');

  if (typeof nNumberIdx !== 'number' || typeof yearIdx !== 'number') return null;

  const manufacturerIdx =
    indexByName.get('MANUFACTURER') ?? indexByName.get('KIT MFR') ?? null;
  const modelIdx = indexByName.get('MODEL') ?? indexByName.get('KIT MODEL') ?? null;

  return {
    nNumberIdx,
    yearIdx,
    manufacturerIdx: typeof manufacturerIdx === 'number' ? manufacturerIdx : null,
    modelIdx: typeof modelIdx === 'number' ? modelIdx : null,
  };
}

function findAircraftInMasterCsv(nNumber, csvPath = masterCsvPath) {
  return new Promise((resolve, reject) => {
    const needle = String(nNumber || '').trim().toUpperCase();
    if (!needle) return resolve(null);

    const stream = fs.createReadStream(csvPath, {
      encoding: 'utf8',
      highWaterMark: CSV_READ_HIGH_WATER_MARK,
    });

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    let found = null;
    let schema = null;
    let sawFirstLine = false;

    function done(err) {
      if (settled) return;
      settled = true;
      if (err) {
        if (err && err.code === 'ENOENT') return resolve(null);
        reject(err);
      }
      else resolve(found);
    }

    rl.on('line', (line) => {
      if (found) return;
      if (!line) return;

      if (!sawFirstLine) {
        sawFirstLine = true;
        const headerSchema = inferMasterCsvSchemaFromHeaderLine(line);
        schema = headerSchema || {
          nNumberIdx: 0,
          yearIdx: 4,
          manufacturerIdx: 20,
          modelIdx: 21,
        };

        schema.wantedAll = makeWantedCsvIndices([
          schema.nNumberIdx,
          schema.yearIdx,
          schema.manufacturerIdx,
          schema.modelIdx,
        ]);
        schema.wantedDetails = makeWantedCsvIndices([
          schema.yearIdx,
          schema.manufacturerIdx,
          schema.modelIdx,
        ]);

        if (headerSchema) return;
      }

      if (schema.nNumberIdx !== 0) {
        const fields = parseCsvFieldsAt(line, schema.wantedAll);
        const candidate = normalizeNNumberField(fields.get(schema.nNumberIdx));
        if (candidate !== needle) return;

        found = {
          nNumber: needle,
          year: String(fields.get(schema.yearIdx) || '').trim(),
          manufacturer:
            schema.manufacturerIdx == null
              ? ''
              : String(fields.get(schema.manufacturerIdx) || '').trim(),
          model: schema.modelIdx == null ? '' : String(fields.get(schema.modelIdx) || '').trim(),
        };
        rl.close();
        stream.destroy();
        return;
      }

      const first = normalizeNNumberField(readFirstCsvField(line));
      if (first !== needle) return;

      const fields = parseCsvFieldsAt(line, schema.wantedDetails);

      found = {
        nNumber: needle,
        year: String(fields.get(schema.yearIdx) || '').trim(),
        manufacturer:
          schema.manufacturerIdx == null
            ? ''
            : String(fields.get(schema.manufacturerIdx) || '').trim(),
        model: schema.modelIdx == null ? '' : String(fields.get(schema.modelIdx) || '').trim(),
      };
      rl.close();
      stream.destroy();
    });

    rl.on('close', () => done());
    rl.on('error', done);
    stream.on('error', done);
  });
}

async function fetchTailNumber({
  flightNumber,
  date,
  apiKey = RAPIDAPI_KEY,
  fetchImpl = fetch,
  timeoutMs = RAPIDAPI_TIMEOUT_MS,
} = {}) {
  if (!apiKey) return null;

  const url = `https://${RAPIDAPI_HOST}/flights/number/${encodeURIComponent(
    flightNumber
  )}/${encodeURIComponent(date)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
        Accept: 'application/json',
      },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) return null;

  let data;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  return extractRegistrationFromFlightResponse(data);
}

if (TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}

app.use(express.json({ limit: '10kb' }));
app.disable('x-powered-by');

const helmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
};
if (!IS_PROD) helmetOptions.hsts = false;

app.use(
  helmet(helmetOptions)
);

app.use(express.static(path.join(__dirname, 'public')));

const checkFlightLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function requireJson(req, res, next) {
  if (req.is('application/json')) return next();
  return res.status(415).json({ ok: false, message: MSG_INVALID_INPUT });
}

const validateCheckFlight = [
  body('flightNumber')
    .isString()
    .trim()
    .isLength({ min: 2, max: 10 })
    .matches(/^[0-9A-Za-z ]+$/),
  body('date').isString().trim().matches(/^\d{4}-\d{2}-\d{2}$/),
];

app.post('/check-flight', checkFlightLimiter, requireJson, validateCheckFlight, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, message: MSG_INVALID_INPUT });
    }

    const flightNumber = normalizeFlightNumber(req.body && req.body.flightNumber);
    const date = normalizeDate(req.body && req.body.date);

    if (!flightNumber || !date) {
      return res.status(400).json({ ok: false, message: MSG_INVALID_INPUT });
    }

    const bypass = getPublicBypassResult(flightNumber.toUpperCase(), date);
    if (bypass) {
      return res.json({
        ok: true,
        flightNumber,
        date,
        ...bypass,
      });
    }

    if (!RAPIDAPI_KEY) {
      return res.status(500).json({ ok: false, message: 'Server not configured.' });
    }

    const flightNumberKey = flightNumber.toUpperCase();
    const flightKey = `${flightNumberKey}|${date}`;
    let registration = cacheGetLru(flightCache, flightKey);
    if (!registration) {
      registration = await getOrCreateInflight(inflightFlight, flightKey, async () => {
        const reg = await fetchTailNumber({ flightNumber: flightNumberKey, date });
        if (reg) cacheSetLru(flightCache, flightKey, reg, FLIGHT_CACHE_TTL_MS, FLIGHT_CACHE_MAX);
        return reg;
      });
    }
    if (!registration) {
      return res.json({ ok: false, message: 'Flight details currently unavailable.' });
    }

    const nNumber = normalizeNNumberFromRegistration(registration).toUpperCase();

    let aircraft = cacheGetLru(aircraftCache, nNumber);
    if (!aircraft) {
      aircraft = await getOrCreateInflight(inflightAircraft, nNumber, async () => {
        const result = await withCsvPermit(() => findAircraftInMasterCsv(nNumber));
        if (result && result.year) {
          cacheSetLru(aircraftCache, nNumber, result, AIRCRAFT_CACHE_TTL_MS, AIRCRAFT_CACHE_MAX);
        }
        return result;
      });
    }
    if (!aircraft || !aircraft.year) {
      return res.json({ ok: false, message: 'Aircraft specs not in local registry.' });
    }

    const mfrYear = Number(aircraft.year);
    const nowYear = new Date().getFullYear();
    const age = Number.isFinite(mfrYear) ? Math.max(0, nowYear - mfrYear) : null;

    return res.json({
      ok: true,
      flightNumber,
      date,
      registration,
      nNumber,
      year: aircraft.year,
      manufacturer: aircraft.manufacturer,
      model: aircraft.model,
      age,
    });
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    return res.status(500).json({ ok: false, message: MSG_SERVER_ERROR });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, message: MSG_NOT_FOUND });
});

app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, message: MSG_INVALID_INPUT });
  }
  console.error(err && err.stack ? err.stack : String(err));
  res.status(500).json({ ok: false, message: MSG_SERVER_ERROR });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PlaneAge listening on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  normalizeFlightNumber,
  normalizeDate,
  normalizeNNumberFromRegistration,
  extractRegistrationFromFlightResponse,
  findAircraftInMasterCsv,
  fetchTailNumber,
  getPublicBypassResult,
};
