# ABF Field Shift

Farm-planning tool for Tajikistan / Central Asia (NASA Space Apps Challenge 2026). A farmer draws a field
on a 3D terrain map and gets drought, heat and fire risk plus crop advice. Default location: Dushanbe
(38.56, 68.77), never Los Angeles.

## Rules

When a task is finished, reply with only the word "Done". Do not explain what you did. Exceptions: if
something failed, is blocked, or needs my decision, say so in one short line.

## Run

- `npm start` → http://localhost:3000/map/ (3D app). `/` is the older 2D climate dashboard.
- `npm run build-trees` → rebuilds `public/data/trees.bin` from OpenStreetMap (stops itself after
  100 s; run again to continue, results are cached in `data/trees-cache/`).
- Keys live only in `.env` (IPSTACK_KEY, WEATHERSTACK_KEY, FIRMS_MAP_KEY). The backend proxies every
  external API; never send keys to the browser and never print them.
- Every command and network request needs a timeout (max 2 minutes).

## Layout

- `server.js`: Express backend. Endpoints: `/api/location` (IPstack), `/api/geocode`, `/api/weather`
  (Weatherstack), `/api/firms` (NASA FIRMS), `/api/power` (NASA POWER), `/api/power-daily` (last 30 days,
  1 h cache, disk copy in `data/power-cache/daily/`), `/api/disease-rules`, `/api/landcheck` and
  `/api/landzones` (Overpass), `/api/risk-rules`, `/api/crop-rules`, `/tiles/terrarium/...` (DEM proxy
  with disk cache in `data/tile-cache/`). Cache: 10 min in memory; errors are never cached.
- `lib/accounts.js`: private accounts (username + password, argon2id, one-time recovery code), httpOnly
  session cookie, CSRF header, login rate limit. SQLite `data/accounts.db` (git-ignored). Routes:
  `/api/auth/*`, `/api/fields` and `/api/settings` (always filtered by user; others' items give 404).
  Signed out, fields stay in localStorage and move into the account at sign in (`public/map/account.js`).
- `lib/overpass.js`: OpenStreetMap queries (mirrors, timeouts, 1 h cache).
- `config/risk-rules.json`: scoring for the DROUGHT / HEAT / FIRE badges.
- `config/crops.json`: crop advisor rules (11 crops).
- `config/disease-rules.json`: 2 diseases per crop, approximate thresholds (confirm with an agronomist).
- `locales/{en,ru,tg}.json`: all UI text; `npm run check-locales` checks keys and hard-coded text.
- `public/map/`: `map.js` (map, drawing, fields, storage), `dem.js` (elevation/slope/aspect),
  `landcheck.js` (no-draw land), `dialog.js` (in-app confirm), `styles.js` (pins, risk styles),
  `trees.js` (GPU-instanced 3D trees), `plants.js` (3D crop rows), `climate.js` (Stage 2: timeline,
  weather card, fire layer, risk badges), `advisor.js` (Stage 3: crop advisor), `disease.js` (crop disease risk), `i18n.js` (EN/RU/TJ).

## Status

- Stage 1 done: 3D map, field drawing/editing, land check, delete fix, logo.
- 3D map upgrade: hillshades, slope shading, height tint, colour slider, 4 tree types from a static file.
- Stage 2 done: NASA POWER charts with trends, Weatherstack card, FIRMS hot spots, risk badges.
- Stage 3 written (crop advisor); needs a full test.
- Stage 4 (rendering without satellite imagery) started: imagery is OFF by default and the height tint
  is the ground colour. Not done yet: land-cover colours (ESA WorldCover from the AWS COG; the
  Terrascope tile service is unreachable from here), water and roads (OpenFreeMap vector tiles), trees
  from land cover, overlay polish, "Demo: Varzob gorge" button.

## Data reliability (demo safety)

- NASA POWER: 30 s timeout, one retry, then one step back a year if the current year isn't published.
  Every successful answer is saved in `data/power-cache/` (committed); if the live call fails, the
  nearest saved point within 0.25° is served and the timeline shows "Offline copy from <date>".
  Saved now: Dushanbe, Varzob, Vahdat. Add a place by calling `/api/power?lat=&lon=` once while online.
- The page retries POWER and weather once after 3 s and shows a "Try again" button if both fail.
- FIRMS allows at most 5 days per request; 10 days are fetched as two windows. Suomi-NPP stopped
  publishing on 2026-11-02, so VIIRS points come from NOAA-20 and NOAA-21.
- Weatherstack free plan: 100 requests per month (check the `x-ratelimit-remaining-month` header).
- Overpass is often unreachable from Tajikistan; `overpass.openstreetmap.fr` works best.
- Browser testing: the map only renders when the Browser pane is visible and the tab is in front.
  A hidden pane gives black ground and wrong click positions; that is not an app bug.
