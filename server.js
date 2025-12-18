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

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com';
const RAPIDAPI_TIMEOUT_MS = Number(process.env.RAPIDAPI_TIMEOUT_MS || 10000);
const TRUST_PROXY = process.env.TRUST_PROXY;

const CSV_READ_HIGH_WATER_MARK = envPositiveInt(
  process.env.CSV_READ_HIGH_WATER_MARK,
  256 * 1024
);

const masterCsvPath = path.join(__dirname, 'data', 'master.csv');
const acftRefCsvPath = path.join(__dirname, 'data', 'acftref.csv');

const MSG_INVALID_INPUT = 'Invalid input.';
const MSG_SERVER_ERROR = 'Server error.';
const MSG_NOT_FOUND = 'Not found.';

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
  return data?.[0]?.aircraft?.reg || data?.[0]?.aircraft?.registration || null;
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
  const mfrMdlCodeIdx = indexByName.get('MFR MDL CODE') ?? null;
  const kitManufacturerIdx = indexByName.get('KIT MFR') ?? null;
  const kitModelIdx = indexByName.get('KIT MODEL') ?? null;

  if (typeof nNumberIdx !== 'number' || typeof yearIdx !== 'number') return null;

  return {
    nNumberIdx,
    yearIdx,
    mfrMdlCodeIdx: typeof mfrMdlCodeIdx === 'number' ? mfrMdlCodeIdx : null,
    kitManufacturerIdx: typeof kitManufacturerIdx === 'number' ? kitManufacturerIdx : null,
    kitModelIdx: typeof kitModelIdx === 'number' ? kitModelIdx : null,
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
          mfrMdlCodeIdx: 2,
          kitManufacturerIdx: 31,
          kitModelIdx: 32,
        };

        schema.wantedAll = makeWantedCsvIndices([
          schema.nNumberIdx,
          schema.yearIdx,
          schema.mfrMdlCodeIdx,
          schema.kitManufacturerIdx,
          schema.kitModelIdx,
        ]);
        schema.wantedDetails = makeWantedCsvIndices([
          schema.yearIdx,
          schema.mfrMdlCodeIdx,
          schema.kitManufacturerIdx,
          schema.kitModelIdx,
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
          mfrMdlCode:
            schema.mfrMdlCodeIdx == null ? '' : String(fields.get(schema.mfrMdlCodeIdx) || '').trim(),
          kitManufacturer:
            schema.kitManufacturerIdx == null
              ? ''
              : String(fields.get(schema.kitManufacturerIdx) || '').trim(),
          kitModel:
            schema.kitModelIdx == null ? '' : String(fields.get(schema.kitModelIdx) || '').trim(),
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
        mfrMdlCode:
          schema.mfrMdlCodeIdx == null ? '' : String(fields.get(schema.mfrMdlCodeIdx) || '').trim(),
        kitManufacturer:
          schema.kitManufacturerIdx == null
            ? ''
            : String(fields.get(schema.kitManufacturerIdx) || '').trim(),
        kitModel:
          schema.kitModelIdx == null ? '' : String(fields.get(schema.kitModelIdx) || '').trim(),
      };
      rl.close();
      stream.destroy();
    });

    rl.on('close', () => done());
    rl.on('error', done);
    stream.on('error', done);
  });
}

function inferAcftRefSchemaFromHeaderLine(line) {
  const cols = parseCsvLine(String(line || ''));
  if (!cols || cols.length === 0) return null;

  const indexByName = new Map();
  for (let i = 0; i < cols.length; i++) {
    const key = normalizeHeaderName(cols[i]);
    if (!key) continue;
    if (!indexByName.has(key)) indexByName.set(key, i);
  }

  const codeIdx =
    indexByName.get('MFR MDL CODE') ??
    indexByName.get('CODE') ??
    indexByName.get('MFRMDLCODE') ??
    null;

  if (typeof codeIdx !== 'number') return null;

  const manufacturerIdx =
    indexByName.get('MANUFACTURER') ??
    indexByName.get('MFR') ??
    indexByName.get('MFR NAME') ??
    null;
  const modelIdx = indexByName.get('MODEL') ?? indexByName.get('MODEL NAME') ?? null;

  const typeAcftIdx =
    indexByName.get('TYPE-ACFT') ?? indexByName.get('TYPE ACFT') ?? indexByName.get('TYPE AIRCRAFT') ?? null;

  return {
    codeIdx,
    manufacturerIdx: typeof manufacturerIdx === 'number' ? manufacturerIdx : null,
    modelIdx: typeof modelIdx === 'number' ? modelIdx : null,
    typeAcftIdx: typeof typeAcftIdx === 'number' ? typeAcftIdx : null,
  };
}

