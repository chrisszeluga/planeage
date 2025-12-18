# AGENTS.md - PlaneAge Project Memory

## 1. Project Identity & Goal
PlaneAge is a lightweight aviation tool. It calculates aircraft age by joining real-time flight data with a local FAA registration database.
- **Goal:** Resolve `Flight #` -> `Tail #` -> `Mfr Year` -> `User Output`.

## 2. Tech Stack (Strict)
- **Runtime:** Node.js (CommonJS / `require`).
- **Web:** Express.js (Single `server.js`).
- **Frontend:** Vanilla HTML5/JS/CSS in `/public`. No build steps.
- **Data:** FAA `master.csv` (Streamed, not read, as the file is incredibly large).

## 3. Integration Logic: AeroDataBox API
- **Endpoint:** `GET https://aerodatabox.p.rapidapi.com/flights/number/{flightNumber}/{date}`
- **Parameter Formatting:** - `flightNumber`: Strip spaces (e.g., "DL 47" -> "DL47").
    - `date`: Ensure `YYYY-MM-DD` format.
- **Mapping Path:** - The API returns an **array** of flight objects. 
    - Target: `response[0].aircraft.registration`.
- **N-Number Normalization (CRITICAL):**
    - API returns: `N12345`.
    - FAA CSV contains: `12345` (no 'N' prefix).
    - Search the FAA file and return year.

## 4. Data Schema: Local FAA `master.csv`
- **Path:** `./data/master.csv`
- **Columns (0-indexed):**
    - `[0]`: N-Number (e.g., "12345")
    - `[4]`: Year Mfr (e.g., "2015")
    - `[20]`: Manufacturer (e.g., "BOEING")
    - `[21]`: Model (e.g., "737-800")

## 5. Implementation Rules
1. **Zero-RAM Lookup:** Use `readline` to stop reading the CSV the moment a match is found.
2. **Error States:** - If flight isn't found: "Flight details currently unavailable."
    - If tail number isn't in FAA local cache: "Aircraft specs not in local registry."
3. **UI:** Results must be "Glanceable." Big numbers, high contrast.

## 6. Data Automation: FAA Weekly Refresh
- **Source URL:** `https://registry.faa.gov/database/ReleasableAircraft.zip`
- **Process (scripts/refresh-faa.js):**
    1. Download ZIP to `/data/temp.zip`.
    2. Extract `MASTER.txt` from the ZIP.
    3. Perform an "Atomic Swap":
        - Rename current `master.csv` to `master.old`.
        - Rename extracted `MASTER.txt` to `master.csv`.
        - Delete `master.old` and `temp.zip` upon success.
- **Dependencies:** Use `adm-zip` for extraction and native `https` for downloads to stay minimalist.
- **Execution:** Triggered via `npm run refresh` (mapped to `node scripts/refresh-faa.js`).