// Fetches the UK CMA fuel-price feeds (retailers are legally required to publish
// these) server-side — no CORS in a GitHub Action — and merges them into
// data/fuel_prices.json for the app to read same-origin.
//
// Schema out: { updated: ISO, count, stations: [{ brand, lat, lng, postcode, e10, e5, b7 }] }
// Prices are pence/litre (e.g. 139.9). e10 = standard unleaded.

import { writeFile, mkdir } from "node:fs/promises";

const FEEDS = [
  ["Applegreen",  "https://applegreenstores.com/fuel-prices/data.json"],
  ["Asda",        "https://storelocator.asda.com/fuel_prices_data.json"],
  ["BP",          "https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json"],
  ["Ascona",      "https://fuelprices.asconagroup.co.uk/newfuel.json"],
  ["Esso/Tesco",  "https://www.tesco.com/fuel_prices/fuel_prices_data.json"],
  ["JET",         "https://jetlocal.co.uk/fuel_prices_data.json"],
  ["Morrisons",   "https://www.morrisons.com/fuel-prices/fuel.json"],
  ["Moto",        "https://moto-way.com/fuel-price/fuel_prices.json"],
  ["MFG",         "https://fuel.motorfuelgroup.com/fuel_prices_data.json"],
  ["Rontec",      "https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json"],
  ["Sainsbury's", "https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json"],
  ["Shell",       "https://www.shell.co.uk/fuel-prices-data.html"],
  ["Tesco",       "https://www.tesco.com/fuel_prices/fuel_prices_data.json"],
  ["SGN",         "https://www.sgnretail.uk/files/data/SGN_daily_fuel_prices.json"],
  ["Co-op",       "https://www.midcounties.coop/fuel/fuel_prices_data.json"],
];

// full-precision float (coordinates)
const coord = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
// price in pence, rounded to 1 dp
const price = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
};

async function fetchFeed([brand, url]) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Waypoint/1.0 (+https://caseytrvsg.github.io/ls-maps)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const stations = data.stations || [];
    const out = [];
    for (const s of stations) {
      const loc = s.location || {};
      const lat = coord(loc.latitude), lng = coord(loc.longitude);
      const p = s.prices || {};
      if (lat == null || lng == null) continue;
      out.push({
        brand: s.brand || brand,
        lat, lng,
        postcode: s.postcode || "",
        e10: price(p.E10), e5: price(p.E5), b7: price(p.B7),
      });
    }
    console.log(`  ${brand}: ${out.length} stations`);
    return out;
  } catch (e) {
    console.log(`  ${brand}: FAILED (${e.message})`);
    return [];
  }
}

const results = await Promise.all(FEEDS.map(fetchFeed));
const stations = results.flat();

await mkdir("data", { recursive: true });
await writeFile("data/fuel_prices.json", JSON.stringify({
  updated: new Date().toISOString(),
  count: stations.length,
  stations,
}));

console.log(`Wrote ${stations.length} stations to data/fuel_prices.json`);
if (stations.length === 0) process.exit(1); // fail the run so we notice dead feeds
