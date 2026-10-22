(() => {
  "use strict";

  const CFG = Object.assign(
    { ionAccessToken: "", flightAssetIds: [], pplTargetHours: 40 },
    window.APP_CONFIG || {}
  );

  const M_TO_FT = 3.28084;
  const MODEL_MAX_DIST = 4000; // m: beyond this the aircraft is drawn as a flat icon
  const CHASE_RANGE = 45; // m behind the Skyhawk (~8 m long)
  const MS_TO_KT = 1.943844;
  const M_TO_NM = 1 / 1852;
  const EARTH_R = 6371008.8;
  const GRADIENT = ["#4cc9f0", "#7b6cf6", "#f72585", "#ffb703"];
  const PLANE_PATH =
    "M32 2c2.2 0 3.6 2.6 3.6 6v14l22 12v6l-22-6v13l7 5v5l-10.6-3-10.6 3v-5l7-5V34l-22 6v-6l22-12V8c0-3.4 1.4-6 3.6-6z";

  const $ = (s, r = document) => r.querySelector(s);

  // Phone layouts: portrait gets a bottom sheet, landscape a collapsible side panel.
  const PORTRAIT_MQ = matchMedia("(max-width: 600px)");
  const LANDSCAPE_MQ = matchMedia("(max-height: 500px) and (min-width: 601px)");
  const isPhone = () => PORTRAIT_MQ.matches || LANDSCAPE_MQ.matches;
  const renderScale = () => Math.min(window.devicePixelRatio || 1, isPhone() ? 1 : 1.5);

  const SHEET_STATES = ["peek", "half", "full"];
  function setSheet(s) {
    const prev = document.body.dataset.sheet;
    document.body.dataset.sheet = s;
    if (s !== prev && s !== "peek") requestAnimationFrame(() => revealActiveCard(false));
  }
  // Scroll the flight list (not the sheet) so the selected lesson is in view.
  function revealActiveCard(smooth) {
    const list = document.querySelector(".flight-list");
    const card = list && list.querySelector(".flight-card.active");
    if (!card) return;
    const lr = list.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const behavior = smooth ? "smooth" : "instant";
    if (getComputedStyle(list).display === "flex") {
      list.scrollTo({ left: list.scrollLeft + cr.left - lr.left - (lr.width - cr.width) / 2, behavior });
    } else if (cr.top < lr.top || cr.bottom > lr.bottom) {
      list.scrollTo({ top: list.scrollTop + cr.top - lr.top - 8, behavior });
    }
  }
  function stepSheet(dir) {
    // Landscape has no half state: the side panel is either collapsed or open.
    const states = LANDSCAPE_MQ.matches ? ["peek", "full"] : SHEET_STATES;
    let i = states.indexOf(document.body.dataset.sheet);
    if (i < 0) i = 0;
    // Tap: open to the first open state, or close from any open state.
    if (dir === 0) i = i === 0 ? 1 : 0;
    else i = Cesium.Math.clamp(i + dir, 0, states.length - 1);
    setSheet(states[i]);
  }
  const collapseSheetOnPhone = () => isPhone() && setSheet("peek");
  const state = {
    viewer: null,
    tileset: null,
    flights: [],
    selected: null,
    camMode: "overview",
    aircraft: null,
    current: { alt: 0, spd: 0, vs: 0, hdg: 0, idx: 0 },
    chaseHeading: undefined,
    openNotes: new Set(),
  };

  // ---------------------------------------------------------------- utils
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error("timeout"); })]);

  function toast(msg, ms = 6000) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), ms);
  }


  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
    return (Cesium.Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
  }

  function gradientColor(f) {
    const n = GRADIENT.length - 1;
    const x = Math.min(n, Math.max(0, f * n));
    const i = Math.min(n - 1, Math.floor(x));
    return Cesium.Color.lerp(
      Cesium.Color.fromCssColorString(GRADIENT[i]),
      Cesium.Color.fromCssColorString(GRADIENT[i + 1]),
      x - i,
      new Cesium.Color()
    );
  }

  function fmtDuration(sec, withSeconds = false) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (withSeconds) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }

  const fmtNum = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

  function planeImage(fill) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'>
      <defs><filter id='g' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='2.2'/></filter></defs>
      <path d='${PLANE_PATH}' fill='${fill}' filter='url(#g)' opacity='0.9'/>
      <path d='${PLANE_PATH}' fill='#ffffff' stroke='#0b1020' stroke-width='1.6'/></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  // ---------------------------------------------------------------- token
  // Candidates in priority order: ?token= in the URL, config.js, then a token typed into the
  // in-app prompt. Each is checked against ion so a stale config token (ion regenerates the
  // value on every edit) falls back to the stored one instead of looping on the prompt.
  function tokenCandidates() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("token");
    if (fromUrl) {
      localStorage.setItem("ionToken", fromUrl);
      params.delete("token");
      history.replaceState(null, "", location.pathname + (params.toString() ? `?${params}` : ""));
    }
    const list = [fromUrl, CFG.ionAccessToken, localStorage.getItem("ionToken")].filter(Boolean);
    return [...new Set(list)];
  }

  // false only when ion definitively rejects the token; network errors give it the benefit of the doubt.
  async function tokenWorks(token) {
    const id = CFG.flightAssetIds.find((x) => typeof x === "number");
    if (!id) return true;
    try {
      const res = await withTimeout(
        fetch(`https://api.cesium.com/v1/assets/${id}`, { headers: { Authorization: `Bearer ${token}` } }),
        8000
      );
      return res.status !== 401 && res.status !== 403;
    } catch (e) {
      return true;
    }
  }

  async function resolveToken() {
    for (const t of tokenCandidates()) {
      if (await tokenWorks(t)) return t;
      if (t === localStorage.getItem("ionToken")) localStorage.removeItem("ionToken");
    }
    return "";
  }

  function askForToken(reason) {
    $("#loader").classList.add("done");
    const modal = $("#tokenModal");
    modal.classList.remove("hidden");
    if (reason) toast(reason);
    $("#tokenForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("#tokenInput").value.trim();
      if (!v) return;
      localStorage.setItem("ionToken", v);
      location.reload();
    });
  }

  // ---------------------------------------------------------------- viewer
  async function createViewer() {
    const viewer = new Cesium.Viewer("cesiumContainer", {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      vrButton: false,
      projectionPicker: false,
      baseLayer: false,
      shouldAnimate: false,
      creditContainer: $("#credits"),
      msaaSamples: 4,
    });
    const scene = viewer.scene;
    scene.globe.show = false;
    scene.skyAtmosphere.show = true;
    scene.fog.enabled = true;
    scene.postProcessStages.fxaa.enabled = true;
    viewer.resolutionScale = renderScale();
    viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    // Cesium builds the "Data attribution" overlay inside the map widget, where our panels
    // stack above it. Lift it to <body> (Cesium keeps its own reference, so it still works).
    const creditOverlay = viewer.container.querySelector(".cesium-credit-lightbox-overlay");
    if (creditOverlay) document.body.appendChild(creditOverlay);

    state.viewer = viewer;

    try {
      const tileset = await Cesium.createGooglePhotorealistic3DTileset({ onlyUsingWithGoogleGeocoder: true });
      tileset.maximumScreenSpaceError = 12;
      scene.primitives.add(tileset);
      state.tileset = tileset;
    } catch (err) {
      console.error(err);
      toast("Could not load Google Photorealistic 3D Tiles. Check that your token has access to them.");
    }
    return viewer;
  }

  // ---------------------------------------------------------------- data
  async function discoverAssets() {
    const ids = new Map(CFG.flightAssetIds.map((id) => [id, null]));
    try {
      const url = `https://api.cesium.com/v1/assets?limit=1000`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${Cesium.Ion.defaultAccessToken}` } });
      if (res.ok) {
        const json = await res.json();
        for (const a of json.items || []) {
          if (a.type === "KML" && a.status === "COMPLETE" && tailFromName(a.name) && dateFromName(a.name)) ids.set(a.id, a.name);
        }
      }
    } catch (e) {
      // Token may lack assets:list scope; fall back to configured IDs.
    }
    const list = [...ids.entries()].map(([id, name]) => ({ id, name }));
    // Names carry the flight date, which orders lessons before any KML is downloaded.
    await Promise.all(
      list.filter((a) => !a.name && typeof a.id === "number").map(async (a) => {
        try {
          const res = await fetch(`https://api.cesium.com/v1/assets/${a.id}`, {
            headers: { Authorization: `Bearer ${Cesium.Ion.defaultAccessToken}` },
          });
          if (res.ok) a.name = (await res.json()).name;
        } catch (e) {
          // Metadata is optional; the lesson still loads by ID.
        }
      })
    );
    return list;
  }

  function dateFromName(name) {
    const m = name && name.match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // Aircraft registration at the start of the asset name, e.g. "N16237 - 2026-10-14" or "C-GABC 2026-…".
  function tailFromName(name) {
    const m = name && name.trim().match(/^([A-Z0-9]{1,3}-?[A-Z0-9]{2,5})\b/i);
    return m && /[A-Z]/i.test(m[1]) && !/^\d{4}-\d{2}/.test(m[1]) ? m[1].toUpperCase() : null;
  }

  const fmtDate = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  // Flights are placeholders until their KML is fetched (on demand, newest first).
  function makeFlightStubs(assets) {
    const stubs = assets.map((a) => ({ id: a.id, name: a.name, tail: tailFromName(a.name), nameDate: dateFromName(a.name), loaded: false, entities: {} }));
    stubs.sort((a, b) => (a.nameDate && b.nameDate ? a.nameDate - b.nameDate : 0) || (a.id > b.id ? 1 : -1));
    stubs.forEach((f, i) => {
      f.lesson = i + 1;
      f.color = gradientColor(stubs.length > 1 ? i / (stubs.length - 1) : 0);
      f.css = f.color.toCssHexString();
      f.dateLabel = f.nameDate ? fmtDate(f.nameDate) : f.name || `Asset ${f.id}`;
    });
    return stubs;
  }

  function ensureLoaded(f) {
    if (f.loaded) return Promise.resolve(f);
    if (!f.loading) {
      f.failed = false;
      f.loading = loadFlight(f)
        .then((data) => {
          const { lesson, color, css, tail } = f;
          Object.assign(f, data, { lesson, color, css, entities: {}, tail: tail || tailFromName(data.name) });
          const d = Cesium.JulianDate.toDate(f.start);
          f.dateLabel = fmtDate(d);
          f.timeLabel = `Departed ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
          f.route = f.from && f.to ? (f.from === f.to ? `${f.from} ⟲ local` : `${f.from} → ${f.to}`) : "";
          buildFlightGraphics(f);
          f.loaded = true;
          f.loading = null;
          applyStyles();
          renderLogbook();
          computeHeightOffset(f);
          return f;
        })
        .catch((err) => {
          console.error(err);
          f.loading = null;
          f.failed = true;
          renderLogbook();
          throw err;
        });
      renderLogbook();
    }
    return f.loading;
  }

  // Select a lesson, fetching its track first if needed. Only the latest click wins.
  async function openFlight(f) {
    state.pending = f;
    state.showAll = true;
    try {
      await ensureLoaded(f);
    } catch (e) {
      toast(`Couldn't load Lesson ${f.lesson}. Tap it to try again.`);
      return;
    }
    if (state.pending === f && state.selected !== f) selectFlight(f);
  }

  async function openJourney() {
    state.pending = null;
    state.showAll = true;
    showJourney();
    const pending = state.flights.filter((f) => !f.loaded);
    if (!pending.length) return;
    await Promise.allSettled(pending.map(ensureLoaded));
    // Re-frame to include the newly loaded lessons if the user is still on the overview.
    if (!state.selected && state.pending === null) showJourney();
  }

  function sampledTimes(prop) {
    // Exact sample times from a SampledPositionProperty when available.
    const inner = prop && prop._property;
    if (inner && Array.isArray(inner._times) && inner._times.length > 1) return inner._times;
    return null;
  }

  function extractTrack(ds, assetName) {
    const now = Cesium.JulianDate.now();
    const isReal = (t) => t && Cesium.JulianDate.compare(t, Cesium.Iso8601.MINIMUM_VALUE) > 0 &&
      Cesium.JulianDate.compare(t, Cesium.Iso8601.MAXIMUM_VALUE) < 0;
    let track = null, trackTimes = null;
    const stamped = [];   // Point placemarks with <TimeStamp>
    const named = [];     // Untimed named points (e.g. airports)
    const lines = [];     // LineString segments in document order

    for (const e of ds.entities.values) {
      if (e.polyline && e.polyline.positions) {
        const pos = e.polyline.positions.getValue(now);
        if (pos && pos.length > 1) lines.push(pos);
      }
      if (!e.position) continue;
      const times = sampledTimes(e.position);
      if (times) {
        if (!trackTimes || times.length > trackTimes.length) { track = e; trackTimes = times; }
        continue;
      }
      const p = e.position.getValue(now);
      if (!p) continue;
      const carto = Cesium.Cartographic.fromCartesian(p);
      if (!carto) continue;
      const av = e.availability;
      if (av && av.length && isReal(av.start)) stamped.push({ time: av.start, carto, name: e.name, entity: e });
      else if (e.name) named.push({ name: e.name, carto });
    }

    const samples = [];
    const push = (time, c) => samples.push({ time: Cesium.JulianDate.clone(time), lon: c.longitude, lat: c.latitude, h: c.height });

    if (trackTimes && trackTimes.length >= 10) {
      // gx:Track / gx:MultiTrack
      const k = Math.max(1, Math.ceil(trackTimes.length / 8000));
      for (let i = 0; i < trackTimes.length; i += k) {
        const p = track.position.getValue(trackTimes[i]);
        const c = p && Cesium.Cartographic.fromCartesian(p);
        if (c) push(trackTimes[i], c);
      }
    } else if (stamped.length >= 10) {
      // One timestamped Point placemark per ADS-B report (e.g. FlightAware export).
      // Reported speed/heading live in the description HTML; use them when present.
      stamped.sort((a, b) => Cesium.JulianDate.compare(a.time, b.time));
      const k = Math.max(1, Math.ceil(stamped.length / 8000));
      for (let i = 0; i < stamped.length; i += k) {
        push(stamped[i].time, stamped[i].carto);
        const desc = stamped[i].entity.description && stamped[i].entity.description.getValue(now);
        if (typeof desc === "string") {
          const text = desc.replace(/<[^>]+>/g, " ").replace(/&deg;/g, "");
          const spd = /Speed:\s*([\d.]+)\s*kt/i.exec(text);
          const hdg = /Heading:\s*([\d.]+)/i.exec(text);
          const last = samples[samples.length - 1];
          if (spd) last.rspd = Number(spd[1]) / MS_TO_KT;
          if (hdg) last.rhdg = Number(hdg[1]) % 360;
        }
      }
    } else if (lines.length) {
      // Untimed LineString(s): stitch segments and synthesize a timeline at ~95 kt.
      for (const s of stamped) named.push({ name: s.name, carto: s.carto });
      const m = /(\d{4}-\d{2}-\d{2})/.exec(assetName || "");
      const start = Cesium.JulianDate.fromDate(m ? new Date(`${m[1]}T12:00:00`) : new Date());
      let t = 0, prev = null;
      for (const seg of lines) {
        for (const p of seg) {
          const c = Cesium.Cartographic.fromCartesian(p);
          if (!c) continue;
          if (prev) {
            const d = haversine(prev.latitude, prev.longitude, c.latitude, c.longitude);
            if (d < 1 && Math.abs(prev.height - c.height) < 1) continue;
            t += d / 49;
          }
          push(Cesium.JulianDate.addSeconds(start, t, new Cesium.JulianDate()), c);
          prev = c;
        }
      }
    }

    // Drop out-of-order / duplicate timestamps.
    const clean = samples.filter((s, i) => i === 0 || Cesium.JulianDate.compare(s.time, samples[i - 1].time) > 0);
    return { samples: clean, points: named };
  }
  function analyze(f) {
    const s = f.samples;
    const t0 = s[0].time;
    for (const p of s) p.t = Cesium.JulianDate.secondsDifference(p.time, t0);

    let dist = 0, maxAlt = -Infinity, minAlt = Infinity, maxFromStart = 0, minAir = Infinity;
    // ADS-B "on ground" reports come through as 0 ft.
    const anyAir = s.some((p) => p.h > 1);
    for (let i = 0; i < s.length; i++) {
      s[i].ground = anyAir && s[i].h <= 1;
      if (!s[i].ground) minAir = Math.min(minAir, s[i].h);
      if (i) dist += haversine(s[i - 1].lat, s[i - 1].lon, s[i].lat, s[i].lon);
      maxAlt = Math.max(maxAlt, s[i].h);
      minAlt = Math.min(minAlt, s[i].h);
      maxFromStart = Math.max(maxFromStart, haversine(s[0].lat, s[0].lon, s[i].lat, s[i].lon));
    }
    // Rough field elevation until the 3D Tiles surface has been sampled.
    f.groundGuess = Number.isFinite(minAir) ? minAir - 15 : 0;

    // Smoothed kinematics over a ~±15 s window.
    let maxSpd = 0;
    let j0 = 0, j1 = 0;
    for (let i = 0; i < s.length; i++) {
      while (j0 < i && s[i].t - s[j0].t > 15) j0++;
      while (j1 < s.length - 1 && s[j1 + 1].t - s[i].t <= 15) j1++;
      const a = s[Math.min(j0, i)], b = s[Math.max(j1, i)];
      const dt = b.t - a.t;
      if (dt > 0) {
        const d = haversine(a.lat, a.lon, b.lat, b.lon);
        s[i].spd = d / dt;
        s[i].vs = a.ground || b.ground ? 0 : (b.h - a.h) / dt;
        s[i].hdg = d > 5 ? bearing(a.lat, a.lon, b.lat, b.lon) : (i ? s[i - 1].hdg : 0);
      } else {
        s[i].spd = 0; s[i].vs = 0; s[i].hdg = i ? s[i - 1].hdg : 0;
      }
      if (s[i].rspd !== undefined) s[i].spd = s[i].rspd;
      if (s[i].rhdg !== undefined) s[i].hdg = s[i].rhdg;
      if (s[i].spd < 120) maxSpd = Math.max(maxSpd, s[i].spd);
    }

    const last = s[s.length - 1];
    const endDist = haversine(s[0].lat, s[0].lon, last.lat, last.lon);
    f.start = t0;
    f.stop = last.time;
    f.duration = last.t;
    f.distance = dist;
    f.maxAlt = maxAlt;
    f.minAlt = minAlt;

    // Displayed altitude (ft). ADS-B reports pressure altitude (29.92 inHg); with the lesson's
    // altimeter setting it becomes indicated altitude: + (setting − 29.92) × 1000 ft.
    // Only the numbers change; the 3D track keeps its own terrain calibration.
    const setting = Number((CFG.altimeters || {})[f.id]);
    f.altimeter = setting > 27 && setting < 32 ? setting : null;
    const corrFt = f.altimeter ? (f.altimeter - 29.92) * 1000 : 0;
    f.maxFt = -Infinity;
    f.minFt = Infinity;
    for (const p of s) {
      p.ft = p.ground ? 0 : p.h * M_TO_FT + corrFt; // on-ground reports stay at 0, as before
      f.maxFt = Math.max(f.maxFt, p.ft);
      f.minFt = Math.min(f.minFt, p.ft);
    }
    f.maxSpd = maxSpd;
    f.maxFromStart = maxFromStart;
    f.type =
      maxFromStart * M_TO_NM > 25 || endDist * M_TO_NM > 25 ? "Cross-country"
        : maxFromStart * M_TO_NM < 4 ? "Pattern work"
          : "Practice area";

    const nearest = (lat, lon) => {
      let bestP = null, bestD = 6000;
      for (const p of f.points) {
        const d = haversine(lat, lon, p.carto.latitude, p.carto.longitude);
        if (d < bestD) { bestD = d; bestP = p; }
      }
      return bestP ? bestP.name : null;
    };
    f.from = nearest(s[0].lat, s[0].lon);
    f.to = nearest(last.lat, last.lon);
  }

  async function loadFlight(asset) {
    // Numeric IDs are Cesium ion assets; strings are treated as KML/KMZ URLs.
    const resource = typeof asset.id === "string"
      ? new Cesium.Resource({ url: asset.id })
      : await Cesium.IonResource.fromAssetId(asset.id);
    const ds = await Cesium.KmlDataSource.load(resource, {
      camera: state.viewer.scene.camera,
      canvas: state.viewer.scene.canvas,
      clampToGround: false,
    });
    const { samples, points } = extractTrack(ds, asset.name);
    if (samples.length < 2) throw new Error(`No track found in asset ${asset.id}`);
    const f = {
      id: asset.id,
      name: asset.name || ds.name || "Flight",
      samples,
      points,
      offset: 0,
      entities: {},
    };
    analyze(f);
    return f;
  }

  // Google 3D Tiles use ellipsoid heights while ADS-B altitudes are MSL (and on-ground
  // reports are 0 ft). Ground samples are placed on the sampled 3D Tiles surface, and
  // the airborne MSL->ellipsoid offset is calibrated at takeoff/landing transitions.
  async function computeHeightOffset(f) {
    // Heights are sampled from the 3D Tiles surface; wait until they are shown again.
    if (!state.tileset || !state.tileset.show || f.offsetComputed) return;
    f.offsetComputed = true;
    const s = f.samples;
    const scene = state.viewer.scene;
    const exclude = state.flights.flatMap((x) => Object.values(x.entities)).concat(state.aircraft);
    if (state.model) exclude.push(state.model);
    const sample = (idx) =>
      withTimeout(scene.sampleHeightMostDetailed(idx.map((i) => new Cesium.Cartographic(s[i].lon, s[i].lat)), exclude, 0.5), 30000)
        .then((res) => idx.map((i, j) => ({ i, h: res[j] && res[j].height })).filter((x) => Number.isFinite(x.h)));
    try {
      const groundIdx = [];
      s.forEach((p, i) => p.ground && groundIdx.push(i));
      let changed = false;
      if (groundIdx.length) {
        const k = Math.max(1, Math.ceil(groundIdx.length / 150));
        const pick = groundIdx.filter((_, j) => j % k === 0);
        if (pick[pick.length - 1] !== groundIdx[groundIdx.length - 1]) pick.push(groundIdx[groundIdx.length - 1]);
        const known = await sample(pick);
        if (known.length) {
          let j = 0;
          for (const i of groundIdx) {
            while (j < known.length - 1 && Math.abs(known[j + 1].i - i) <= Math.abs(known[j].i - i)) j++;
            s[i].gh = known[j].h + 1.5;
          }
          const offs = [];
          for (let i = 1; i < s.length; i++) {
            if (s[i - 1].ground && !s[i].ground && s[i - 1].gh !== undefined) offs.push(s[i - 1].gh - s[i].h);
            if (!s[i - 1].ground && s[i].ground && s[i].gh !== undefined) offs.push(s[i].gh - s[i - 1].h);
          }
          // ADS-B reports uncorrected pressure altitude; daily baro error can be several hundred feet.
          const valid = offs.filter((o) => Math.abs(o) < 350);
          if (valid.length) f.offset = valid.reduce((a, b) => a + b, 0) / valid.length + 10;
          changed = true;
        }
      } else {
        const known = await sample([0, s.length - 1]);
        const candidates = known.map((x) => x.h - s[x.i].h).filter((o) => o > -90 && o < 40);
        if (candidates.length) {
          candidates.sort((a, b) => Math.abs(a) - Math.abs(b));
          f.offset = candidates[0] + 2;
          changed = true;
        }
      }
      if (changed) {
        buildFlightGraphics(f);
        applyStyles();
        if (state.selected === f) attachAircraft(f);
      }
    } catch (e) {
      console.warn("Height offset sampling failed", e);
    }
  }

  // ---------------------------------------------------------------- graphics
  function renderHeight(f, p) {
    if (p.ground) return p.gh !== undefined ? p.gh : f.groundGuess + f.offset;
    return p.h + f.offset;
  }

  function positionsOf(f, maxPoints) {
    const s = f.samples;
    const k = Math.max(1, Math.ceil(s.length / maxPoints));
    const out = [];
    for (let i = 0; i < s.length; i += k) out.push(Cesium.Cartesian3.fromRadians(s[i].lon, s[i].lat, renderHeight(f, s[i])));
    const l = s[s.length - 1];
    out.push(Cesium.Cartesian3.fromRadians(l.lon, l.lat, renderHeight(f, l)));
    return out;
  }
  function buildFlightGraphics(f) {
    const ents = state.viewer.entities;
    for (const e of Object.values(f.entities)) ents.remove(e);

    const line = positionsOf(f, 1500);
    const wall = positionsOf(f, 500);
    f.positions = line;
    f.bounds = Cesium.BoundingSphere.fromPoints(line);

    f.entities.line = ents.add({
      polyline: { positions: line, width: 5, material: new Cesium.PolylineGlowMaterialProperty({ color: f.color, glowPower: 0.22 }) },
    });
    f.entities.wall = ents.add({
      show: false,
      wall: {
        positions: wall,
        material: new Cesium.ImageMaterialProperty({ image: curtainTexture(f.css), transparent: true }),
      },
    });
    f.entities.shadow = ents.add({
      show: false,
      polyline: {
        positions: wall,
        clampToGround: true,
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        width: 3,
        material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE.withAlpha(0.55), dashLength: 18 }),
      },
    });

    const s0 = f.samples[0];
    f.entities.startPin = ents.add({
      position: Cesium.Cartesian3.fromRadians(s0.lon, s0.lat, renderHeight(f, s0)),
      point: { pixelSize: 9, color: f.color, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: {
        text: `Lesson ${f.lesson}`,
        font: "600 13px Inter, sans-serif",
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#0b1020").withAlpha(0.75),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        pixelOffset: new Cesium.Cartesian2(0, -22),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2.5e5),
      },
    });

    const prop = new Cesium.SampledPositionProperty();
    prop.setInterpolationOptions({ interpolationDegree: 1, interpolationAlgorithm: Cesium.LinearApproximation });
    prop.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    prop.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    for (const p of f.samples) prop.addSample(p.time, Cesium.Cartesian3.fromRadians(p.lon, p.lat, renderHeight(f, p)));
    f.positionProperty = prop;
  }

  const curtainCache = {};
  function curtainTexture(css) {
    if (curtainCache[css]) return curtainCache[css];
    const c = document.createElement("canvas");
    c.width = 4; c.height = 256;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 256);
    const col = Cesium.Color.fromCssColorString(css);
    const rgba = (a) => `rgba(${col.red * 255 | 0},${col.green * 255 | 0},${col.blue * 255 | 0},${a})`;
    grad.addColorStop(0, rgba(0.45));
    grad.addColorStop(0.35, rgba(0.18));
    grad.addColorStop(1, rgba(0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    return (curtainCache[css] = c);
  }

  // All tracks are downloaded at startup, but only the latest is drawn until the
  // user asks to visualize all flight paths or picks a lesson.
  const isVisible = (f) => f.loaded && (state.showAll || f === state.defaultFlight || f === state.selected);

  function applyStyles() {
    const sel = state.selected;
    for (const f of state.flights) {
      const on = !sel || sel === f;
      const e = f.entities;
      if (!e.line) continue;
      const visible = isVisible(f);
      e.line.show = visible;
      if (!visible) {
        e.wall.show = e.shadow.show = e.startPin.show = false;
        continue;
      }
      e.line.polyline.width = sel === f ? 6 : on ? 5 : 3;
      // Reuse one material per look so restyling doesn't churn allocations and shader updates.
      const look = sel === f ? "selected" : on ? "on" : "dim";
      const mats = (f.materials ||= {});
      mats[look] ||= new Cesium.PolylineGlowMaterialProperty({
        color: on ? f.color : f.color.withAlpha(0.3),
        glowPower: sel === f ? 0.25 : 0.2,
      });
      if (e.line.polyline.material !== mats[look]) e.line.polyline.material = mats[look];
      e.wall.show = sel === f;
      e.shadow.show = sel === f;
      e.startPin.show = !sel;
    }
  }

  function createAircraft() {
    const scratchM = new Cesium.Matrix4();
    const scratchC4 = new Cesium.Cartesian4();
    const north = new Cesium.Cartesian3(0, 0, 1);
    const hpr = new Cesium.HeadingPitchRoll();
    const att = { pitch: 0, roll: 0 };
    state.aircraft = state.viewer.entities.add({
      show: false,
      billboard: {
        image: planeImage("#4cc9f0"),
        scale: 0.62,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        rotation: new Cesium.CallbackProperty(() => -Cesium.Math.toRadians(state.current.hdg), false),
        alignedAxis: new Cesium.CallbackProperty((time) => {
          const pos = state.aircraft.position && state.aircraft.position.getValue(time);
          if (!pos) return Cesium.Cartesian3.UNIT_Z;
          Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, scratchM);
          Cesium.Matrix4.getColumn(scratchM, 1, scratchC4);
          return Cesium.Cartesian3.fromCartesian4(scratchC4, north);
        }, false),
      },
      orientation: new Cesium.CallbackProperty((time, result) => {
        const pos = state.aircraft.position && state.aircraft.position.getValue(time);
        if (!pos) return undefined;
        const c = state.current;
        // Pitch from climb gradient, bank from coordinated-turn rate; smoothed to hide ADS-B jitter.
        const tPitch = c.ground || !(c.spd > 5) ? 0 : Math.atan2(c.vs, c.spd);
        const tRoll = c.ground ? 0 : Math.atan((c.spd * Cesium.Math.toRadians(c.turn || 0)) / 9.81);
        att.pitch += (Cesium.Math.clamp(tPitch, -0.35, 0.35) - att.pitch) * 0.08;
        att.roll += (Cesium.Math.clamp(tRoll, -0.7, 0.7) - att.roll) * 0.06;
        hpr.heading = Cesium.Math.toRadians(c.hdg + (CFG.aircraftModelHeadingOffset || 0)) - Cesium.Math.PI_OVER_TWO;
        hpr.pitch = att.pitch;
        hpr.roll = att.roll;
        return Cesium.Transforms.headingPitchRollQuaternion(pos, hpr, Cesium.Ellipsoid.WGS84, undefined, result);
      }, false),
      path: {
        leadTime: 0,
        trailTime: 900,
        width: 7,
        resolution: 2,
        material: new Cesium.PolylineGlowMaterialProperty({ color: Cesium.Color.fromCssColorString("#ffd166"), glowPower: 0.3 }),
      },
    });
  }

  // The Skyhawk glTF (~45 MB) is fetched in the background after the app is usable.
  // It's a scene primitive rather than entity.model so it downloads even while hidden;
  // the flat plane icon stands in until it's ready.
  async function loadAircraftModel() {
    if (!CFG.aircraftModelAssetId || state.model) return;
    try {
      const url = await Cesium.IonResource.fromAssetId(CFG.aircraftModelAssetId);
      const model = await Cesium.Model.fromGltfAsync({
        url,
        show: false,
        minimumPixelSize: 40,
        maximumScale: 600,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, MODEL_MAX_DIST),
      });
      state.viewer.scene.primitives.add(model);
      state.model = model;
      model.readyEvent.addEventListener(() => {
        // Flat icon only when the real-size Cessna would be too far away to read.
        state.aircraft.billboard.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(MODEL_MAX_DIST, Number.MAX_VALUE);
      });
    } catch (e) {
      console.warn("Aircraft model failed to load", e);
    }
  }

  const scratchModelQ = new Cesium.Quaternion();
  const scratchModelM = new Cesium.Matrix4();
  function updateAircraftModel(time) {
    const m = state.model;
    if (!m) return;
    const a = state.aircraft;
    const pos = a.show && state.selected && a.position && a.position.getValue(time);
    const q = pos && a.orientation.getValue(time, scratchModelQ);
    m.show = !!(pos && q);
    if (m.show) m.modelMatrix = Cesium.Matrix4.fromTranslationQuaternionRotationScale(pos, q, new Cesium.Cartesian3(1, 1, 1), scratchModelM);
  }

  function attachAircraft(f) {
    const a = state.aircraft;
    a.position = f.positionProperty;
    a.billboard.image = planeImage(f.css);
    a.path.material = new Cesium.PolylineGlowMaterialProperty({
      color: Cesium.Color.lerp(f.color, Cesium.Color.WHITE, 0.35, new Cesium.Color()),
      glowPower: 0.3,
    });
    a.show = true;
  }

  // ---------------------------------------------------------------- camera
  function releaseCamera() {
    const v = state.viewer;
    v.trackedEntity = undefined;
    v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  function flyToSphere(sphere, pitchDeg = -45, heading = 0, scale = 2.6) {
    releaseCamera();
    // Portrait phones have a narrow horizontal FOV and the bottom of the screen is
    // covered by the player/sheet, so pull back and aim a bit short of the center.
    const portrait = PORTRAIT_MQ.matches;
    const range = Math.max(sphere.radius * scale * (portrait ? 1.3 : 1), 2500);
    let target = sphere;
    if (portrait) {
      const h = Cesium.Math.toRadians(heading);
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(sphere.center);
      const back = Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(-Math.sin(h), -Math.cos(h), 0), new Cesium.Cartesian3());
      const center = Cesium.Cartesian3.add(sphere.center, Cesium.Cartesian3.multiplyByScalar(back, range * 0.08, back), new Cesium.Cartesian3());
      target = new Cesium.BoundingSphere(center, sphere.radius);
    }
    state.viewer.camera.flyToBoundingSphere(target, {
      duration: 2.4,
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(pitchDeg), range),
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  function setCamMode(mode) {
    state.camMode = mode;
    document.querySelectorAll("#camModes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    const f = state.selected;
    if (!f) return;
    releaseCamera();
    if (mode === "overview") {
      flyToSphere(f.bounds, -42, 0, 2.4);
    } else if (mode === "orbit") {
      state.aircraft.viewFrom = new Cesium.Cartesian3(-35, -55, 22);
      state.viewer.trackedEntity = state.aircraft;
    } else if (mode === "chase") {
      state.chaseHeading = undefined;
    }
  }

  function updateChaseCamera(time) {
    if (state.camMode !== "chase" || !state.selected) return;
    const pos = state.aircraft.position.getValue(time);
    if (!pos) return;
    const hdg = Cesium.Math.toRadians(state.current.hdg);
    if (state.chaseHeading === undefined) state.chaseHeading = hdg;
    let d = Cesium.Math.negativePiToPi(hdg - state.chaseHeading);
    state.chaseHeading += d * 0.04;
    let target = pos;
    if (PORTRAIT_MQ.matches) {
      // Aim slightly below the aircraft so it sits in the visible part of the screen above the player.
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new Cesium.Cartesian3());
      target = Cesium.Cartesian3.add(pos, Cesium.Cartesian3.multiplyByScalar(up, -CHASE_RANGE * 0.1, up), new Cesium.Cartesian3());
    }
    state.viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(state.chaseHeading, Cesium.Math.toRadians(-12), CHASE_RANGE));
  }

  // ---------------------------------------------------------------- selection
  function showJourney() {
    state.selected = null;
    const v = state.viewer;
    v.clock.shouldAnimate = false;
    syncPlayButton();
    if (state.aircraft) state.aircraft.show = false;
    applyStyles();
    $("#journeyBtn").classList.add("active");
    document.querySelectorAll(".flight-card").forEach((c) => c.classList.remove("active"));
    ["#player", "#hud", "#camModes"].forEach((s) => $(s).classList.add("hidden"));
    document.body.classList.remove("flight-open");

    const loaded = state.flights.filter(isVisible);
    if (!loaded.length) return;
    const latest = loaded[loaded.length - 1];
    v.clock.currentTime = Cesium.JulianDate.addSeconds(latest.start, latest.duration / 2, new Cesium.JulianDate());
    const all = Cesium.BoundingSphere.fromBoundingSpheres(loaded.map((f) => f.bounds));
    flyToSphere(all, -48, 0, 2.8);
  }

  function selectFlight(f) {
    state.selected = f;
    const v = state.viewer;
    v.clock.shouldAnimate = false;
    v.clock.startTime = f.start.clone();
    v.clock.stopTime = f.stop.clone();
    v.clock.currentTime = f.start.clone();
    v.clock.clockRange = Cesium.ClockRange.CLAMPED;
    v.clock.multiplier = Number($("#speeds .active").dataset.speed);
    syncPlayButton();

    attachAircraft(f);
    applyStyles();
    updateHud(v.clock.currentTime);

    $("#journeyBtn").classList.remove("active");
    let card = null;
    document.querySelectorAll(".flight-card").forEach((c) => {
      const on = c.dataset.id === String(f.id);
      c.classList.toggle("active", on);
      if (on) card = c;
    });
    if (card) revealActiveCard(true);

    // Say which altitude the numbers are: indicated at the lesson's setting, or raw pressure altitude.
    const set = f.altimeter ? f.altimeter.toFixed(2) : null;
    $("#hudAltLabel").textContent = set ? `Alt · ${set}` : "Pressure alt";
    $("#hudAltItem").title = set
      ? `Indicated altitude at altimeter setting ${set} inHg (ADS-B pressure altitude corrected from 29.92)`
      : "ADS-B pressure altitude (29.92 inHg); can differ from the altimeter by a few hundred feet";
    $("#chartAltLegend").textContent = set ? `Altitude (${set})` : "Pressure altitude";

    $("#playerTitle").textContent =`Lesson ${f.lesson}${f.tail ? " · " + f.tail : ""} · ${f.dateLabel}${f.route ? " · " + f.route : ""}`;
    document.documentElement.style.setProperty("--accent", f.css);
    ["#player", "#hud", "#camModes"].forEach((s) => $(s).classList.remove("hidden"));
    document.body.classList.add("flight-open");
    setCamMode("overview");
    drawChart();
    computeHeightOffset(f);
  }

  // ---------------------------------------------------------------- HUD / player
  function stateAt(f, time) {
    const s = f.samples;
    const t = Cesium.JulianDate.secondsDifference(time, f.start);
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = s[lo], b = s[hi];
    const u = b.t > a.t ? Cesium.Math.clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
    const dh = Cesium.Math.negativePiToPi(Cesium.Math.toRadians(b.hdg - a.hdg));
    return {
      t: Cesium.Math.clamp(t, 0, f.duration),
      idx: lo,
      ground: !!(a.ground && b.ground),
      turn: b.t > a.t ? Cesium.Math.toDegrees(dh) / (b.t - a.t) : 0,
      alt: a.h + (b.h - a.h) * u,
      ft: a.ft + (b.ft - a.ft) * u,
      spd: a.spd + (b.spd - a.spd) * u,
      vs: a.vs + (b.vs - a.vs) * u,
      hdg: (a.hdg + Cesium.Math.toDegrees(dh) * u + 360) % 360,
    };
  }

  // The scene renders every frame; skip the DOM writes when nothing moved (paused, or between ticks).
  const hudLast = { f: null, time: new Cesium.JulianDate() };
  function updateHud(time) {
    const f = state.selected;
    if (!f) return;
    if (hudLast.f === f && Cesium.JulianDate.equals(time, hudLast.time)) return;
    hudLast.f = f;
    Cesium.JulianDate.clone(time, hudLast.time);
    const c = (state.current = stateAt(f, time));
    $("#hudAlt").textContent = c.ground ? "GND" : fmtNum(Math.round(c.ft / 10) * 10);
    $("#hudAlt").nextElementSibling.style.visibility = c.ground ? "hidden" : "";
    $("#hudSpd").textContent = fmtNum(c.spd * MS_TO_KT);
    const vs = Math.round((c.vs * M_TO_FT * 60) / 10) * 10;
    $("#hudVs").textContent = (vs > 0 ? "+" : "") + fmtNum(vs);
    $("#hudHdg").textContent = String(Math.round(c.hdg) % 360).padStart(3, "0");
    $("#clockTime").textContent = Cesium.JulianDate.toDate(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("#elapsed").textContent = `${fmtDuration(c.t, true)} / ${fmtDuration(f.duration, true)}`;
    $("#scrubFill").style.width = `${(100 * Cesium.Math.clamp(c.t / f.duration, 0, 1)).toFixed(2)}%`;
  }

  function syncPlayButton() {
    $("#playBtn").classList.toggle("playing", state.viewer.clock.shouldAnimate);
  }

  function togglePlay() {
    const v = state.viewer;
    if (!state.selected) return;
    if (!v.clock.shouldAnimate && Cesium.JulianDate.greaterThanOrEquals(v.clock.currentTime, v.clock.stopTime)) {
      v.clock.currentTime = v.clock.startTime.clone();
    }
    v.clock.shouldAnimate = !v.clock.shouldAnimate;
    if (v.clock.shouldAnimate && state.camMode === "overview") setCamMode("chase");
    syncPlayButton();
  }

  // ---------------------------------------------------------------- chart
  const chart = { canvas: null, ctx: null, w: 0, h: 0, lastT: -1 };

  function resizeChart() {
    const c = chart.canvas;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, r.width * dpr);
    c.height = Math.max(1, r.height * dpr);
    chart.w = r.width;
    chart.h = r.height;
    chart.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart();
  }

  function drawChart() {
    const f = state.selected;
    const { ctx, w, h } = chart;
    if (!ctx || !f) return;
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 44, r: 8, t: 8, b: 16 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const lo = Math.floor(f.minFt / 500) * 500;
    const hi = Math.ceil((f.maxFt * 1.05) / 500) * 500 || lo + 500;
    if (![lo, hi, f.duration].every(Number.isFinite) || f.duration <= 0 || hi <= lo) return;
    const x = (t) => pad.l + (t / f.duration) * iw;
    const y = (ft) => pad.t + ih - ((ft - lo) / (hi - lo)) * ih;
    const spdMax = Math.max(60, f.maxSpd * MS_TO_KT * 1.15);
    const ys = (kt) => pad.t + ih - (kt / spdMax) * ih;

    // grid
    ctx.font = "500 10px JetBrains Mono, monospace";
    ctx.fillStyle = "rgba(148,163,196,0.8)";
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const stepFt = (hi - lo) > 4000 ? 2000 : (hi - lo) > 2000 ? 1000 : 500;
    for (let v = lo; v <= hi; v += stepFt) {
      ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
      ctx.fillText(v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : `${v}`, pad.l - 6, y(v));
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const tickStep = f.duration > 5400 ? 1800 : f.duration > 1800 ? 600 : 300;
    for (let t = 0; t <= f.duration; t += tickStep) ctx.fillText(fmtDuration(t), x(t), h - pad.b + 4);

    const s = f.samples;
    const k = Math.max(1, Math.floor(s.length / iw));
    // altitude area
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, f.css + "aa");
    grad.addColorStop(1, f.css + "05");
    ctx.beginPath();
    ctx.moveTo(x(0), pad.t + ih);
    for (let i = 0; i < s.length; i += k) ctx.lineTo(x(s[i].t), y(s[i].ft));
    ctx.lineTo(x(f.duration), pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < s.length; i += k) ctx[i ? "lineTo" : "moveTo"](x(s[i].t), y(s[i].ft));
    ctx.strokeStyle = f.css;
    ctx.lineWidth = 2;
    ctx.shadowColor = f.css;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // speed line
    ctx.beginPath();
    for (let i = 0; i < s.length; i += k) ctx[i ? "lineTo" : "moveTo"](x(s[i].t), ys(Math.min(s[i].spd * MS_TO_KT, spdMax)));
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // played portion mask + cursor
    const c = state.current;
    const cx = x(c.t);
    ctx.fillStyle = "rgba(5,7,15,0.35)";
    ctx.fillRect(cx, pad.t, w - pad.r - cx, ih);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, pad.t + ih); ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, y(c.ft), 5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.shadowColor = f.css; ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    chart.pad = pad;
    chart.iw = iw;
  }

  function scrubTo(clientX) {
    const f = state.selected;
    if (!f || !chart.pad) return;
    const r = chart.canvas.getBoundingClientRect();
    const u = Cesium.Math.clamp((clientX - r.left - chart.pad.l) / chart.iw, 0, 1);
    state.viewer.clock.currentTime = Cesium.JulianDate.addSeconds(f.start, u * f.duration, new Cesium.JulianDate());
  }

  function scrubBarTo(clientX) {
    const f = state.selected;
    if (!f) return;
    const r = $("#scrub").getBoundingClientRect();
    const u = Cesium.Math.clamp((clientX - r.left) / r.width, 0, 1);
    state.viewer.clock.currentTime = Cesium.JulianDate.addSeconds(f.start, u * f.duration, new Cesium.JulianDate());
  }

  // ---------------------------------------------------------------- logbook UI
  function sparkline(f) {
    const s = f.samples, W = 300, H = 34;
    const k = Math.max(1, Math.floor(s.length / 120));
    const span = Math.max(1, f.maxAlt - f.minAlt);
    let d = "";
    for (let i = 0; i < s.length; i += k) {
      const px = (s[i].t / f.duration) * W;
      const py = H - 2 - ((s[i].h - f.minAlt) / span) * (H - 6);
      d += `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
    }
    const id = `sg${f.lesson}`;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f.css}" stop-opacity=".45"/><stop offset="1" stop-color="${f.css}" stop-opacity="0"/></linearGradient></defs>
      <path d="${d}L${W},${H}L0,${H}Z" fill="url(#${id})"/>
      <path d="${d}" fill="none" stroke="${f.css}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderLogbook() {
    const fl = state.flights;
    const ld = fl.filter((f) => f.loaded);
    // Totals only cover downloaded lessons; "+" signals more to come.
    const more = ld.length < fl.length ? "+" : "";
    const hours = ld.reduce((a, f) => a + f.duration, 0) / 3600;
    $("#statFlights").textContent = fl.length;
    $("#statHours").textContent = `${hours.toFixed(1)}h${more}`;
    $("#statDistance").textContent = ld.length ? fmtNum(ld.reduce((a, f) => a + f.distance, 0) * M_TO_NM) + more : "–";
    $("#statAlt").textContent = ld.length ? fmtNum(Math.max(...ld.map((f) => f.maxFt)), 0) + more : "–";
    $("#progressText").textContent = `${hours.toFixed(1)}${more} / ${CFG.pplTargetHours} hrs`;
    $("#sheetSummary").innerHTML = `<b>Logbook</b> · ${fl.length} lesson${fl.length === 1 ? "" : "s"} · ${hours.toFixed(1)}${more} hrs logged`;
    requestAnimationFrame(() => {
      $("#progressFill").style.width = `${Math.min(100, (hours / CFG.pplTargetHours) * 100)}%`;
    });

    const longest = ld.reduce((a, f) => (f.duration > (a ? a.duration : 0) ? f : a), null);
    const highest = ld.reduce((a, f) => (f.maxFt > (a ? a.maxFt : -Infinity) ? f : a), null);
    const farthest = ld.reduce((a, f) => (f.maxFromStart > (a ? a.maxFromStart : 0) ? f : a), null);
    const multi = ld.length > 1;

    const list = $("#flightList");
    const scroll = list.scrollTop;
    const scrollX = list.scrollLeft;
    list.innerHTML = "";
    // Newest lesson at the top of the timeline.
    for (const f of [...fl].reverse()) {
      const badges = [];
      if (f.lesson === 1) badges.push("🎉 First flight");
      if (multi && f === longest) badges.push("⏱ Longest");
      if (multi && f === highest) badges.push("⛰ Highest");
      if (multi && f === farthest) badges.push("🧭 Farthest");
      if (f.lesson === fl.length && fl.length > 1) badges.push("✨ Latest");

      const status = f.loading ? "Loading flight…" : f.failed ? "Couldn't load — tap to retry" : "Tap to load flight";
      const card = document.createElement("div");
      card.className = `flight-card${f.loaded ? "" : " unloaded"}${f.loading ? " loading" : ""}${state.selected === f ? " active" : ""}${state.openNotes.has(f.id) ? " notes-open" : ""}`;
      card.dataset.id = f.id;
      card.style.setProperty("--c", f.css);
      card.innerHTML = `
        <div class="node"></div>
        <div class="card-body">
          <div class="card-top">
            <div>
              <div class="lesson">Lesson ${f.lesson}${f.tail ? `<span class="tail" title="Aircraft">✈ ${f.tail}</span>` : ""}</div>
              <div class="card-date">${f.dateLabel}</div>
              <div class="card-route">${f.loaded ? f.route || f.timeLabel : status}</div>
            </div>
            ${f.loaded ? `<span class="tag">${f.type}</span>` : ""}
          </div>
          <div class="chips">
            <div class="chip"><b>${f.loaded ? fmtDuration(f.duration) : "–"}</b>Duration</div>
            <div class="chip"><b>${f.loaded ? fmtNum(f.distance * M_TO_NM, 1) : "–"}</b>nm</div>
            <div class="chip"><b>${f.loaded ? fmtNum(f.maxFt) : "–"}</b>ft max</div>
          </div>
          ${f.loaded ? sparkline(f) : `<div class="spark spark-placeholder"></div>`}
          ${badges.length ? `<div class="badges">${badges.map((b) => `<span class="badge">${b}</span>`).join("")}</div>` : ""}
          <div class="notes"><button class="notes-toggle mobile-only">📝 Notes</button><textarea placeholder="What did you practice? Notes from your instructor…"></textarea></div>
        </div>`;
      const ta = card.querySelector("textarea");
      ta.value = localStorage.getItem(`note-${f.id}`) || "";
      card.querySelector(".notes-toggle").textContent = ta.value ? "📝 Notes ✓" : "📝 Add notes";
      card.querySelector(".notes-toggle").addEventListener("click", (e) => {
        e.stopPropagation();
        const open = card.classList.toggle("notes-open");
        state.openNotes[open ? "add" : "delete"](f.id);
        if (open) ta.focus();
      });
      ta.addEventListener("input", () => localStorage.setItem(`note-${f.id}`, ta.value));
      ta.addEventListener("click", (e) => e.stopPropagation());
      card.querySelector(".card-body").addEventListener("click", () => {
        collapseSheetOnPhone();
        if (state.selected !== f) openFlight(f);
      });
      list.appendChild(card);
    }
    list.scrollTop = scroll;
    list.scrollLeft = scrollX;
  }

  // ---------------------------------------------------------------- wiring
  // ---------------------------------------------------------------- map tools
  // Google Maps 2D imagery assets in Cesium ion.
  const OVERLAYS = { labels: 3830185, roadmap: 3830184, satLabels: 3830183, sat: 3830182 };
  // Each elevation source remembers its own overlay.
  const layers = { elev: "google3d", overlays: { google3d: "labels", cwt: "satLabels" }, cache: new Map(), terrain: null };
  try {
    const saved = JSON.parse(localStorage.getItem("mapLayers.v2") || "{}");
    if (["google3d", "cwt"].includes(saved.elev)) layers.elev = saved.elev;
    const o = saved.overlays || {};
    if (o.google3d === "none" || OVERLAYS[o.google3d]) layers.overlays.google3d = o.google3d;
    if (OVERLAYS[o.cwt]) layers.overlays.cwt = o.cwt;
  } catch (e) {
    // Ignore bad saved settings.
  }

  const worldTerrain = () => (layers.terrain ||= Cesium.CesiumTerrainProvider.fromIonAssetId(1));

  function overlayLayer(target, key) {
    const k = `${target}:${key}`;
    if (!layers.cache.has(k)) {
      layers.cache.set(k, Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(OVERLAYS[key])));
    }
    return layers.cache.get(k);
  }

  function applyLayers() {
    const v = state.viewer;
    const scene = v.scene;
    const ts = state.tileset;
    if (!ts) layers.elev = "cwt";
    const google = layers.elev === "google3d";
    // Terrain has no surface without imagery, so an overlay is required there.
    if (!google && !OVERLAYS[layers.overlays.cwt]) layers.overlays.cwt = "satLabels";
    const overlay = layers.overlays[layers.elev];

    if (ts) ts.show = google;
    scene.globe.show = !google;
    if (!google && !layers.terrainSet) {
      layers.terrainSet = true;
      scene.globe.depthTestAgainstTerrain = true;
      scene.globe.baseColor = Cesium.Color.fromCssColorString("#0b1020");
      scene.setTerrain(new Cesium.Terrain(worldTerrain()));
    }

    const target = google ? ts.imageryLayers : v.imageryLayers;
    const other = google ? v.imageryLayers : ts && ts.imageryLayers;
    if (other) other.removeAll(false);
    target.removeAll(false);
    if (overlay !== "none") target.add(overlayLayer(google ? "tiles" : "globe", overlay));

    localStorage.setItem("mapLayers.v2", JSON.stringify({ elev: layers.elev, overlays: layers.overlays }));
    document.querySelectorAll("#layersPanel [data-elev]").forEach((b) => b.classList.toggle("active", b.dataset.elev === layers.elev));
    document.querySelectorAll("#layersPanel [data-overlay]").forEach((b) => {
      b.classList.toggle("active", b.dataset.overlay === overlay);
      b.classList.toggle("unavailable", !google && b.dataset.overlay === "none");
    });
    const gBtn = $('#layersPanel [data-elev="google3d"]');
    if (gBtn) gBtn.disabled = !ts;
    if (google && state.selected) computeHeightOffset(state.selected);
    scene.requestRender();
  }

  // Free the camera from tracking without flying, e.g. before jumping to a searched place.
  function freeCamera() {
    if (state.camMode !== "overview") {
      state.camMode = "overview";
      document.querySelectorAll("#camModes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === "overview"));
    }
    cancelNorthUp();
    releaseCamera();
  }

  async function flyToPlace(bbox) {
    const [w, s, e, n] = bbox;
    const rect = Cesium.Rectangle.fromDegrees(w, s, e, n);
    const c = Cesium.Rectangle.center(rect);
    const diag = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromRadians(rect.west, rect.south),
      Cesium.Cartesian3.fromRadians(rect.east, rect.north)
    );
    let height = 0;
    try {
      const [p] = await withTimeout(Cesium.sampleTerrainMostDetailed(await worldTerrain(), [c.clone()]), 3000);
      if (Number.isFinite(p.height)) height = p.height;
    } catch (err) {
      // Fall back to the ellipsoid surface.
    }
    freeCamera();
    const range = Cesium.Math.clamp(diag * 1.15, 1500, 4e6);
    const pitch = diag > 60000 ? -70 : -45;
    state.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, height), 0), {
      duration: 2.4,
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(pitch), range),
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  // ---- compass / north-up
  const compass = { raf: 0, freeLook: false, lastDeg: NaN };

  function updateCompass() {
    const deg = Math.round(Cesium.Math.toDegrees(Cesium.Math.negativePiToPi(state.viewer.camera.heading)) * 10) / 10;
    if (deg === compass.lastDeg) return;
    compass.lastDeg = deg;
    $("#compassRose").setAttribute("transform", `rotate(${-deg} 22 22)`);
    $("#compassBtn").classList.toggle("north", Math.abs(deg) < 0.5);
  }

  function cancelNorthUp() {
    if (!compass.raf) return;
    cancelAnimationFrame(compass.raf);
    compass.raf = 0;
    if (compass.freeLook) state.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  function tween(ms, step, done) {
    const t0 = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      step(t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      if (t < 1) compass.raf = requestAnimationFrame(frame);
      else {
        compass.raf = 0;
        done && done();
      }
    };
    compass.raf = requestAnimationFrame(frame);
  }

  // Heading/pitch/range of the camera looking at a point, from its offset in that point's local frame.
  function hprFromOffset(o) {
    const r = Cesium.Cartesian3.magnitude(o);
    return { h: Math.atan2(-o.x, -o.y), p: Math.asin(Cesium.Math.clamp(-o.z / r, -1, 1)), r };
  }

  function centerPivot() {
    const scene = state.viewer.scene;
    const cam = scene.camera;
    const c = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
    let p;
    if (scene.globe.show) p = scene.globe.pick(cam.getPickRay(c), scene);
    if (!p && scene.pickPositionSupported) {
      try { p = scene.pickPosition(c); } catch (e) { p = undefined; }
    }
    if (!p) p = cam.pickEllipsoid(c);
    if (p && Cesium.Cartesian3.distance(p, cam.positionWC) > 2e7) p = undefined;
    return p;
  }

  function northUp() {
    const v = state.viewer;
    const cam = v.camera;
    cancelNorthUp();
    cam.cancelFlight();
    if (state.camMode === "chase") {
      // Chase follows the aircraft heading; switch to orbit so the view can face north.
      setCamMode("orbit");
      let tries = 0;
      const waitForOrbit = () => {
        const ready = v.trackedEntity && !Cesium.Matrix4.equals(cam.transform, Cesium.Matrix4.IDENTITY);
        if (ready || ++tries > 60) northUp();
        else compass.raf = requestAnimationFrame(waitForOrbit);
      };
      compass.raf = requestAnimationFrame(waitForOrbit);
      return;
    }
    compass.freeLook = false;
    if (v.trackedEntity) {
      const { h, p, r } = hprFromOffset(cam.position);
      const d = Cesium.Math.negativePiToPi(-h);
      tween(700, (k) => cam.lookAtTransform(cam.transform, new Cesium.HeadingPitchRange(h + d * k, p, r)));
      return;
    }
    const pivot = centerPivot();
    if (!pivot) {
      const h = cam.heading, p = cam.pitch, d = Cesium.Math.negativePiToPi(-h);
      tween(700, (k) => cam.setView({ orientation: { heading: h + d * k, pitch: p, roll: 0 } }));
      return;
    }
    const toLocal = Cesium.Matrix4.inverseTransformation(Cesium.Transforms.eastNorthUpToFixedFrame(pivot), new Cesium.Matrix4());
    const { h, p, r } = hprFromOffset(Cesium.Matrix4.multiplyByPoint(toLocal, cam.positionWC, new Cesium.Cartesian3()));
    const d = Cesium.Math.negativePiToPi(-h);
    compass.freeLook = true;
    tween(
      700,
      (k) => cam.lookAt(pivot, new Cesium.HeadingPitchRange(h + d * k, p, r)),
      () => {
        compass.freeLook = false;
        cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }
    );
  }

  // ---- popovers + search
  function setTool(name) {
    ["search", "layers"].forEach((t) => {
      const on = t === name;
      $("#" + t).classList.toggle("open", on);
      $(`#${t}Btn`).setAttribute("aria-expanded", String(on));
    });
    if (name === "search") setTimeout(() => $("#searchInput").focus(), 50);
    else $("#searchInput").blur();
  }
  const openTool = () => document.querySelector("#mapTools .tool.open");

  function wireMapTools() {
    const geo = { ctrl: null, timer: 0, features: [], active: -1 };
    const input = $("#searchInput");
    const list = $("#searchResults");
    const credit = $("#searchCredit");
    const PIN = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 1 7 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 0 1 7-7Zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/></svg>';

    const message = (text) => {
      list.innerHTML = "";
      const li = document.createElement("li");
      li.className = "msg";
      li.textContent = text;
      list.append(li);
    };
    const bboxOf = (f) => {
      if (Array.isArray(f.bbox) && f.bbox.length === 4) return f.bbox;
      const c = f.geometry && f.geometry.coordinates;
      return Array.isArray(c) ? [c[0], c[1], c[0], c[1]] : null;
    };
    const highlight = (i) => {
      geo.active = i;
      [...list.children].forEach((li, j) => li.classList.toggle("active", j === i));
    };

    function render(json) {
      geo.features = (json.features || []).filter(bboxOf);
      geo.active = -1;
      list.innerHTML = "";
      if (!geo.features.length) return message("No places found");
      geo.features.forEach((f, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.innerHTML = PIN;
        const span = document.createElement("span");
        span.textContent = (f.properties && f.properties.label) || "Unnamed place";
        li.append(span);
        li.addEventListener("click", () => choose(i));
        list.append(li);
      });
      // Geocoder attribution (Google) must be shown alongside results.
      const attrs = (json.attributions || []).map((a) => a.html).filter(Boolean);
      credit.innerHTML = attrs.join("");
      credit.classList.toggle("show", attrs.length > 0);
    }

    async function query(kind, text) {
      if (geo.ctrl) geo.ctrl.abort();
      const ctrl = (geo.ctrl = new AbortController());
      const url = `https://api.cesium.com/v1/geocode/${kind}?geocoder=google&text=${encodeURIComponent(text)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${Cesium.Ion.defaultAccessToken}` }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`Geocoder error ${res.status}`);
      return res.json();
    }

    function choose(i) {
      const f = geo.features[i];
      if (!f) return;
      input.value = (f.properties && f.properties.label) || input.value;
      setTool(null);
      collapseSheetOnPhone();
      flyToPlace(bboxOf(f));
    }

    input.addEventListener("input", () => {
      clearTimeout(geo.timer);
      const text = input.value.trim();
      if (text.length < 2) {
        if (geo.ctrl) geo.ctrl.abort();
        list.innerHTML = "";
        credit.classList.remove("show");
        return;
      }
      geo.timer = setTimeout(() => {
        query("autocomplete", text).then(render).catch((e) => e.name !== "AbortError" && message("Search is unavailable right now"));
      }, 250);
    });
    input.addEventListener("keydown", (e) => {
      const n = geo.features.length;
      if (e.key === "ArrowDown" && n) { e.preventDefault(); highlight((geo.active + 1) % n); }
      else if (e.key === "ArrowUp" && n) { e.preventDefault(); highlight((geo.active - 1 + n) % n); }
      else if (e.key === "Escape") { e.preventDefault(); setTool(null); }
    });
    $("#searchForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      clearTimeout(geo.timer);
      if (geo.active >= 0) return choose(geo.active);
      const text = input.value.trim();
      if (!text) return;
      try {
        render(await query("search", text));
        if (geo.features.length) choose(0);
      } catch (err) {
        if (err.name !== "AbortError") message("Search is unavailable right now");
      }
    });
    $("#searchClose").addEventListener("click", () => {
      if (input.value) {
        input.value = "";
        list.innerHTML = "";
        credit.classList.remove("show");
        input.focus();
      } else setTool(null);
    });

    $("#searchBtn").addEventListener("click", () => setTool($("#search").classList.contains("open") ? null : "search"));
    $("#layersBtn").addEventListener("click", () => setTool($("#layers").classList.contains("open") ? null : "layers"));
    document.querySelectorAll("#layersPanel [data-elev]").forEach((b) =>
      b.addEventListener("click", () => {
        layers.elev = b.dataset.elev;
        applyLayers();
      })
    );
    document.querySelectorAll("#layersPanel [data-overlay]").forEach((b) =>
      b.addEventListener("click", () => {
        layers.overlays[layers.elev] = b.dataset.overlay;
        applyLayers();
      })
    );
    $("#compassBtn").addEventListener("click", northUp);

    // Tap/click anywhere else closes popovers; touching the map also cancels a north-up turn.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!e.target.closest("#mapTools")) setTool(null);
        if (e.target === state.viewer.scene.canvas) cancelNorthUp();
      },
      true
    );
    state.viewer.scene.canvas.addEventListener("wheel", cancelNorthUp, { passive: true });
  }

  // ---------------------------------------------------------------- ui
  function wireUi() {
    wireMapTools();
    $("#journeyBtn").addEventListener("click", () => {
      document.documentElement.style.setProperty("--accent", "#4cc9f0");
      collapseSheetOnPhone();
      openJourney();
    });
    $("#playBtn").addEventListener("click", togglePlay);

    // On phones the camera and speed controls collapse to their active button; tapping it cycles.
    const cycleNext = (buttons, b) => buttons[(buttons.indexOf(b) + 1) % buttons.length];
    const camButtons = [...document.querySelectorAll("#camModes button")];
    camButtons.forEach((b) =>
      b.addEventListener("click", () => {
        const next = isPhone() && b.classList.contains("active") ? cycleNext(camButtons, b) : b;
        setCamMode(next.dataset.mode);
      })
    );
    const speedButtons = [...document.querySelectorAll("#speeds button")];
    speedButtons.forEach((b) =>
      b.addEventListener("click", () => {
        const next = isPhone() && b.classList.contains("active") ? cycleNext(speedButtons, b) : b;
        speedButtons.forEach((x) => x.classList.toggle("active", x === next));
        state.viewer.clock.multiplier = Number(next.dataset.speed);
      })
    );

    $("#chartBtn").addEventListener("click", () => {
      $("#chartBtn").classList.toggle("active", document.body.classList.toggle("chart-open"));
    });

    // Bottom sheet: tap the handle to open/close, swipe up to expand, swipe down anywhere to close.
    // The sheet clips its content; never let scrollIntoView scroll the sheet itself.
    const sheet = $("#logbook");
    sheet.addEventListener("scroll", () => (sheet.scrollTop = 0));
    const handle = $("#sheetHandle");

    // Mouse (desktop testing / landscape with a trackpad): handle only.
    let dragY = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") return;
      dragY = e.clientY;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointerup", (e) => {
      if (dragY === null) return;
      const dy = e.clientY - dragY;
      dragY = null;
      if (Math.abs(dy) < 24) stepSheet(0);
      else if (dy < 0) stepSheet(1);
      else closeSheetBy(dy);
    });
    handle.addEventListener("pointercancel", () => (dragY = null));

    function closeSheetBy(dy) {
      // A short pull from full drops to half; a long pull (or any pull from half) closes.
      if (document.body.dataset.sheet === "full" && PORTRAIT_MQ.matches && dy < 220) setSheet("half");
      else setSheet("peek");
    }
    const canScrollUp = (el) => {
      for (; el && el !== sheet; el = el.parentElement) if (el.scrollTop > 0) return true;
      return false;
    };

    // Touch: the whole sheet follows the finger when pulled down.
    let g = null;
    sheet.addEventListener(
      "touchstart",
      (e) => {
        g = null;
        if (!isPhone() || e.touches.length !== 1 || e.target.closest("textarea")) return;
        const t = e.touches[0];
        g = { x: t.clientX, y: t.clientY, dx: 0, dy: 0, axis: null, onHandle: !!e.target.closest("#sheetHandle"), blocked: canScrollUp(e.target) };
      },
      { passive: true }
    );
    sheet.addEventListener(
      "touchmove",
      (e) => {
        if (!g) return;
        const t = e.touches[0];
        g.dx = t.clientX - g.x;
        g.dy = t.clientY - g.y;
        if (!g.axis && Math.hypot(g.dx, g.dy) > 8) g.axis = Math.abs(g.dy) > Math.abs(g.dx) ? "y" : "x";
        if (PORTRAIT_MQ.matches && g.axis === "y" && g.dy > 0 && !g.blocked && document.body.dataset.sheet !== "peek") {
          sheet.classList.add("dragging");
          sheet.style.transform = `translateY(${g.dy}px)`;
        }
      },
      { passive: true }
    );
    const endGesture = () => {
      if (!g) return;
      const { dx, dy, axis, onHandle, blocked } = g;
      g = null;
      sheet.classList.remove("dragging");
      sheet.style.transform = "";
      const open = document.body.dataset.sheet !== "peek";
      if (onHandle && !axis) return stepSheet(0);
      if (LANDSCAPE_MQ.matches) {
        // Side panel: swipe left (or down on the handle) to collapse.
        if (open && ((axis === "x" && dx < -50) || (onHandle && axis === "y" && dy > 30))) setSheet("peek");
        else if (!open && axis) setSheet("full");
        return;
      }
      if (axis !== "y") return;
      if (dy < -30 && (onHandle || !open)) stepSheet(1);
      else if (dy > 50 && open && !blocked) closeSheetBy(dy);
    };
    sheet.addEventListener("touchend", endGesture);
    sheet.addEventListener("touchcancel", () => {
      g = null;
      sheet.classList.remove("dragging");
      sheet.style.transform = "";
    });

    const scrub = $("#scrub");
    let scrubbing = false;
    scrub.addEventListener("pointerdown", (e) => {
      scrubbing = true;
      scrub.setPointerCapture(e.pointerId);
      scrubBarTo(e.clientX);
    });
    scrub.addEventListener("pointermove", (e) => scrubbing && scrubBarTo(e.clientX));
    scrub.addEventListener("pointerup", () => (scrubbing = false));

    const onLayoutChange = () => {
      state.viewer.resolutionScale = renderScale();
      if (!isPhone()) setSheet("peek");
    };
    PORTRAIT_MQ.addEventListener("change", onLayoutChange);
    LANDSCAPE_MQ.addEventListener("change", onLayoutChange);

    chart.canvas = $("#chart");
    chart.ctx = chart.canvas.getContext("2d");
    new ResizeObserver(resizeChart).observe(chart.canvas);
    let dragging = false;
    chart.canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      chart.canvas.setPointerCapture(e.pointerId);
      scrubTo(e.clientX);
    });
    chart.canvas.addEventListener("pointermove", (e) => dragging && scrubTo(e.clientX));
    chart.canvas.addEventListener("pointerup", () => (dragging = false));

    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      const attribution = document.querySelector(".cesium-credit-lightbox-overlay");
      if (attribution && attribution.style.display === "block") {
        if (e.key === "Escape") attribution.querySelector(".cesium-credit-lightbox-close").click();
        return;
      }
      const fl = state.flights;
      const idx = state.selected ? fl.indexOf(state.selected) : -1;
      if (e.key === "/") { e.preventDefault(); setTool("search"); }
      else if (e.key === "n" || e.key === "N") northUp();
      else if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowRight") { if (idx < fl.length - 1) openFlight(fl[idx + 1]); }
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { if (idx > 0) openFlight(fl[idx - 1]); }
      else if (e.key === "Escape") { if (openTool()) setTool(null); else openJourney(); }
    });

    // Leave chase mode when the user grabs the camera.
    const h = new Cesium.ScreenSpaceEventHandler(state.viewer.scene.canvas);
    h.setInputAction(() => {
      if (state.camMode === "chase") setCamMode("orbit");
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    h.setInputAction((movement) => {
      const picked = state.viewer.scene.pick(movement.position);
      if (!picked || !picked.id) return;
      const f = state.flights.find((x) => Object.values(x.entities).includes(picked.id));
      if (f && f !== state.selected) openFlight(f);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    state.viewer.scene.preRender.addEventListener((scene, time) => {
      updateCompass();
      if (!state.selected) {
        updateAircraftModel(time);
        return;
      }
      updateHud(time);
      updateAircraftModel(time);
      updateChaseCamera(time);
      if (state.current.t !== chart.lastT) {
        chart.lastT = state.current.t;
        drawChart();
      }
      const clk = state.viewer.clock;
      if (clk.shouldAnimate && Cesium.JulianDate.greaterThanOrEquals(clk.currentTime, clk.stopTime)) {
        clk.shouldAnimate = false;
        syncPlayButton();
      }
    });
  }

  // ---------------------------------------------------------------- main
  async function main() {
    const token = await resolveToken();
    if (!token) return askForToken(CFG.ionAccessToken ? "The saved Cesium ion token was rejected. Paste a current one to continue." : "");
    Cesium.Ion.defaultAccessToken = token;

    await createViewer();
    applyLayers();
    createAircraft();
    wireUi();

    state.flights = makeFlightStubs(await discoverAssets());
    window.flightJourney = state;
    renderLogbook();
    setTimeout(() => $("#loader").classList.add("done"), 300);

    // Only the latest lesson is downloaded up front; older ones load when opened.
    let first = null;
    for (const f of [...state.flights].reverse()) {
      try {
        first = await ensureLoaded(f);
        break;
      } catch (err) {
        // Try the next most recent lesson.
      }
    }
    if (!first) {
      localStorage.removeItem("ionToken");
      return askForToken("Couldn't load any flights. Make sure the token has access to your flight assets.");
    }

    state.defaultFlight = first;
    selectFlight(first);

    // Download the remaining lessons in the background (kept hidden until requested).
    Promise.allSettled(state.flights.filter((f) => !f.loaded).map(ensureLoaded));

    // Fetch the 3D Skyhawk once the app is interactive.
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
    idle(() => loadAircraftModel(), { timeout: 3000 });
  }

  main().catch((err) => {
    console.error(err);
    $("#loader").classList.add("done");
    toast(`Something went wrong: ${err.message}`, 12000);
  });
})();
