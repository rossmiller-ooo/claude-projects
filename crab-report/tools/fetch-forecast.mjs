// Fetches the forecast for every built-in spot and writes data/forecast.json.
// Run hourly by .github/workflows/crab-forecast.yml, but it only fetches when the current half-day's
// forecast (morning or afternoon) hasn't been saved yet. The weather service sometimes refuses GitHub's
// shared addresses, so a refused run exits quietly and the next hour's run tries again. Usage: node crab-report/tools/fetch-forecast.mjs
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const html = fs.readFileSync(new URL("index.html", root), "utf8");
const block = html.slice(html.indexOf("//SITES-BEGIN"), html.indexOf("//SITES-END"));
const ctx = {};
vm.runInNewContext(block + ";this.out={SITES,STATIONS,FALLBACK_STATION};", ctx);
const { SITES, STATIONS, FALLBACK_STATION } = ctx.out;

// Skip if this half-day's forecast is already saved for the current spot list.
const outFile = new URL("data/forecast.json", root);
let existing = null;
try { existing = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch {}
const nowMs = Date.now(), day = Math.floor(nowMs / 864e5) * 864e5;
const slot = [day + 22 * 36e5, day + 12 * 36e5, day - 2 * 36e5].find((t) => t <= nowMs); // 12:00 and 22:00 UTC
const sameSpots = existing && JSON.stringify(existing.sites) === JSON.stringify(SITES.map((s) => s.id));
if (!process.env.FORCE && sameSpots && Date.parse(existing.generated) >= slot) {
  console.log("Forecast for this half-day is already saved (" + existing.generated + "). Nothing to do.");
  process.exit(0);
}
const ageH = existing ? (nowMs - Date.parse(existing.generated)) / 36e5 : Infinity;
process.on("uncaughtException", (e) => {
  // a refused fetch is routine; only fail (and alert) once the saved forecast is more than a day old
  console.warn("Fetch failed: " + e.message);
  if (ageH < 26) { console.log("Keeping the saved forecast (" + ageH.toFixed(1) + " h old). Will retry next hour."); process.exit(0); }
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, label) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "crab-report-daily" } });
      if (!r.ok) throw new Error(label + ": HTTP " + r.status + " " + (await r.text()).slice(0, 200));
      return await r.json();
    } catch (e) {
      last = e;
      console.warn("retry", label, e.message);
      await sleep(5000 * (i + 1));
    }
  }
  throw last;
}

const tz = "&timezone=America%2FLos_Angeles";
const lat = SITES.map((s) => s.lat).join(","), lon = SITES.map((s) => s.lon).join(",");
const slat = SITES.map((s) => (s.sea || s).lat).join(","), slon = SITES.map((s) => (s.sea || s).lon).join(",");
const wxU = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
  "&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,precipitation_probability,weather_code,cloud_cover" +
  "&daily=sunrise,sunset&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&forecast_days=12&past_days=3" + tz;
const seaU = "https://marine-api.open-meteo.com/v1/marine?latitude=" + slat + "&longitude=" + slon +
  "&hourly=wave_height,wave_period,wave_direction,sea_surface_temperature&length_unit=imperial&forecast_days=11&past_days=1" + tz;

// Tide predictions start yesterday (Pacific) and run 15 days, so the file stays useful even if a day's run is missed.
const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
  .formatToParts(new Date(Date.now() - 864e5)).map((x) => [x.type, x.value]));
const begin = p.year + p.month + p.day;

const strip = (o) => ({ hourly: o.hourly, hourly_units: o.hourly_units, ...(o.daily ? { daily: o.daily } : {}) });
const arr = (x) => (Array.isArray(x) ? x : [x]);

const wx = arr(await getJSON(wxU, "weather")).map(strip);
const sea = arr(await getJSON(seaU, "marine")).map(strip);
if (wx.length !== SITES.length || sea.length !== SITES.length) throw new Error("location count mismatch");

const tides = {};
for (const st of [...new Set(STATIONS.map((s) => s.id).concat(FALLBACK_STATION))]) {
  const u = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=robs_crab_report&begin_date=" + begin +
    "&range=360&datum=MLLW&station=" + st + "&time_zone=lst_ldt&units=english&interval=hilo&format=json";
  const j = await getJSON(u, "tides " + st);
  if (!j.predictions) throw new Error("no tide predictions for " + st);
  tides[st] = j.predictions.map((x) => [x.t, +(+x.v).toFixed(2), x.type]);
}

const out = { v: 1, generated: new Date().toISOString(), sites: SITES.map((s) => s.id), wx, sea, tides };
const json = JSON.stringify(out, (k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v));
fs.mkdirSync(new URL("data/", root), { recursive: true });
fs.writeFileSync(outFile, json);
console.log("wrote data/forecast.json", (json.length / 1024).toFixed(0) + " KB", SITES.length, "spots", Object.keys(tides).length, "tide stations");
