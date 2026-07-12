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

  var map, playerMarker, waypointMarker;
  var playerPos = null;        // [lng, lat]
  var playerHeading = 0;       // degrees
  var playerSpeedMps = 0;
  var lastGpsPos = null;
  var hasGpsFix = false;
  var following = true;

  var route = null;            // { coords, cum, totalDist, totalDur, steps }
  var waypointLngLat = null;
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
  function setWaypoint(lngLat) {
    if (navActive) return; // don't re-target mid-drive; END first
    waypointLngLat = [lngLat.lng !== undefined ? lngLat.lng : lngLat[0],
                      lngLat.lat !== undefined ? lngLat.lat : lngLat[1]];
    if (!waypointMarker) waypointMarker = makeWaypointMarker();
    waypointMarker.setLngLat(waypointLngLat).addTo(map);
    $("hint").classList.add("hidden");
    speak("Waypoint set.");
    requestRoute();
  }

  function requestRoute() {
    var origin = playerPos || map.getCenter().toArray();
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
    setRouteGeometry([]);
    $("route-panel").classList.add("hidden");
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
              setWaypoint(lngLat);
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

  function showGate() {
    var gate = $("gate");
    gate.classList.remove("hidden");
    var url = location.origin + location.pathname;
    $("gate-url").textContent = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    try {
      var qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      $("gate-qr").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0 });
    } catch (e) {
      $("gate-qr").classList.add("hidden");
    }
  }

  // ---------------- Init ----------------
  function init() {
    var dev = new URLSearchParams(location.search).get("dev") === "1";
    if (!dev && !isStandalone() && !isMobileDevice()) {
      showGate();
      return; // desktop: gate only, don't boot the map
    }
    $("gate").remove();

    if ("serviceWorker" in navigator &&
        (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
    map = new maplibregl.Map({
      container: "map",
      style: window.GTA_STYLE,
      center: DEFAULT_CENTER,
      zoom: 12.5,
      attributionControl: false
    });
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "&copy; OpenStreetMap contributors &middot; OpenFreeMap &middot; OSRM"
    }), "bottom-left");

    window.__lsmap = map; // debug handle

    map.on("load", function () {
      addRouteLayers();
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
  }

  init();
})();
