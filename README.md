# ABF Field Shift

**See your field from space.** Field Shift is a farm-planning web app for Tajikistan and Central Asia,
built for the NASA Space Apps Challenge 2026. A farmer draws a field on a 3D terrain map and gets
drought, heat, fire and crop disease warnings, 20 years of climate charts, and a crop plan with water facts.

**Live demo:** https://abf-field-shift.onrender.com

> Advisory tool. Not an official NASA product.
> Risk levels and crop advice come from simple, open rules. Confirm with a local agronomist.

## What it does

- **3D field map**: terrain with shaded slopes, height colours, rivers, canals, lakes and 3D trees.
  Draw a field by clicking its corners; area, height, slope and slope direction are measured.
- **Land check**: OpenStreetMap shows whether the field covers water, a village, a road or other land
  that cannot be farmed. Small overlaps can be trimmed automatically.
- **Risk warnings**: DROUGHT, HEAT, FIRE and DISEASE, each LOW / MEDIUM / HIGH, with the numbers behind
  them and plain advice.
- **Climate charts**: rainfall, temperature and soil moisture for the last 20 years, with the trend and
  this year compared to normal, plus the current weather.
- **Crop advisor**: 11 crops scored for the field; the best 3 with planting windows, water needed,
  irrigation needed and the nearest river, canal or lake; a 3-year rotation that keeps the soil fertile.
- **Languages**: English, Russian and Tajik.
- **Your data**: fields are saved in the browser, or in a private account (username and password only).
  Export and import as GeoJSON.

## NASA data

| Source | What Field Shift uses it for |
| --- | --- |
| **NASA POWER** (monthly) | 20 years of rainfall, temperature, maximum temperature and root-zone soil moisture at the field: charts, trends, drought and heat risk, crop scoring and planting windows. |
| **NASA POWER** (daily) | Temperature, humidity and rain for the last 30 days: crop disease risk. |
| **NASA FIRMS** | Fires detected by the MODIS and VIIRS satellite sensors in the last 10 days around the field: fire risk and fire points on the map. |

Other sources: Weatherstack (current weather), IPstack (approximate starting location),
OpenStreetMap / OpenFreeMap (land types, water, roads), Open-Meteo (place search) and Terrarium
elevation tiles (3D terrain). All API calls go through the server; keys never reach the browser.
Saved copies of NASA POWER answers in `data/power-cache/` keep the demo working when the API is down.

## Run it locally

Requirements: [Node.js](https://nodejs.org) 24.7 or newer.

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your own keys (free keys from ipstack.com, weatherstack.com
and the NASA FIRMS MAP_KEY page):

```bash
cp .env.example .env
```

On Windows PowerShell: `Copy-Item .env.example .env`

```bash
npm start
```

Open http://localhost:3000 for the landing page and http://localhost:3000/map/ for the app.

Other scripts: `npm run check-locales` (checks the EN/RU/TJ texts), `npm run build-trees` (rebuilds the
3D tree data from OpenStreetMap).

## Deploy

`render.yaml` describes a free Render web service (`npm install`, `npm start`, health check `/health`).
Add `IPSTACK_KEY`, `WEATHERSTACK_KEY` and `FIRMS_MAP_KEY` in the Render dashboard. The server rate-limits
`/api/*` per visitor and caps daily Weatherstack and IPstack calls so the free API quotas last.
On the free plan the disk is temporary: accounts saved on the server are lost when it restarts.

## Project layout

- `server.js`, `lib/`: Express server, API proxies, caches, accounts, rate limits
- `public/index.html`, `public/landing/`: landing page
- `public/map/`: the 3D app (MapLibre GL, Terra Draw, Turf, Chart.js)
- `config/`: risk, crop and disease rules (JSON)
- `locales/`: English, Russian and Tajik texts

## Team ABF

- **Astanov Bunyod**: designer and coder
- **Faruch**: speaker
- **Claude** (AI assistant by Anthropic): helped write the code

Built for the NASA Space Apps Challenge 2026. Advisory tool. Not an official NASA product.
