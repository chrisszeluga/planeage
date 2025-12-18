# planeage

Resolve `Flight #` → `Tail #` → `Mfr Year` → `Aircraft Age`.

## Setup

1. Install deps:
   - `npm install`
2. Create `.env` from `.env.example`:
   - `cp .env.example .env`
   - set `RAPIDAPI_KEY=...`
3. Download the FAA registry cache (large):
   - `npm run refresh`

## Run

- `npm start`
- Open `http://localhost:3000`

## Demo Bypass

For demos without calling RapidAPI: submit flight `TT111` on `2025-01-01` to return a fictional aircraft with age `10`.

## Scripts

- `npm run refresh` — download + atomically swap `data/master.csv`
- `npm test` — minimalist test suite (no external calls)
- `npm run verify` — memory/stream sanity check (early-match lookup)
- `npm run verify:full` — worst-case full scan (no-match)

## Env Vars

- `RAPIDAPI_KEY` — required for lookups
- `PORT` — server port (default `3000`)
- `RAPIDAPI_TIMEOUT_MS` — RapidAPI fetch timeout (default `10000`)
- `TRUST_PROXY` — set when behind a reverse proxy (e.g. `1`)
