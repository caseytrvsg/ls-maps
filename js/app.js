// LS Maps — Waze-style navigation with a GTA-inspired look.
// Free services: OpenFreeMap (map tiles), OSRM demo server (routing), Nominatim (search).

(function () {
  "use strict";

  var OSRM_URL = "https://router.project-osrm.org/route/v1/driving/";
  var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  var DEFAULT_CENTER = [-118.2437, 34.0522]; // Los Angeles — the real Los Santos
  var OFF_ROUTE_METERS = 60;
  var OFF_ROUTE_SECONDS = 6;
  var ARRIVE_METERS = 28;
  var DEMO_SPEED_MPS = 17; // ~38 mph
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  // Shared reports backend (Supabase — publishable key, RLS does the protecting)
  var SUPA_URL = "https://powdosapvcvlrhpcggqz.supabase.co";
  var SUPA_KEY = "sb_publishable_4QnCoMp5Q86_hYCCGvGU3w_TwRVmNVF";
  var ALERT_RADIUS_M = 500;          // warn within this distance
  var ALERT_REWARN_MS = 10 * 60 * 1000; // don't re-warn same spot for 10 min
  var POLICE_TTL_MS = 4 * 60 * 60 * 1000; // police reports expire after 4 h

  var map, playerMarker, waypointMarker;
  var playerPos = null;        // [lng, lat]
  var playerHeading = 0;       // degrees
  var playerSpeedMps = 0;
  var lastGpsPos = null;
  var hasGpsFix = false;
  var following = true;

  var route = null;            // { coords, cum, totalDist, totalDur, steps }
  var waypointLngLat = null;
  var customOrigin = null;     // [lng, lat] when start ≠ your location
  var originMarker = null;
  var navActive = false;
  var demoActive = false;
  var demoTraveled = 0;
  var demoLastTs = null;
  var demoRaf = null;
  var progressIdx = 0;         // last matched segment index
  var offRouteSince = null;
  var rerouting = false;
  var announcedForStep = {};   // stepIdx -> highest announcement tier done (1=far, 2=near, 3=now)
  var voiceOn = true;
  var wakeLock = null;
  var arrived = false;

  var cameras = [], cameraFetchCenter = null, cameraBackoffUntil = 0;
  var police = [], policeFetchAt = 0;
  var warnedAt = {};        // alert id -> last warn timestamp
  var audioCtx = null;
  var alertHideTimer = null;
  var alertsReady = false;

  var $ = function (id) { return document.getElementById(id); };

  // ---------------- Geometry helpers ----------------
  var R = 6371000;
  function toRad(d) { return d * Math.PI / 180; }

  function haversine(a, b) {
    var dLat = toRad(b[1] - a[1]);
    var dLng = toRad(b[0] - a[0]);
    var la1 = toRad(a[1]), la2 = toRad(b[1]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearingDeg(a, b) {
    var la1 = toRad(a[1]), la2 = toRad(b[1]);
    var dLng = toRad(b[0] - a[0]);
    var y = Math.sin(dLng) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Project p onto segment a-b (flat approximation, fine at street scale).
  // Returns { t, dist, point }
  function projectToSegment(p, a, b) {
    var cosLat = Math.cos(toRad(p[1]));
    var ax = a[0] * cosLat, ay = a[1];
    var bx = b[0] * cosLat, by = b[1];
    var px = p[0] * cosLat, py = p[1];
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    var qx = ax + t * dx, qy = ay + t * dy;
    var point = [qx / cosLat, qy];
    return { t: t, dist: haversine(p, point), point: point };
  }

  function fmtDist(m) {
    var ft = m * 3.28084;
    if (ft < 900) return Math.round(ft / 10) * 10 + " FT";
    var mi = m / 1609.34;
    return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + " MI";
  }

  function fmtDistSpoken(m) {
    var ft = m * 3.28084;
    if (ft < 900) return Math.round(ft / 50) * 50 + " feet";
    var mi = m / 1609.34;
    if (mi < 0.6) return "a quarter mile";
    if (mi < 0.85) return "half a mile";
    if (mi < 1.5) return "one mile";
    return Math.round(mi) + " miles";
  }

  function fmtDuration(s) {
    var min = Math.round(s / 60);
    if (min < 60) return min + " MIN";
    return Math.floor(min / 60) + " HR " + (min % 60) + " MIN";
  }

  function fmtEta(sRemaining) {
    var d = new Date(Date.now() + sRemaining * 1000);
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
  }

  // ---------------- UI helpers ----------------
  var toastTimer = null;
  function toast(msg, info) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.toggle("info", !!info);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 3500);
  }

  function speak(text) {
    if (!voiceOn || !window.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* voice is best-effort */ }
  }

  // ---------------- Markers ----------------
  function makePlayerMarker() {
    var el = document.createElement("div");
    el.className = "player-marker";
    el.innerHTML =
      '<svg viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">' +
      '<polygon points="17,3 28,29 17,22.5 6,29" fill="#FFFFFF" stroke="#17191C" stroke-width="2.4" stroke-linejoin="round"/>' +
      "</svg>";
    return new maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" });
  }

  function makeWaypointMarker() {
    // GTA V-style waypoint blip, per operator's traced outline: a tall pill +
    // a wide pill crossed, with a large circle in the middle. Stroked pass
    // first, fill-only pass on top → one seamless outlined silhouette.
    var shapes =
      '<rect x="15.5" y="3" width="13" height="38" rx="6.5"/>' +
      '<rect x="3" y="15.5" width="38" height="13" rx="6.5"/>' +
      '<circle cx="22" cy="22" r="8.5"/>';
    var el = document.createElement("div");
    el.className = "waypoint-marker";
    el.innerHTML =
      '<div class="waypoint-pulse"></div>' +
      '<svg class="waypoint-blip" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">' +
      '<g fill="#8F3FE0" stroke="#17191C" stroke-width="3">' + shapes + "</g>" +
      '<g fill="#8F3FE0">' + shapes + "</g>" +
      '<circle cx="22" cy="22" r="3.4" fill="#2A1740"/>' +
      "</svg>";
    return new maplibregl.Marker({ element: el, anchor: "center" });
  }

  // ---------------- Route layers ----------------
  function addRouteLayers() {
    map.addSource("route", { type: "geojson", data: emptyLine() });
    map.addLayer({
      id: "route-glow",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#A868E8",
        "line-opacity": 0.25,
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 8, 16, 20, 19, 34]
      }
    });
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#5A2B94",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 5, 16, 11, 19, 20]
      }
    });
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#A868E8",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 3, 16, 7, 19, 13]
      }
    });
  }

  // Highway shields: a stretchable rounded-rect badge (dark outline, white
  // ring, colored fill) that icon-text-fit wraps around each road number.
  function makeShieldImage(fill) {
    var s = 2; // rendered at 2x for crisp edges
    var w = 24 * s, h = 18 * s, r = 5 * s, b = 1.5 * s;
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    function rr(x, y, ww, hh, rad) {
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + ww, y, x + ww, y + hh, rad);
      ctx.arcTo(x + ww, y + hh, x, y + hh, rad);
      ctx.arcTo(x, y + hh, x, y, rad);
      ctx.arcTo(x, y, x + ww, y, rad);
      ctx.closePath();
    }
    rr(0, 0, w, h, r); ctx.fillStyle = "#17191C"; ctx.fill();
    rr(b, b, w - 2 * b, h - 2 * b, r - b); ctx.fillStyle = "#F5F7F8"; ctx.fill();
    rr(2 * b, 2 * b, w - 4 * b, h - 4 * b, r - 2 * b); ctx.fillStyle = fill; ctx.fill();
    return { img: ctx.getImageData(0, 0, w, h), meta: {
      pixelRatio: s,
      content: [12, 10, 36, 26],
      stretchX: [[16, 32]],
      stretchY: [[14, 22]]
    } };
  }

  function addRoadShields() {
    var motorway = makeShieldImage("#3A66A8"); // blue — motorways
    var aroad = makeShieldImage("#37714E");    // green — trunk/primary
    map.addImage("shield-motorway", motorway.img, motorway.meta);
    map.addImage("shield-aroad", aroad.img, aroad.meta);
    map.addLayer({
      id: "road-shield",
      type: "symbol",
      source: "omt",
      "source-layer": "transportation_name",
      minzoom: 8,
      filter: ["all",
        ["has", "ref"],
        ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]]
      ],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 400,
        "text-field": ["get", "ref"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 10.5,
        "icon-image": ["match", ["get", "class"], "motorway", "shield-motorway", "shield-aroad"],
        "icon-text-fit": "both",
        "icon-text-fit-padding": [3, 7, 3, 7],
        "icon-rotation-alignment": "viewport",
        "text-rotation-alignment": "viewport"
      },
      paint: { "text-color": "#FFFFFF" }
    });
  }

  // ---------------- Speed cameras + police alerts ----------------
  function makeBlipIcon(bg, glyph) {
    var s = 2, r = 30 * s / 2; // 30px blip at 2x
    var c = document.createElement("canvas");
    c.width = 30 * s; c.height = 30 * s;
    var ctx = c.getContext("2d");
    ctx.beginPath(); ctx.arc(r, r, 14 * s / 1, 0, Math.PI * 2); ctx.fillStyle = "#17191C"; ctx.fill();
    ctx.beginPath(); ctx.arc(r, r, 12.5 * s, 0, Math.PI * 2); ctx.fillStyle = "#F5F7F8"; ctx.fill();
    ctx.beginPath(); ctx.arc(r, r, 11 * s, 0, Math.PI * 2); ctx.fillStyle = bg; ctx.fill();
    ctx.font = (14 * s) + "px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(glyph, r, r + s);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function pointsFC(list) {
    return { type: "FeatureCollection", features: list.map(function (it) {
      return { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: it.pos } };
    }) };
  }

  function addAlertLayers() {
    map.addImage("icon-camera", makeBlipIcon("#E8912D", "📷"), { pixelRatio: 2 });
    map.addImage("icon-police", makeBlipIcon("#3A66A8", "👮"), { pixelRatio: 2 });
    ["cameras", "police"].forEach(function (name) {
      map.addSource(name, { type: "geojson", data: pointsFC([]) });
      map.addLayer({
        id: name + "-layer",
        type: "symbol",
        source: name,
        minzoom: 9,
        layout: {
          "icon-image": name === "cameras" ? "icon-camera" : "icon-police",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.55, 16, 0.95],
          "icon-allow-overlap": true
        }
      });
    });
    alertsReady = true;
  }

  function fetchCameras(center) {
    var now = Date.now();
    if (now < cameraBackoffUntil) return;
    if (cameraFetchCenter && haversine(center, cameraFetchCenter) < 5000) return;
    cameraFetchCenter = center;
    var d = 0.15;
    var bbox = (center[1] - d) + "," + (center[0] - d) + "," + (center[1] + d) + "," + (center[0] + d);
    var q = '[out:json][timeout:12];node["highway"="speed_camera"](' + bbox + ");out;";
    fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        cameras = (data.elements || []).map(function (el) {
          return { id: "cam" + el.id, pos: [el.lon, el.lat] };
        });
        if (map.getSource("cameras")) map.getSource("cameras").setData(pointsFC(cameras));
      })
      .catch(function () {
        cameraFetchCenter = null;
        cameraBackoffUntil = Date.now() + 60000;
      });
  }

  function fetchPolice(center) {
    if (Date.now() - policeFetchAt < 60000) return;
    policeFetchAt = Date.now();
    var since = new Date(Date.now() - POLICE_TTL_MS).toISOString();
    var d = 0.3;
    var url = SUPA_URL + "/rest/v1/ls_reports?select=id,lng,lat&kind=eq.police" +
      "&created_at=gte." + since +
      "&lat=gte." + (center[1] - d) + "&lat=lte." + (center[1] + d) +
      "&lng=gte." + (center[0] - d) + "&lng=lte." + (center[0] + d) + "&limit=200";
    fetch(url, { headers: { apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (rows) {
        police = rows.map(function (r) { return { id: "pol" + r.id, pos: [r.lng, r.lat] }; });
        if (map.getSource("police")) map.getSource("police").setData(pointsFC(police));
      })
      .catch(function () { /* reports backend offline — pins just don't update */ });
  }

  function submitPoliceReport() {
    if (!hasGpsFix || !playerPos) {
      toast("NEED A GPS FIX TO REPORT", true);
      return;
    }
    fetch(SUPA_URL + "/rest/v1/ls_reports", {
      method: "POST",
      headers: {
        apikey: SUPA_KEY,
        Authorization: "Bearer " + SUPA_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ kind: "police", lng: playerPos[0], lat: playerPos[1] })
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        toast("POLICE REPORTED — DRIVERS NEARBY WILL SEE IT", true);
        police.push({ id: "local" + Date.now(), pos: playerPos.slice() });
        if (map.getSource("police")) map.getSource("police").setData(pointsFC(police));
      })
      .catch(function () { toast("REPORTS ARE OFFLINE RIGHT NOW"); });
  }

  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* no audio — beeps just won't play */ }
  }

  function beepAlert(kind) {
    try {
      unlockAudio();
      if (!audioCtx) return;
      var n = kind === "camera" ? 2 : 1;
      var freq = kind === "camera" ? 880 : 620;
      for (var i = 0; i < n; i++) {
        var t = audioCtx.currentTime + i * 0.22;
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t); o.stop(t + 0.2);
      }
    } catch (e) { /* beep is best-effort */ }
  }

  function showAlertBanner(kind, distM) {
    var el = $("alert-banner");
    el.classList.remove("hidden", "alert-camera", "alert-police");
    el.classList.add(kind === "camera" ? "alert-camera" : "alert-police");
    $("alert-icon").textContent = kind === "camera" ? "📷" : "👮";
    $("alert-title").textContent = kind === "camera" ? "SPEED CAMERA AHEAD" : "POLICE REPORTED AHEAD";
    $("alert-sub").textContent = fmtDist(distM);
    clearTimeout(alertHideTimer);
    alertHideTimer = setTimeout(function () { el.classList.add("hidden"); }, 8000);
  }

  function angleDiff(a, b) {
    return Math.abs((((a - b) % 360) + 540) % 360 - 180);
  }

  function checkAlerts(pos, heading) {
    if (!alertsReady) return;
    fetchCameras(pos);
    fetchPolice(pos);
    var now = Date.now();
    var lists = [{ items: cameras, kind: "camera" }, { items: police, kind: "police" }];
    for (var l = 0; l < lists.length; l++) {
      var items = lists[l].items, kind = lists[l].kind;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var dM = haversine(pos, it.pos);
        if (dM > ALERT_RADIUS_M) continue;
        // only warn for things roughly ahead (unless right on top of them)
        if (typeof heading === "number" && dM > 120 && angleDiff(bearingDeg(pos, it.pos), heading) > 85) continue;
        if (warnedAt[it.id] && now - warnedAt[it.id] < ALERT_REWARN_MS) continue;
        warnedAt[it.id] = now;
        beepAlert(kind);
        speak(kind === "camera" ? "Speed camera ahead." : "Police reported ahead.");
        showAlertBanner(kind, dM);
        return; // one alert at a time
      }
    }
  }

  function emptyLine() {
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };
  }

  function setRouteGeometry(coords) {
    map.getSource("route").setData({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: coords }
    });
  }

  // ---------------- Routing ----------------
  function fetchRoute(from, to, cb) {
    var url = OSRM_URL + from[0] + "," + from[1] + ";" + to[0] + "," + to[1] +
      "?overview=full&geometries=geojson&steps=true";
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.routes || !data.routes.length) throw new Error("no route");
        var r0 = data.routes[0];
        var coords = r0.geometry.coordinates;
        var cum = [0];
        for (var i = 1; i < coords.length; i++) {
          cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
        }
        var steps = [];
        var legs = r0.legs || [];
        legs.forEach(function (leg) {
          (leg.steps || []).forEach(function (s) { steps.push(s); });
        });
        // Distance-along-route for each maneuver point
        steps.forEach(function (s) {
          var loc = s.maneuver.location;
          var best = 0, bestD = Infinity;
          for (var i = 0; i < coords.length; i++) {
            var d = haversine(loc, coords[i]);
            if (d < bestD) { bestD = d; best = i; }
          }
          s._distAlong = cum[best];
        });
        cb(null, {
          coords: coords, cum: cum,
          totalDist: r0.distance, totalDur: r0.duration,
          steps: steps
        });
      })
      .catch(function (err) { cb(err); });
  }

  function arrowFor(step) {
    var t = step.maneuver.type, m = step.maneuver.modifier || "";
    if (t === "arrive") return "◉";                     // ◉
    if (t === "roundabout" || t === "rotary") return "⟳"; // ⟳
    if (m.indexOf("uturn") >= 0) return "↩";            // ↩
    if (m === "left") return "←";
    if (m === "right") return "→";
    if (m === "slight left") return "↖";
    if (m === "slight right") return "↗";
    if (m === "sharp left") return "↰";
    if (m === "sharp right") return "↱";
    return "↑";
  }

  function instructionFor(step, spoken) {
    var t = step.maneuver.type, m = step.maneuver.modifier || "";
    var name = step.name || "";
    var onto = name ? (spoken ? " onto " + name : name) : (spoken ? "" : "");
    if (t === "depart") return spoken ? ("Head out" + (name ? " on " + name : "")) : (name || "HEAD OUT");
    if (t === "arrive") return spoken ? "You have arrived at your destination" : "DESTINATION";
    if (t === "roundabout" || t === "rotary") {
      var exit = step.maneuver.exit || 1;
      return spoken ? ("At the roundabout, take exit " + exit + (name ? " onto " + name : "")) : (name || "ROUNDABOUT");
    }
    if (m.indexOf("uturn") >= 0) return spoken ? "Make a U-turn" : (name || "U-TURN");
    if (t === "merge") return spoken ? ("Merge " + (m || "") + onto) : (name || "MERGE");
    if (t === "on ramp") return spoken ? ("Take the ramp" + onto) : (name || "RAMP");
    if (t === "off ramp") return spoken ? ("Take the exit" + onto) : (name || "EXIT");
    if (t === "fork") return spoken ? ("Keep " + (m || "straight") + onto) : (name || "FORK");
    if (m === "straight" || t === "continue" && !m) return spoken ? ("Continue straight" + onto) : (name || "CONTINUE");
    // default turn phrasing
    var dir = m || "straight";
    return spoken ? ("Turn " + dir + onto) : (name || dir.toUpperCase());
  }

  // ---------------- Waypoint / route setup ----------------
  function setWaypoint(lngLat, label) {
    if (navActive) return; // don't re-target mid-drive; END first
    waypointLngLat = [lngLat.lng !== undefined ? lngLat.lng : lngLat[0],
                      lngLat.lat !== undefined ? lngLat.lat : lngLat[1]];
    if (!waypointMarker) waypointMarker = makeWaypointMarker();
    waypointMarker.setLngLat(waypointLngLat).addTo(map);
    $("to-input").value = label || "DROPPED PIN";
    $("hint").classList.add("hidden");
    $("pc-bar").classList.add("hidden"); // promo bar yields to the route panel
    speak("Waypoint set.");
    requestRoute();
  }

  function resolveOrigin() {
    return customOrigin || playerPos || map.getCenter().toArray();
  }

  function setCustomOrigin(pos, label) {
    customOrigin = pos;
    $("from-input").value = pos ? (label || "PINNED START") : "";
    if (pos) {
      if (!originMarker) {
        var el = document.createElement("div");
        el.className = "origin-marker";
        originMarker = new maplibregl.Marker({ element: el });
      }
      originMarker.setLngLat(pos).addTo(map);
    } else if (originMarker) {
      originMarker.remove();
      originMarker = null;
    }
    if (waypointLngLat) requestRoute();
  }

  function swapEnds() {
    if (!waypointLngLat) { toast("SET A DESTINATION FIRST", true); return; }
    if (navActive) return;
    var newDest = resolveOrigin().slice();
    var newDestLabel = customOrigin ? ($("from-input").value || "PINNED START") : "MY LOCATION";
    var newOrigin = waypointLngLat.slice();
    var newOriginLabel = $("to-input").value || "DROPPED PIN";
    waypointLngLat = newDest;
    waypointMarker.setLngLat(newDest);
    $("to-input").value = newDestLabel;
    setCustomOrigin(newOrigin, newOriginLabel); // updates marker + refetches once
  }

  function requestRoute() {
    // mid-drive recalculations always start from where the car actually is
    var origin = (navActive && !demoActive && playerPos) ? playerPos : resolveOrigin();
    rerouting = true;
    fetchRoute(origin, waypointLngLat, function (err, r) {
      rerouting = false;
      if (err) {
        toast("ROUTE SERVICE UNAVAILABLE — TRY AGAIN IN A MOMENT");
        return;
      }
      route = r;
      progressIdx = 0;
      announcedForStep = {};
      setRouteGeometry(r.coords);
      $("route-time").textContent = fmtDuration(r.totalDur);
      $("route-dist").textContent = fmtDist(r.totalDist).toLowerCase().toUpperCase();
      if (!navActive) {
        $("route-panel").classList.remove("hidden");
        $("nav-bar").classList.add("hidden");
        // frame the whole route
        var b = new maplibregl.LngLatBounds();
        r.coords.forEach(function (c) { b.extend(c); });
        map.fitBounds(b, { padding: { top: 140, bottom: 160, left: 50, right: 50 }, pitch: 0, bearing: 0, duration: 700 });
      }
    });
  }

  function clearRoute() {
    route = null;
    waypointLngLat = null;
    if (waypointMarker) { waypointMarker.remove(); waypointMarker = null; }
    customOrigin = null;
    if (originMarker) { originMarker.remove(); originMarker = null; }
    $("from-input").value = "";
    $("to-input").value = "";
    $("dir-results").classList.add("hidden");
    setRouteGeometry([]);
    $("route-panel").classList.add("hidden");
  }

  // ---------------- From/To pickers (route panel) ----------------
  function dirSearch(q, isFrom) {
    var box = $("dir-results");
    box.innerHTML = "";
    if (isFrom) {
      var mine = document.createElement("div");
      mine.className = "search-item";
      mine.innerHTML = '<div class="primary">◉ YOUR LOCATION</div><div class="secondary">Follow GPS</div>';
      mine.addEventListener("click", function () {
        box.classList.add("hidden");
        setCustomOrigin(null);
      });
      box.appendChild(mine);
    }
    if (q.length >= 3) {
      var center = map.getCenter();
      var url = NOMINATIM_URL + "?format=jsonv2&limit=5&q=" + encodeURIComponent(q) +
        "&viewbox=" + (center.lng - 1) + "," + (center.lat + 1) + "," + (center.lng + 1) + "," + (center.lat - 1) + "&bounded=0";
      fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (items) {
          items.forEach(function (it) {
            var parts = (it.display_name || "").split(",");
            var div = document.createElement("div");
            div.className = "search-item";
            div.innerHTML = '<div class="primary">' + escapeHtml(parts[0] || "?") + "</div>" +
              '<div class="secondary">' + escapeHtml(parts.slice(1, 4).join(",").trim()) + "</div>";
            div.addEventListener("click", function () {
              box.classList.add("hidden");
              var lngLat = [parseFloat(it.lon), parseFloat(it.lat)];
              if (isFrom) {
                setCustomOrigin(lngLat, parts[0]);
              } else {
                map.easeTo({ center: lngLat, zoom: 14, duration: 700 });
                setWaypoint(lngLat, parts[0]);
              }
            });
            box.appendChild(div);
          });
          if (box.children.length) box.classList.remove("hidden");
        })
        .catch(function () {});
    }
    box.classList.toggle("hidden", !box.children.length);
  }

  function attachDirSearch(inputId, isFrom) {
    var input = $(inputId), timer = null;
    input.addEventListener("focus", function () {
      input.select();
      if (isFrom) dirSearch(input.value.trim(), true);
    });
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () { dirSearch(input.value.trim(), isFrom); }, 450);
    });
  }

  // ---------------- Navigation ----------------
  function startNav(demo) {
    if (!route) return;
    if (!demo && !hasGpsFix) {
      toast("NO GPS SIGNAL — RUNNING DEMO DRIVE", true);
      demo = true;
    }
    navActive = true;
    arrived = false;
    demoActive = !!demo;
    following = true;
    $("route-panel").classList.add("hidden");
    $("nav-bar").classList.remove("hidden");
    $("turn-banner").classList.remove("hidden");
    acquireWakeLock();
    speak("Route started.");
    fetchCameras(demoActive ? route.coords[0] : (playerPos || route.coords[0]));
    fetchPolice(demoActive ? route.coords[0] : (playerPos || route.coords[0]));
    if (demoActive) {
      // start from the beginning of the route
      demoTraveled = 0;
      demoLastTs = null;
      if (!playerMarker) { playerMarker = makePlayerMarker(); playerMarker.setLngLat(route.coords[0]).addTo(map); }
      demoRaf = requestAnimationFrame(demoTick);
    } else if (playerPos) {
      updateNavigation(playerPos, playerHeading, playerSpeedMps);
    }
  }

  function stopNav(silent) {
    navActive = false;
    demoActive = false;
    if (demoRaf) { cancelAnimationFrame(demoRaf); demoRaf = null; }
    $("nav-bar").classList.add("hidden");
    $("turn-banner").classList.add("hidden");
    releaseWakeLock();
    if (!silent) speak("Route ended.");
    if (route) {
      // back to overview state with the route still shown
      $("route-panel").classList.remove("hidden");
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    }
  }

  function demoTick(ts) {
    if (!demoActive || !route) return;
    if (demoLastTs === null) demoLastTs = ts;
    var dt = Math.min((ts - demoLastTs) / 1000, 0.2);
    demoLastTs = ts;
    demoTraveled += DEMO_SPEED_MPS * dt;
    var total = route.cum[route.cum.length - 1];
    if (demoTraveled >= total) demoTraveled = total;

    // interpolate position along the polyline
    var cum = route.cum, coords = route.coords;
    var i = progressIdx;
    while (i < cum.length - 2 && cum[i + 1] < demoTraveled) i++;
    progressIdx = i;
    var segLen = cum[i + 1] - cum[i];
    var t = segLen > 0 ? (demoTraveled - cum[i]) / segLen : 0;
    var pos = [
      coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
      coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t
    ];
    var heading = bearingDeg(coords[i], coords[i + 1]);
    updateNavigation(pos, heading, DEMO_SPEED_MPS, demoTraveled);
    checkAlerts(pos, heading);
    if (demoTraveled < total) demoRaf = requestAnimationFrame(demoTick);
  }

  // Core per-position update. traveledOverride is provided by demo mode.
  function updateNavigation(pos, heading, speedMps, traveledOverride) {
    if (!route || !navActive || arrived) return;

    if (playerMarker) {
      playerMarker.setLngLat(pos);
      playerMarker.setRotation(heading);
    }

    var traveled, offDist = 0;
    if (traveledOverride !== undefined) {
      traveled = traveledOverride;
    } else {
      // match GPS position to the route
      var best = { dist: Infinity, idx: 0, t: 0 };
      var from = Math.max(0, progressIdx - 3);
      var to = Math.min(route.coords.length - 2, progressIdx + 60);
      for (var i = from; i <= to; i++) {
        var pr = projectToSegment(pos, route.coords[i], route.coords[i + 1]);
        if (pr.dist < best.dist) best = { dist: pr.dist, idx: i, t: pr.t };
      }
      progressIdx = best.idx;
      offDist = best.dist;
      var segLen = route.cum[best.idx + 1] - route.cum[best.idx];
      traveled = route.cum[best.idx] + segLen * best.t;
    }

    var total = route.cum[route.cum.length - 1];
    var remaining = Math.max(0, total - traveled);

    // --- off-route detection (GPS mode only) ---
    if (traveledOverride === undefined) {
      if (offDist > OFF_ROUTE_METERS) {
        if (!offRouteSince) offRouteSince = Date.now();
        else if (Date.now() - offRouteSince > OFF_ROUTE_SECONDS * 1000 && !rerouting) {
          offRouteSince = null;
          toast("RECALCULATING…", true);
          speak("Recalculating.");
          requestRoute();
          return;
        }
      } else {
        offRouteSince = null;
      }
    }

    // --- find upcoming maneuver ---
    var upcoming = null, upcomingIdx = -1;
    for (var s = 0; s < route.steps.length; s++) {
      if (route.steps[s]._distAlong > traveled + 4) { upcoming = route.steps[s]; upcomingIdx = s; break; }
    }
    if (!upcoming) { upcoming = route.steps[route.steps.length - 1]; upcomingIdx = route.steps.length - 1; }
    var distToTurn = Math.max(0, upcoming._distAlong - traveled);

    $("turn-arrow").textContent = arrowFor(upcoming);
    $("turn-dist").textContent = fmtDist(distToTurn);
    $("turn-street").textContent = instructionFor(upcoming, false);

    // --- voice announcements: far (~0.5mi), near (~600ft), now (~100ft) ---
    var tier = announcedForStep[upcomingIdx] || 0;
    if (upcoming.maneuver.type !== "depart") {
      if (distToTurn < 40 && tier < 3) {
        announcedForStep[upcomingIdx] = 3;
        speak(instructionFor(upcoming, true));
      } else if (distToTurn < 210 && tier < 2) {
        announcedForStep[upcomingIdx] = 2;
        speak("In " + fmtDistSpoken(distToTurn) + ", " + instructionFor(upcoming, true).toLowerCase());
      } else if (distToTurn < 900 && distToTurn > 300 && tier < 1) {
        announcedForStep[upcomingIdx] = 1;
        speak("In " + fmtDistSpoken(distToTurn) + ", " + instructionFor(upcoming, true).toLowerCase());
      }
    }

    // --- bottom bar ---
    var remainingDur = route.totalDur * (remaining / Math.max(1, route.totalDist));
    $("nav-eta").textContent = fmtEta(remainingDur);
    $("nav-remaining").textContent = fmtDist(remaining);
    $("nav-speed").textContent = Math.round((speedMps || 0) * 2.23694);

    // --- camera follow ---
    if (following) {
      map.easeTo({
        center: pos,
        bearing: heading,
        pitch: 55,
        zoom: 16.5,
        duration: traveledOverride !== undefined ? 90 : 900,
        easing: function (x) { return x; }
      });
    }

    // --- arrival ---
    if (remaining < ARRIVE_METERS) {
      arrived = true;
      $("arrive").classList.remove("hidden");
      speak("You have arrived at your destination.");
      setTimeout(function () {
        $("arrive").classList.add("hidden");
        stopNav(true);
        clearRoute();
      }, 3800);
    }
  }

  // ---------------- GPS ----------------
  function startGps() {
    if (!navigator.geolocation) {
      toast("NO GPS ON THIS DEVICE — TAP MAP + DEMO DRIVE STILL WORK", true);
      return;
    }
    navigator.geolocation.watchPosition(function (p) {
      var pos = [p.coords.longitude, p.coords.latitude];
      var firstFix = !hasGpsFix;
      hasGpsFix = true;
      playerSpeedMps = p.coords.speed || 0;
      if (p.coords.heading !== null && !isNaN(p.coords.heading) && playerSpeedMps > 0.8) {
        playerHeading = p.coords.heading;
      } else if (lastGpsPos && haversine(lastGpsPos, pos) > 3) {
        playerHeading = bearingDeg(lastGpsPos, pos);
      }
      lastGpsPos = playerPos;
      playerPos = pos;

      if (!playerMarker) {
        playerMarker = makePlayerMarker();
        playerMarker.setLngLat(pos).addTo(map);
      }
      if (!navActive || !demoActive) {
        playerMarker.setLngLat(pos);
        playerMarker.setRotation(playerHeading);
      }
      if (firstFix) {
        map.easeTo({ center: pos, zoom: 15, duration: 800 });
        toast("GPS LOCKED", true);
      }
      if (navActive && !demoActive) {
        updateNavigation(pos, playerHeading, playerSpeedMps);
      }
      if (!demoActive) checkAlerts(pos, playerHeading);
    }, function (err) {
      if (!hasGpsFix) toast("GPS UNAVAILABLE — TAP MAP + DEMO DRIVE STILL WORK", true);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  }

  // ---------------- Wake lock ----------------
  function acquireWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request("screen").then(function (wl) { wakeLock = wl; }).catch(function () {});
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && navActive) acquireWakeLock();
  });

  // ---------------- Search (Nominatim) ----------------
  var searchTimer = null;
  function onSearchInput() {
    var q = $("search").value.trim();
    clearTimeout(searchTimer);
    if (q.length < 3) { $("search-results").classList.add("hidden"); return; }
    searchTimer = setTimeout(function () {
      var center = map.getCenter();
      var url = NOMINATIM_URL + "?format=jsonv2&limit=5&q=" + encodeURIComponent(q) +
        "&viewbox=" + (center.lng - 1) + "," + (center.lat + 1) + "," + (center.lng + 1) + "," + (center.lat - 1) + "&bounded=0";
      fetch(url, { headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (items) {
          var box = $("search-results");
          box.innerHTML = "";
          if (!items.length) { box.classList.add("hidden"); return; }
          items.forEach(function (it) {
            var div = document.createElement("div");
            div.className = "search-item";
            var parts = (it.display_name || "").split(",");
            div.innerHTML = '<div class="primary">' + escapeHtml(parts[0] || it.name || "?") + "</div>" +
              '<div class="secondary">' + escapeHtml(parts.slice(1, 4).join(",").trim()) + "</div>";
            div.addEventListener("click", function () {
              box.classList.add("hidden");
              $("search").value = parts[0] || "";
              $("search").blur();
              var lngLat = [parseFloat(it.lon), parseFloat(it.lat)];
              map.easeTo({ center: lngLat, zoom: 14, duration: 700 });
              setWaypoint(lngLat, parts[0]);
            });
            box.appendChild(div);
          });
          box.classList.remove("hidden");
        })
        .catch(function () { toast("SEARCH UNAVAILABLE RIGHT NOW"); });
    }, 450);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------------- Mobile-only gate ----------------
  function isStandalone() {
    return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) ||
           window.navigator.standalone === true;
  }

  function isMobileDevice() {
    var touch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
    var coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
    return touch && coarse;
  }

  // Waze-style desktop companion: full map works with a mouse, plus a promo
  // bar whose button pops a QR modal for sending the app to a phone.
  function setupDesktopBar() {
    var qrBuilt = false;
    $("pc-bar").classList.remove("hidden");
    $("btn-send").addEventListener("click", function () {
      if (!qrBuilt) {
        qrBuilt = true;
        var url = location.origin + location.pathname;
        $("send-url").textContent = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
        try {
          var qr = qrcode(0, "M");
          qr.addData(url);
          qr.make();
          $("send-qr").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0 });
        } catch (e) {
          $("send-qr").classList.add("hidden");
        }
      }
      $("send-modal").classList.remove("hidden");
    });
    $("send-close").addEventListener("click", function () {
      $("send-modal").classList.add("hidden");
    });
    $("send-modal").addEventListener("click", function (e) {
      if (e.target === this) this.classList.add("hidden");
    });
    $("pc-bar-close").addEventListener("click", function () {
      $("pc-bar").classList.add("hidden");
    });
  }

  // Shown when WebGL is unavailable (e.g. hardware acceleration disabled) —
  // the one case where the map engine cannot start at all.
  function showMapError() {
    $("hint").classList.add("hidden");
    var div = document.createElement("div");
    div.className = "map-error";
    div.innerHTML =
      '<div class="map-error-card">' +
      '<div class="gate-title">MAP CAN’T RENDER HERE</div>' +
      '<div class="map-error-text">This browser has graphics acceleration (WebGL) switched off, ' +
      "which the map needs. Turn on hardware acceleration in your browser settings — " +
      "or just use LS Maps on your phone.</div>" +
      '<button id="map-error-send" class="btn-send">SEND TO YOUR PHONE</button>' +
      "</div>";
    document.body.appendChild(div);
    var sendBtn = $("btn-send");
    $("map-error-send").addEventListener("click", function () {
      if (sendBtn) sendBtn.click();
    });
  }

  // ---------------- Init ----------------
  function init() {
    if (!isMobileDevice() && !isStandalone()) setupDesktopBar();

    if ("serviceWorker" in navigator &&
        (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
    try {
      map = new maplibregl.Map({
        container: "map",
        style: window.GTA_STYLE,
        center: DEFAULT_CENTER,
        zoom: 12.5,
        attributionControl: false
      });
    } catch (e) {
      showMapError();
      return;
    }
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "&copy; OpenStreetMap contributors &middot; OpenFreeMap &middot; OSRM"
    }), "bottom-left");

    window.__lsmap = map; // debug handle
    window.__lsdebug = { // test hooks for the alert pipeline
      injectCamera: function (lng, lat) {
        cameras.push({ id: "dbg-cam" + Date.now(), pos: [lng, lat] });
        if (map.getSource("cameras")) map.getSource("cameras").setData(pointsFC(cameras));
      },
      injectPolice: function (lng, lat) {
        police.push({ id: "dbg-pol" + Date.now(), pos: [lng, lat] });
        if (map.getSource("police")) map.getSource("police").setData(pointsFC(police));
      }
    };

    map.on("load", function () {
      addRouteLayers();
      addRoadShields();
      addAlertLayers();
      startGps();
      // one-time install hint for iPhone Safari users
      var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
      if (isIos && !isStandalone() && !localStorage.getItem("lsmaps-install-hint")) {
        localStorage.setItem("lsmaps-install-hint", "1");
        setTimeout(function () { toast("INSTALL: SHARE → ADD TO HOME SCREEN", true); }, 2500);
      }
    });

    map.on("click", function (e) {
      // taps on HUD elements never reach the map, so this is a genuine map tap
      if ($("search-results") && !$("search-results").classList.contains("hidden")) {
        $("search-results").classList.add("hidden");
        return;
      }
      setWaypoint(e.lngLat);
    });

    map.on("dragstart", function () { if (navActive) following = false; });

    $("btn-go").addEventListener("click", function () { startNav(false); });
    $("btn-demo").addEventListener("click", function () { startNav(true); });
    $("btn-cancel").addEventListener("click", function () { clearRoute(); });
    $("btn-end").addEventListener("click", function () { stopNav(); });
    $("btn-recenter").addEventListener("click", function () {
      following = true;
      var target = navActive && demoActive ? null : playerPos;
      if (navActive) return; // follow resumes on next tick
      if (target) map.easeTo({ center: target, zoom: 15, duration: 600 });
      else toast("NO GPS FIX YET", true);
    });
    $("btn-north").addEventListener("click", function () {
      following = false;
      map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
    });
    $("btn-voice").addEventListener("click", function () {
      voiceOn = !voiceOn;
      this.classList.toggle("off", !voiceOn);
      toast(voiceOn ? "VOICE ON" : "VOICE OFF", true);
      if (!voiceOn && window.speechSynthesis) window.speechSynthesis.cancel();
    });
    $("search").addEventListener("input", onSearchInput);

    attachDirSearch("from-input", true);
    attachDirSearch("to-input", false);
    $("btn-swap").addEventListener("click", swapEnds);

    $("btn-report").addEventListener("click", function () {
      $("report-sheet").classList.toggle("hidden");
    });
    $("report-police").addEventListener("click", function () {
      $("report-sheet").classList.add("hidden");
      submitPoliceReport();
    });
    $("report-cancel").addEventListener("click", function () {
      $("report-sheet").classList.add("hidden");
    });

    // browsers only allow sound after a first tap — arm the beeper early
    document.addEventListener("pointerdown", unlockAudio, { once: true });
  }

  init();
})();
