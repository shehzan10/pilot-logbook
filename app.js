(() => {
  "use strict";

  const CFG = Object.assign(
    { ionAccessToken: "", tailNumber: "N16237", flightAssetIds: [], pplTargetHours: 40 },
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
  const state = {
    viewer: null,
    tileset: null,
    flights: [],
    selected: null,
    camMode: "overview",
    aircraft: null,
    current: { alt: 0, spd: 0, vs: 0, hdg: 0, idx: 0 },
    chaseHeading: undefined,
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
  function resolveToken() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("token");
    if (fromUrl) {
      localStorage.setItem("ionToken", fromUrl);
      params.delete("token");
      history.replaceState(null, "", location.pathname + (params.toString() ? `?${params}` : ""));
      return fromUrl;
    }
    return CFG.ionAccessToken || localStorage.getItem("ionToken") || "";
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
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
    viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

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
      const url = `https://api.cesium.com/v1/assets?search=${encodeURIComponent(CFG.tailNumber)}&limit=1000`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${Cesium.Ion.defaultAccessToken}` } });
      if (res.ok) {
        const json = await res.json();
        for (const a of json.items || []) {
          if (a.name && a.name.startsWith(CFG.tailNumber) && a.status === "COMPLETE") ids.set(a.id, a.name);
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

  const fmtDate = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  // Flights are placeholders until their KML is fetched (on demand, newest first).
  function makeFlightStubs(assets) {
    const stubs = assets.map((a) => ({ id: a.id, name: a.name, nameDate: dateFromName(a.name), loaded: false, entities: {} }));
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
          const { lesson, color, css } = f;
          Object.assign(f, data, { lesson, color, css, entities: {} });
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
      name: asset.name || ds.name || `${CFG.tailNumber} flight`,
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
    if (!state.tileset || f.offsetComputed) return;
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

  function applyStyles() {
    const sel = state.selected;
    for (const f of state.flights) {
      const on = !sel || sel === f;
      const e = f.entities;
      if (!e.line) continue;
      e.line.polyline.width = sel === f ? 6 : on ? 5 : 3;
      e.line.polyline.material = new Cesium.PolylineGlowMaterialProperty({
        color: on ? f.color : f.color.withAlpha(0.3),
        glowPower: sel === f ? 0.25 : 0.2,
      });
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
    const range = Math.max(sphere.radius * scale, 2500);
    state.viewer.camera.flyToBoundingSphere(sphere, {
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
      flyToSphere(f.bounds, -42, state.current.hdg - 30, 2.4);
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
    const target = Cesium.Math.toRadians(state.current.hdg);
    if (state.chaseHeading === undefined) state.chaseHeading = target;
    let d = Cesium.Math.negativePiToPi(target - state.chaseHeading);
    state.chaseHeading += d * 0.04;
    state.viewer.camera.lookAt(pos, new Cesium.HeadingPitchRange(state.chaseHeading, Cesium.Math.toRadians(-12), CHASE_RANGE));
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

    const loaded = state.flights.filter((f) => f.loaded);
    if (!loaded.length) return;
    const latest = loaded[loaded.length - 1];
    v.clock.currentTime = Cesium.JulianDate.addSeconds(latest.start, latest.duration / 2, new Cesium.JulianDate());
    const all = Cesium.BoundingSphere.fromBoundingSpheres(loaded.map((f) => f.bounds));
    flyToSphere(all, -48, 20, 2.8);
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
    if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });

    $("#playerTitle").textContent = `Lesson ${f.lesson} · ${f.dateLabel}${f.route ? " · " + f.route : ""}`;
    document.documentElement.style.setProperty("--accent", f.css);
    ["#player", "#hud", "#camModes"].forEach((s) => $(s).classList.remove("hidden"));
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
      spd: a.spd + (b.spd - a.spd) * u,
      vs: a.vs + (b.vs - a.vs) * u,
      hdg: (a.hdg + Cesium.Math.toDegrees(dh) * u + 360) % 360,
    };
  }

  function updateHud(time) {
    const f = state.selected;
    if (!f) return;
    const c = (state.current = stateAt(f, time));
    $("#hudAlt").textContent = c.ground ? "GND" : fmtNum(Math.round((c.alt * M_TO_FT) / 10) * 10);
    $("#hudAlt").nextElementSibling.style.visibility = c.ground ? "hidden" : "";
    $("#hudSpd").textContent = fmtNum(c.spd * MS_TO_KT);
    const vs = Math.round((c.vs * M_TO_FT * 60) / 10) * 10;
    $("#hudVs").textContent = (vs > 0 ? "+" : "") + fmtNum(vs);
    $("#hudHdg").textContent = String(Math.round(c.hdg) % 360).padStart(3, "0");
    $("#clockTime").textContent = Cesium.JulianDate.toDate(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("#elapsed").textContent = `${fmtDuration(c.t, true)} / ${fmtDuration(f.duration, true)}`;
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
    const lo = Math.floor((f.minAlt * M_TO_FT) / 500) * 500;
    const hi = Math.ceil((f.maxAlt * M_TO_FT * 1.05) / 500) * 500 || lo + 500;
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
    for (let i = 0; i < s.length; i += k) ctx.lineTo(x(s[i].t), y(s[i].h * M_TO_FT));
    ctx.lineTo(x(f.duration), pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < s.length; i += k) ctx[i ? "lineTo" : "moveTo"](x(s[i].t), y(s[i].h * M_TO_FT));
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
    ctx.arc(cx, y(c.alt * M_TO_FT), 5, 0, Math.PI * 2);
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
    $("#tailLabel").textContent = CFG.tailNumber;
    $("#statFlights").textContent = fl.length;
    $("#statHours").textContent = `${hours.toFixed(1)}h${more}`;
    $("#statDistance").textContent = ld.length ? fmtNum(ld.reduce((a, f) => a + f.distance, 0) * M_TO_NM) + more : "–";
    $("#statAlt").textContent = ld.length ? fmtNum(Math.max(...ld.map((f) => f.maxAlt)) * M_TO_FT, 0) + more : "–";
    $("#progressText").textContent = `${hours.toFixed(1)}${more} / ${CFG.pplTargetHours} hrs`;
    requestAnimationFrame(() => {
      $("#progressFill").style.width = `${Math.min(100, (hours / CFG.pplTargetHours) * 100)}%`;
    });

    const longest = ld.reduce((a, f) => (f.duration > (a ? a.duration : 0) ? f : a), null);
    const highest = ld.reduce((a, f) => (f.maxAlt > (a ? a.maxAlt : -Infinity) ? f : a), null);
    const farthest = ld.reduce((a, f) => (f.maxFromStart > (a ? a.maxFromStart : 0) ? f : a), null);
    const multi = ld.length > 1;

    const list = $("#flightList");
    const scroll = list.scrollTop;
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
      card.className = `flight-card${f.loaded ? "" : " unloaded"}${f.loading ? " loading" : ""}${state.selected === f ? " active" : ""}`;
      card.dataset.id = f.id;
      card.style.setProperty("--c", f.css);
      card.innerHTML = `
        <div class="node"></div>
        <div class="card-body">
          <div class="card-top">
            <div>
              <div class="lesson">Lesson ${f.lesson}</div>
              <div class="card-date">${f.dateLabel}</div>
              <div class="card-route">${f.loaded ? f.route || f.timeLabel : status}</div>
            </div>
            ${f.loaded ? `<span class="tag">${f.type}</span>` : ""}
          </div>
          <div class="chips">
            <div class="chip"><b>${f.loaded ? fmtDuration(f.duration) : "–"}</b>Duration</div>
            <div class="chip"><b>${f.loaded ? fmtNum(f.distance * M_TO_NM, 1) : "–"}</b>nm</div>
            <div class="chip"><b>${f.loaded ? fmtNum(f.maxAlt * M_TO_FT) : "–"}</b>ft max</div>
          </div>
          ${f.loaded ? sparkline(f) : `<div class="spark spark-placeholder"></div>`}
          ${badges.length ? `<div class="badges">${badges.map((b) => `<span class="badge">${b}</span>`).join("")}</div>` : ""}
          <div class="notes"><textarea placeholder="What did you practice? Notes from your instructor…"></textarea></div>
        </div>`;
      const ta = card.querySelector("textarea");
      ta.value = localStorage.getItem(`note-${f.id}`) || "";
      ta.addEventListener("input", () => localStorage.setItem(`note-${f.id}`, ta.value));
      ta.addEventListener("click", (e) => e.stopPropagation());
      card.querySelector(".card-body").addEventListener("click", () => {
        if (state.selected !== f) openFlight(f);
      });
      list.appendChild(card);
    }
    list.scrollTop = scroll;
  }

  // ---------------------------------------------------------------- wiring
  function wireUi() {
    $("#journeyBtn").addEventListener("click", () => {
      document.documentElement.style.setProperty("--accent", "#4cc9f0");
      openJourney();
    });
    $("#playBtn").addEventListener("click", togglePlay);
    document.querySelectorAll("#camModes button").forEach((b) => b.addEventListener("click", () => setCamMode(b.dataset.mode)));
    document.querySelectorAll("#speeds button").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("#speeds button").forEach((x) => x.classList.toggle("active", x === b));
        state.viewer.clock.multiplier = Number(b.dataset.speed);
      })
    );

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
      const fl = state.flights;
      const idx = state.selected ? fl.indexOf(state.selected) : -1;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowRight") { if (idx < fl.length - 1) openFlight(fl[idx + 1]); }
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { if (idx > 0) openFlight(fl[idx - 1]); }
      else if (e.key === "Escape") { state.pending = null; showJourney(); }
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
    const token = resolveToken();
    if (!token) return askForToken();
    Cesium.Ion.defaultAccessToken = token;

    await createViewer();
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
      return askForToken("Couldn't load any flights. Make sure the token has access to your N16237 assets.");
    }

    showJourney();

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