function findAircraftInAcftRef(mfrMdlCode, csvPath = acftRefCsvPath) {
  return new Promise((resolve, reject) => {
    const needle = String(mfrMdlCode || '').trim().toUpperCase();
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
      } else resolve(found);
    }

    rl.on('line', (line) => {
      if (found) return;
      if (!line) return;

      if (!sawFirstLine) {
        sawFirstLine = true;
        const headerSchema = inferAcftRefSchemaFromHeaderLine(line);
        schema = headerSchema || {
          codeIdx: 0,
          manufacturerIdx: 1,
          modelIdx: 2,
          typeAcftIdx: 3,
        };

        schema.wantedAll = makeWantedCsvIndices([
          schema.codeIdx,
          schema.manufacturerIdx,
          schema.modelIdx,
          schema.typeAcftIdx,
        ]);

        if (headerSchema) return;
      }

      const fields = parseCsvFieldsAt(line, schema.wantedAll);
      const candidate = normalizeNNumberField(fields.get(schema.codeIdx));
      if (candidate !== needle) return;

      found = {
        mfrMdlCode: needle,
        manufacturer:
          schema.manufacturerIdx == null ? '' : String(fields.get(schema.manufacturerIdx) || '').trim(),
        model: schema.modelIdx == null ? '' : String(fields.get(schema.modelIdx) || '').trim(),
        typeAcft: schema.typeAcftIdx == null ? '' : String(fields.get(schema.typeAcftIdx) || '').trim(),
      };
      rl.close();
      stream.destroy();
    });

    rl.on('close', () => done());
    rl.on('error', done);
    stream.on('error', done);
  });
}

async function resolveAircraftSpecsByNNumber(
  nNumber,
  { masterPath = masterCsvPath, acftRefPath = acftRefCsvPath } = {}
) {
  const aircraft = await findAircraftInMasterCsv(nNumber, masterPath);
  if (!aircraft) return null;

  let manufacturer = '';
  let model = '';
  let typeAcft = '';

  const hasCode = String(aircraft.mfrMdlCode || '').trim();
  if (hasCode) {
    const ref = await findAircraftInAcftRef(aircraft.mfrMdlCode, acftRefPath);
    if (ref) {
      manufacturer = String(ref.manufacturer || '').trim();
      model = String(ref.model || '').trim();
      typeAcft = String(ref.typeAcft || '').trim();
    }
  }

  if (!manufacturer && !model) {
    manufacturer = String(aircraft.kitManufacturer || '').trim();
    model = String(aircraft.kitModel || '').trim();
  }

  const aircraftType = [manufacturer, model].filter(Boolean).join(' ') || '';

  return {
    ...aircraft,
    manufacturer,
    model,
    aircraftType: aircraftType || null,
    typeAcft: typeAcft || null,
  };
}

async function fetchTailNumber({
  flightNumber,
  date,
  apiKey = RAPIDAPI_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = RAPIDAPI_TIMEOUT_MS,
} = {}) {
  if (!apiKey) return { ok: false, registration: null };
  if (typeof fetchImpl !== 'function') {
    return { ok: false, registration: null };
  }

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
  } catch (err) {
    return { ok: false, registration: null };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return { ok: false, registration: null };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ok: false, registration: null };
  }
  const registration = extractRegistrationFromFlightResponse(data);
  return { ok: true, registration: registration || null };
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

    const tailResult = await fetchTailNumber({ flightNumber, date });
    if (!tailResult.ok) {
      return res.json({ ok: false, message: 'Flight details currently unavailable.' });
    }

    if (!tailResult.registration) {
      return res.json({
        ok: false,
        message: "Airline hasn't published an assigned aircraft yet.",
      });
    }

    const registration = tailResult.registration;
    const nNumber = normalizeNNumberFromRegistration(registration);
    const aircraft = await resolveAircraftSpecsByNNumber(nNumber);
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
      aircraftType: aircraft.aircraftType,
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
  findAircraftInAcftRef,
  resolveAircraftSpecsByNNumber,
  fetchTailNumber,
  getPublicBypassResult,
};
