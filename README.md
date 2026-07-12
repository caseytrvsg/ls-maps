# Waypoint

Turn-by-turn navigation web app with a GTA-inspired look — dark Los Santos-style map,
purple waypoint blip, purple GPS route line, voice directions.

Works like Waze/Google Maps: search or tap the map to set a waypoint, press START ROUTE,
and follow the purple line with spoken turn-by-turn directions.

## Run it

Any static file server works. Easiest:

```
python -m http.server 8137
```

then open http://localhost:8137. On a phone, GPS and the camera-follow view need HTTPS
(same as ASCEND — GitHub Pages works).

## How it works (all free services)

| Piece | Service |
|---|---|
| Map drawing | MapLibre GL (vendored in `vendor/`) |
| Map data/tiles | OpenFreeMap (OpenStreetMap data), no API key |
| Routing / turns | OSRM demo server, no API key |
| Address search | Nominatim (OpenStreetMap), no API key |
| Voice | Browser speech synthesis |

The GTA look is our own map theme (`js/gta-style.js`) — dark charcoal land, near-white
roads, steel-teal water, purple route. No Rockstar assets are used or copied.

## Features

- Tap the map (or search) → purple waypoint blip + route preview
- START ROUTE — GPS follow camera (tilted, rotates with your heading), voice turns,
  off-route recalculation, ETA / distance-left / speed bar
- DEMO DRIVE — simulated drive along the route (works without GPS, great on desktop)
- Voice toggle, north-up button, recenter button
- Installable as a home-screen app (PWA manifest)

## Phone-first, Waze-style desktop

The phone is the real experience (GPS, voice, install to home screen). Desktop
browsers get the full map as a companion — mouse navigation, demo drives — plus a
Waze-style bottom bar with a **SEND TO YOUR PHONE** button that pops a QR code;
scan it, then install via Share → Add to Home Screen (iPhone) or the install
prompt (Android). `?forceframes=1` unfreezes the map engine in embedded browsers
that suspend animation frames.

## Known limits (v1)

- No live traffic — that data isn't free; routes are fastest-by-road-network (OSRM)
- OSRM demo server is community-run; if routing errors appear, try again in a minute
- Service worker is network-first (avoids ASCEND's stale-cache trap); the app shell
  works offline but tiles/routing/search need a connection

## Credits

Map data © OpenStreetMap contributors. Tiles by OpenFreeMap. Routing by Project OSRM.
Geocoding by Nominatim. This is a personal project; "GTA" is a trademark of Take-Two
Interactive — this app is a fan-styled homage and uses no Rockstar assets.
