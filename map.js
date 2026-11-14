(() => {
  const view = document.getElementById("map-view");
  if (!view) return;
  const P = () => window.Playoffs;
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "");
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const REGIONS = ["I", "II", "III", "IV"];

  const ui = { mode: "games", scope: "all", when: "week", round: "", region: "", selected: null };
  const markers = new Map();
  let L, map, canvasR, pins, lines, freePopup;
  let shown = false, lastCode = null, reconciling = false, loading = false, pending = null;
  let placed = [], whenOptions = "", touched = false, fitting = false;
  let roundDay = new Map();

  view.innerHTML = `<div class="map-controls">
      <div class="map-seg" role="group" aria-label="What to show on the map">
        <button type="button" data-map-mode="games" aria-pressed="true">Games</button>
        <button type="button" data-map-mode="teams" aria-pressed="false">Teams</button>
      </div>
      <div class="map-seg" role="group" aria-label="Which brackets to show">
        <button type="button" data-map-scope="one" aria-pressed="false">This bracket</button>
        <button type="button" data-map-scope="all" aria-pressed="true">All 12 brackets</button>
      </div>
      <label class="map-field" id="map-when-field">When <select id="map-when"></select></label>
      <label class="map-field">Region <select id="map-region"><option value="">All regions</option>${REGIONS.map((r) => `<option value="${r}">Region ${r}</option>`).join("")}</select></label>
    </div>
    <p id="map-summary" class="map-summary"></p>
    <div class="map-stage"><div id="map-canvas" class="map-canvas">Loading the map…</div><p id="map-empty" class="map-empty" hidden></p></div>
    <div id="map-legend" class="map-legend"></div>
    <div id="map-missing" class="map-missing" hidden></div>`;
  const $ = (s) => view.querySelector(s);

  function loadLeaflet() {
    if (loading) return;
    loading = true;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "vendor/leaflet/leaflet.css";
    const js = document.createElement("script");
    js.src = "vendor/leaflet/leaflet.js";
    const ready = Promise.all([new Promise((r) => (css.onload = css.onerror = r)), new Promise((r, j) => ((js.onload = r), (js.onerror = j)))]);
    ready
      .then(() => {
        L = window.L;
        build();
        shown = true;
        refreshControls();
        layout();
        applyPending();
      })
      .catch(() => ($("#map-canvas").textContent = "The map could not be loaded. Please try again later."));
    document.head.append(css, js);
  }

  const TX = () => L.latLngBounds([25.78, -106.75], [36.56, -93.44]);
  function fitTexas() {
    fitting = true;
    map.fitBounds(TX(), { padding: [4, 4], animate: false });
    fitting = false;
  }

  function build() {
    const canvas = $("#map-canvas");
    canvas.textContent = "";
    map = L.map(canvas, { minZoom: 4, maxZoom: 17, zoomSnap: 0, zoomDelta: 0.75, maxBounds: TX().pad(0.6), maxBoundsViscosity: 0.7, zoomControl: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.control.zoom({ position: "bottomright", zoomInTitle: "Zoom in", zoomOutTitle: "Zoom out" }).addTo(map);
    const Reset = L.Control.extend({
      onAdd() {
        const b = L.DomUtil.create("button", "map-reset");
        b.type = "button";
        b.textContent = "Show all of Texas";
        L.DomEvent.disableClickPropagation(b);
        b.addEventListener("click", () => {
          touched = false;
          fitTexas();
        });
        return b;
      },
    });
    new Reset({ position: "bottomleft" }).addTo(map);
    canvasR = L.canvas({ padding: 0.4 });
    lines = L.layerGroup().addTo(map);
    pins = L.layerGroup().addTo(map);
    fitTexas();
    map.on("zoomend", onZoom);
    map.on("moveend", relabel);
    map.on("dragstart", () => (touched = true));
    map.on("zoomstart", () => !fitting && (touched = true));
    map.on("popupclose", () => !reconciling && select(null));
    map.on("resize", () => {
      for (const m of markers.values()) if (m.getPopup()) Object.assign(m.getPopup().options, popOpts());
      if (!touched) fitTexas();
    });
  }
  const popOpts = (extra = 0) => {
    const w = map.getSize().x - 84;
    return { maxWidth: Math.min(340 + extra, w), minWidth: Math.min(250, w), autoPanPadding: [24, 24] };
  };

  const brackets = () => {
    const s = P().state;
    return ui.scope === "all" ? Object.values(s.data) : [s.data[s.code]].filter(Boolean);
  };
  const currentRound = (b) => b.rounds.find((r) => b.games.some((g) => g.round === r && !g.final)) || b.rounds.at(-1);
  const status = (g) => {
    const s = P().status(g);
    return s === "live" || s === "final" ? s : "upcoming";
  };
  const loser = (g) => {
    const [a, c] = g.teams;
    if (!g.final || a.score == null || c.score == null || a.score === c.score) return null;
    return a.score > c.score ? c.id : a.id;
  };
  const winner = (g) => {
    const l = loser(g);
    return l ? g.teams.findIndex((s) => s.id !== l) : -1;
  };
  const slotName = (s) => (s.id ? s.name : String(s.name).replace(/^Winner G(\d+)$/, "Winner of Game $1"));
  const teamColor = (t) => (/^[0-9a-f]{6}$/i.test(t?.color || "") ? "#" + t.color : "#12355b");
  const mascot = (id) => `https://image.maxpreps.io/school-mascot/${esc(id[0])}/${esc(id[1])}/${esc(id[2])}/${esc(id)}.gif?width=96&height=96&fit=bounds`;

  const fmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  function when(k) {
    if (!k) return "date to be announced";
    const [y, mo, d, h, mi] = k.split(/[-T:]/).map(Number);
    if (!h && !mi) return new Date(y, mo - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " · time to be announced";
    return fmt.format(new Date(y, mo - 1, d, h, mi));
  }

  // Days, in the reader's words. Dates are Central-time civil dates, like the rest of the site.
  const chicagoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayNum = (k) => {
    const [y, m, d] = k.split("-").map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 864e5);
  };
  const today = () => dayNum(chicagoDay.format(new Date()));
  function dayWord(k) {
    if (!k) return "day not posted";
    const diff = dayNum(k) - today();
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff === -1) return "yesterday";
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  }

  // A game with no kickoff that is already final still happened: borrow the day its round was played
  // statewide, so a finished round does not vanish from a time window.
  function buildRoundDays() {
    const by = new Map();
    for (const b of Object.values(P().state.data))
      for (const g of b.games)
        if (g.kickoff) (by.get(g.round) || by.set(g.round, []).get(g.round)).push(g.kickoff.slice(0, 10));
    roundDay = new Map([...by].map(([r, ds]) => [r, ds.sort()[Math.floor(ds.length / 2)]]));
  }
  const gameDay = (g) => (g.kickoff ? g.kickoff.slice(0, 10) : g.final ? roundDay.get(g.round) || null : null);

  function inWhen(g, b) {
    if (ui.when === "round") return g.round === ui.round;
    if (ui.when === "next") return g.round === currentRound(b);
    const k = gameDay(g);
    if (!k) return false;
    const diff = dayNum(k) - today();
    return ui.when === "today" ? diff === 0 || diff === 1 : diff >= -2 && diff <= 6;
  }
  const whenWord = () =>
    ui.when === "today" ? "today and tomorrow" : ui.when === "week" ? "this week" : ui.when === "next" ? "the next round" : ui.round;
  const whenPhrase = () =>
    ui.when === "today" ? "today or tomorrow" : ui.when === "week" ? "this week" : ui.when === "next" ? "in the next round" : "in " + ui.round;

  function miles(a, b) {
    const d = Math.PI / 180;
    const h = Math.sin(((b[0] - a[0]) * d) / 2) ** 2 + Math.cos(a[0] * d) * Math.cos(b[0] * d) * Math.sin(((b[1] - a[1]) * d) / 2) ** 2;
    return 2 * 3958.8 * Math.asin(Math.sqrt(h));
  }
  const school = (b, s) => {
    const t = s.id && b.teams?.[s.id];
    return t && isNum(t.lat) && isNum(t.lon) ? t : null;
  };
  const tripText = (t, it) => {
    const mi = miles([t.lat, t.lon], [it.lat, it.lon]);
    return mi < 2 ? "home town" : `${Math.round(mi)} miles to the game`;
  };

  function gameItems() {
    const out = [], missing = [];
    for (const b of brackets())
      for (const g of b.games) {
        if (!inWhen(g, b) || (ui.region && g.region !== ui.region)) continue;
        const it = { key: "g:" + g.id, kind: "game", g, b, status: status(g), day: gameDay(g), lat: g.lat, lon: g.lon };
        (isNum(g.lat) && isNum(g.lon) ? out : missing).push(it);
      }
    return { out, missing };
  }

  function teamItems() {
    const out = [], missing = [];
    for (const b of brackets()) {
      const seen = new Map();
      for (const g of b.games)
        for (const s of g.teams) {
          if (!s.id) continue;
          if (!seen.has(s.id)) seen.set(s.id, { id: s.id, name: s.name, record: s.record, games: [] });
          seen.get(s.id).games.push(g);
        }
      for (const t of seen.values()) {
        const info = b.teams?.[t.id] || {};
        const region = info.region || t.games.find((g) => g.region)?.region || null;
        if (ui.region && region !== ui.region) continue;
        t.games.sort((x, y) => b.rounds.indexOf(x.round) - b.rounds.indexOf(y.round));
        const last = [...t.games].reverse().find((g) => g.final);
        const next = t.games.find((g) => !g.final);
        const lost = !!last && loser(last) === t.id;
        const champ = !!last && !lost && !!loser(last) && last.round === b.rounds.at(-1);
        const it = { key: "t:" + t.id, kind: "team", t, info, b, alive: !lost, champ, last, next, loose: info.loc === "town", lat: info.lat, lon: info.lon };
        (isNum(info.lat) && isNum(info.lon) ? out : missing).push(it);
      }
    }
    return { out, missing };
  }

  const itemClass = (it) => (it.kind === "game" ? it.status : it.champ ? "champ" : it.alive ? "alive" : "out");
  const stackClass = (list) =>
    list[0].kind === "game"
      ? list.some((i) => i.status === "live") ? "live" : list.some((i) => i.status === "upcoming") ? "upcoming" : "final"
      : list.some((i) => i.champ) ? "champ" : list.some((i) => i.alive) ? "alive" : "out";
  const labelText = (it) => (it.kind === "game" ? it.g.teams.map(slotName).join(" v ") : it.t.name);

  const divIcon = (w, sel) =>
    L.divIcon({
      className: `mk ${w.cls}${w.html ? " stack" : ""}${String(w.html).length > 2 ? " wide" : ""}${sel ? " sel" : ""}`,
      html: w.html || "",
      iconSize: [w.size, w.size],
      iconAnchor: [w.size / 2, w.size / 2],
      popupAnchor: [0, -w.size / 2 - 2],
      tooltipAnchor: [0, 0],
    });

  const dotRadius = () => (map.getZoom() >= 9.5 ? 8 : map.getZoom() >= 7.5 ? 6 : 4.5);
  // Pins and count bubbles grow with the zoom, so a statewide view does not turn into one blob.
  const pinSize = () => (map.getZoom() >= 9.5 ? 34 : map.getZoom() >= 7.5 ? 30 : 24);
  const stackSize = (n) => pinSize() + (n < 10 ? 0 : n < 100 ? 6 : 12);
  function dotStyle(it, sel) {
    const r = dotRadius();
    const on = it.alive || it.champ;
    const fill = it.champ ? "#b07c00" : it.alive ? (it.loose ? "#8fb4de" : "#15509a") : "#ffffff";
    return {
      radius: sel ? r + 3 : r,
      color: sel ? "#9a6400" : on ? "#ffffff" : it.loose ? "#96a3ad" : "#4a5b6a",
      weight: sel ? 4 : on ? 1.5 : it.loose ? 1.5 : 2.5,
      opacity: 1,
      fillColor: fill,
      fillOpacity: on ? 1 : it.loose ? 0.5 : 1,
    };
  }

  function layout() {
    if (!map) return;
    buildRoundDays();
    const { out, missing } = ui.mode === "games" ? gameItems() : teamItems();
    placed = out;
    if (ui.selected && !out.some((i) => i.key === ui.selected)) ui.selected = null;
    const groups = new Map();
    for (const it of out) {
      const k = `${it.lat.toFixed(4)},${it.lon.toFixed(4)}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(it);
    }
    const want = new Map();
    for (const [k, list] of groups) {
      if (list.length === 1) {
        const it = list[0];
        want.set(
          it.key,
          it.kind === "game"
            ? { type: "pin", latlng: [it.lat, it.lon], cls: itemClass(it), size: pinSize(), item: it, z: it.status === "live" ? 1000 : 0 }
            : { type: "dot", latlng: [it.lat, it.lon], cls: itemClass(it), item: it, z: 0 },
        );
      } else {
        const n = list.length;
        want.set(`p:${k}`, { type: "stack", latlng: [list[0].lat, list[0].lon], html: String(n), cls: stackClass(list), size: stackSize(n), items: list, z: 600 });
      }
    }
    reconcile(want);
    if (freePopup?.isOpen() && ui.selected) {
      const it = out.find((i) => i.key === ui.selected);
      if (it) freePopup.setContent(popupHtml(it));
    }
    summary(out, missing);
    legend(out);
    missingList(missing);
    emptyNote(out, missing);
    drawLines();
    relabel();
  }

  function reconcile(want) {
    reconciling = true;
    for (const [k, m] of markers)
      if (!want.has(k)) {
        pins.removeLayer(m);
        markers.delete(k);
      }
    for (const [k, w] of want) {
      const sel = k === ui.selected;
      let m = markers.get(k);
      if (!m) {
        if (w.type === "dot") {
          m = L.circleMarker(w.latlng, { ...dotStyle(w.item, sel), renderer: canvasR, bubblingMouseEvents: false });
        } else {
          const title = w.item ? labelText(w.item) : `${w.items.length} ${ui.mode === "games" ? "games" : "schools"} at the same spot`;
          m = L.marker(w.latlng, { icon: divIcon(w, sel), zIndexOffset: w.z, title });
        }
        m._w = { ...w, sel };
        m.bindPopup((layer) => (layer._w.item ? popupHtml(layer._w.item) : listHtml(layer._w)), popOpts(w.type === "stack" ? 20 : 0));
        if (w.item) m.on("popupopen", () => ui.selected !== k && select(k));
        pins.addLayer(m);
        markers.set(k, m);
      } else {
        const prev = m._w;
        m._w = { ...w, sel, label: prev.label };
        if (w.type === "dot") {
          if (w.cls !== prev.cls || sel !== prev.sel || w.item.loose !== prev.item.loose) m.setStyle(dotStyle(w.item, sel));
        } else {
          if (w.cls !== prev.cls || w.html !== prev.html || w.size !== prev.size || sel !== prev.sel) m.setIcon(divIcon(w, sel));
          if (w.z !== prev.z) m.setZIndexOffset(w.z);
        }
        if (m.isPopupOpen()) m.getPopup().update();
      }
    }
    const m = ui.selected && markers.get(ui.selected);
    if (m && !m.isPopupOpen()) m.openPopup();
    reconciling = false;
  }

  // Names only where they can be read: close in, and only for what is on screen.
  function relabel() {
    if (!map) return;
    const on = map.getZoom() >= 9;
    const vb = on ? map.getBounds().pad(-0.04) : null;
    const edge = map.getSize().x * 0.55;
    let budget = 60;
    for (const m of markers.values()) {
      const w = m._w;
      const want = on && w.item && budget > 0 && vb.contains(m.getLatLng()) ? labelText(w.item) : null;
      if (want) budget--;
      // Names near the right edge read inwards, so they are not cut off.
      const dir = want && map.latLngToContainerPoint(m.getLatLng()).x > edge ? "left" : "right";
      if (want === (w.label ?? null) && dir === w.labelDir) continue;
      if (!want) m.unbindTooltip();
      else if (m.getTooltip() && dir === w.labelDir) m.setTooltipContent(esc(want));
      else {
        const dx = (w.size ? w.size / 2 : dotRadius()) + 5;
        m.unbindTooltip();
        m.bindTooltip(esc(want), { permanent: true, direction: dir, offset: [dir === "left" ? -dx : dx, 0], className: "mk-label" });
      }
      w.label = want;
      w.labelDir = want ? dir : null;
    }
  }

  function onZoom() {
    for (const m of markers.values()) {
      const w = m._w;
      if (w.type === "dot") m.setStyle(dotStyle(w.item, w.sel));
      else {
        const size = w.items ? stackSize(w.items.length) : pinSize();
        if (size !== w.size) {
          w.size = size;
          m.setIcon(divIcon(w, w.sel));
        }
      }
    }
    relabel();
  }

  function select(k) {
    const prev = ui.selected;
    if (prev === k) return;
    ui.selected = k;
    for (const key of [prev, k]) {
      const m = key && markers.get(key);
      if (!m) continue;
      m._w.sel = key === k;
      if (m._w.type === "dot") m.setStyle(dotStyle(m._w.item, m._w.sel));
      else m.setIcon(divIcon(m._w, m._w.sel));
    }
    drawLines();
  }

  function drawLines() {
    lines.clearLayers();
    const it = ui.selected && placed.find((i) => i.key === ui.selected);
    if (!it || it.kind !== "game") return;
    for (const s of it.g.teams) {
      const t = school(it.b, s);
      if (!t) continue;
      const color = teamColor(t);
      const path = [[t.lat, t.lon], [it.lat, it.lon]];
      L.polyline(path, { color: "#fff", weight: 8, opacity: 0.9, interactive: false }).addTo(lines);
      L.polyline(path, { color, weight: 4, dashArray: "10 10", interactive: false }).addTo(lines);
      L.circleMarker([t.lat, t.lon], { radius: 10, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 })
        .bindTooltip(`${esc(s.name)}: ${esc(tripText(t, it))}`, { permanent: true, direction: "top", offset: [0, -10], className: "mk-label" })
        .addTo(lines);
    }
  }

  function listHtml(w) {
    const items = w.items;
    const noun = ui.mode === "games" ? "games" : "schools";
    const towns = new Set(items.map((i) => (i.kind === "game" ? i.g.town : i.info.city)).filter(Boolean));
    const rows = items
      .map((it) => {
        const text =
          it.kind === "game"
            ? `${esc(it.g.teams.map((s, i) => `${slotName(s)}${scoreOf(it, i) === "" ? "" : " " + scoreOf(it, i)}`).join(" · "))}` +
              `<small>${esc(ui.scope === "all" ? it.b.label + " · " : "")}${esc(statusWord(it))}</small>`
            : `${esc(it.t.name)}<small>${esc(it.alive ? (it.champ ? "State champion" : "Still playing") : "Knocked out")}${esc(ui.scope === "all" ? " · " + it.b.label : "")}</small>`;
        return `<li><button type="button" data-map-select="${esc(it.key)}"><i class="mk ${it.kind === "game" ? itemClass(it) : "dot " + itemClass(it) + (it.loose ? " town" : "")}"></i><span>${text}</span></button></li>`;
      })
      .join("");
    return `<p class="pop-crumb">${items.length} ${noun} at this spot${towns.size === 1 ? " · " + esc([...towns][0]) : ""}. Tap one.</p><ul class="pop-list">${rows}</ul>`;
  }

  function pickFromList(key) {
    const it = placed.find((i) => i.key === key);
    if (!it) return;
    const m = markers.get(key);
    if (m) return m.openPopup();
    const at = freePopup?.isOpen() ? freePopup.getLatLng() : [it.lat, it.lon];
    freePopup = L.popup(popOpts()).setLatLng(at).setContent(popupHtml(it)).openOn(map);
    select(key);
  }

  function fitTrip(key) {
    const it = placed.find((i) => i.key === key);
    if (!it) return;
    const pts = [[it.lat, it.lon]];
    for (const s of it.g.teams) {
      const t = school(it.b, s);
      if (t) pts.push([t.lat, t.lon]);
    }
    const open = [markers.get(key)?.getPopup(), freePopup].find((p) => p?.isOpen());
    if (open) map.once("moveend", () => open.update());
    touched = true;
    map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 13 });
  }

  const scoreOf = (it, i) => {
    const v = it.status === "live" && it.g.live?.scores ? it.g.live.scores[i] : it.g.teams[i].score;
    return v == null ? "" : String(v);
  };
  const statusWord = (it) =>
    it.status === "live"
      ? `Playing now${it.g.live?.period ? " · " + it.g.live.period : ""}`
      : it.status === "final"
        ? `Final${it.day ? " · " + dayWord(it.day) : ""}`
        : it.g.kickoff
          ? `Kickoff: ${when(it.g.kickoff)}`
          : "Kickoff time not posted yet";
  const popupHtml = (it) => (it.kind === "game" ? gamePopup(it) : teamPopup(it));

  function gamePopup(it) {
    const { g, b, status: st } = it;
    const w = winner(g);
    const trip = g.teams.filter((s) => s.id).map((s) => {
      const t = school(b, s);
      return `${esc(s.name)}: ${t ? esc(tripText(t, it)) : "distance unknown"}`;
    });
    const canFit = g.teams.some((s) => school(b, s));
    const loose = g.venue_exact === false || g.loc === "town";
    return `<p class="pop-crumb">${ui.scope === "all" ? esc(b.label) + " · " : ""}${esc(g.round)}${g.num ? " · " + esc(String(g.num).replace("G", "Game ")) : ""}</p>
      <p class="pop-where"><b>${esc(P().where(g))}</b>${loose ? "<small>Marker is at the town, not the stadium.</small>" : ""}</p>
      <p class="pop-status ${st}">${esc(statusWord(it))}</p>
      <div class="pop-teams">${g.teams.map((s, i) => `<div class="${i === w ? "won" : ""}"><span>${esc(slotName(s))}</span><b>${esc(scoreOf(it, i))}</b></div>`).join("")}</div>
      ${trip.length ? `<p class="pop-travel">${trip.join("<br>")}</p>` : ""}
      <div class="pop-actions">
        <button class="btn" type="button" data-game="${esc(g.id)}">Full details</button>
        <button class="btn" type="button" data-game="${esc(g.id)}" data-go="1">Show in bracket</button>
        ${canFit ? `<button class="btn" type="button" data-map-fit="${esc(it.key)}">Show the whole trip</button>` : ""}
      </div>`;
  }

  function teamPopup(it) {
    const { t, info, b, alive, champ, last, next, loose } = it;
    const other = (g) => g.teams.find((s) => s.id !== t.id);
    const result = (g) => {
      const me = g.teams.find((s) => s.id === t.id), op = other(g);
      if (me.score == null || op.score == null) return "Final";
      return `${me.score > op.score ? "Won" : me.score < op.score ? "Lost" : "Tied"} ${me.score}-${op.score}`;
    };
    const gameLine = next
      ? `Next game: ${esc(when(next.kickoff))} · vs ${esc(slotName(other(next)))} · ${esc(P().where(next))}`
      : last
        ? `Last game: ${esc(result(last))} vs ${esc(slotName(other(last)))} (${esc(last.round)})`
        : "Next game not posted yet.";
    const game = next || last;
    return `<div class="pop-head" style="border-color:${teamColor(info)}"><img src="${safeUrl(info.logo) || mascot(t.id)}" alt="" loading="lazy" onerror="this.hidden=true"><div><b>${esc(t.name)} ${esc(info.mascot || "")}</b><span>${esc(info.city ? info.city + ", Texas" : "")}${t.record ? ` · ${esc(t.record)}` : ""}</span></div></div>
      <p class="pop-status ${alive ? "alive" : "out"}">${champ ? "State champion" : alive ? "Still playing" : `Knocked out in the ${esc(last.round)} round`} · ${esc(b.label)}</p>
      <p>${gameLine}</p>
      ${loose ? `<p class="pop-note">Shown at the town centre.</p>` : ""}
      <div class="pop-actions">
        <button class="btn" type="button" data-team="${esc(t.id)}">Team details</button>
        ${game ? `<button class="btn" type="button" data-game="${esc(game.id)}" data-go="1">Show in bracket</button>` : ""}
      </div>`;
  }

  function summary(out, missing) {
    const s = P().state, b = s.data[s.code];
    const scope = ui.scope === "all" ? "All 12 brackets" : b ? b.label : "";
    const total = out.length + missing.length;
    let text;
    if (ui.mode === "games") {
      const n = { live: 0, final: 0, upcoming: 0 };
      out.forEach((i) => n[i.status]++);
      missing.forEach((i) => n[i.status]++);
      text = `${scope} · ${whenWord()}: ${total} game${total === 1 ? "" : "s"} — ${n.live} playing now, ${n.final} final, ${n.upcoming} not started yet.`;
      if (out.length) text += ` ${out.length} ${out.length === 1 ? "is" : "are"} on the map.`;
    } else {
      const alive = out.filter((i) => i.alive).length;
      text = `${scope}: ${out.length} school${out.length === 1 ? "" : "s"} on the map — ${alive} still playing, ${out.length - alive} knocked out.`;
    }
    if (ui.region) text += ` Region ${ui.region} only.`;
    if (missing.length)
      text += ` ${missing.length} ${missing.length === 1 ? "has" : "have"} no ${ui.mode === "games" ? "place" : "location"} yet — listed under the map.`;
    $("#map-summary").textContent = text;
  }

  function legend(out) {
    const dot = (cls, txt, n = "") => `<span><i class="mk ${cls}">${n}</i>${txt}</span>`;
    $("#map-legend").innerHTML =
      ui.mode === "games"
        ? dot("live", "Playing now") + dot("final", "Final") + dot("upcoming", "Not started yet") + dot("upcoming stack", "Several games at the same spot — tap for the list", "3")
        : dot("dot alive", "Still playing") +
          dot("dot out", "Knocked out") +
          (out.some((i) => i.loose) ? dot("dot alive town", "Shown at the town centre") : "") +
          dot("alive stack", "Several schools at the same spot — tap for the list", "3");
  }

  function missingList(missing) {
    const d = $("#map-missing");
    d.hidden = !missing.length;
    if (!missing.length) return;
    const one = missing.length === 1;
    const head =
      ui.mode === "games"
        ? `${missing.length} game${one ? "" : "s"} ${whenPhrase()} ${one ? "has" : "have"} no place on the map yet.`
        : `${missing.length} school${one ? "" : "s"} ${one ? "has" : "have"} no location yet.`;
    const rows = missing
      .map((it) =>
        it.kind === "game"
          ? `<li><button class="plain" type="button" data-game="${esc(it.g.id)}">${esc(labelText(it))}<small>${ui.scope === "all" ? esc(it.b.label) + " · " : ""}${esc(it.g.round)} · ${esc(it.g.kickoff ? dayWord(it.g.kickoff.slice(0, 10)) : "day not posted")} · ${esc(it.g.site_note || P().where(it.g) || "Location not posted")}</small></button></li>`
          : `<li><button class="plain" type="button" data-team="${esc(it.t.id)}">${esc(it.t.name)}<small>${esc(it.info.city || "Town not known")}${ui.scope === "all" ? " · " + esc(it.b.label) : ""}</small></button></li>`,
      )
      .join("");
    const open = d.querySelector("details")?.open;
    d.innerHTML =
      missing.length <= 12
        ? `<h3>${esc(head)}</h3><ul>${rows}</ul>`
        : `<details${open ? " open" : ""}><summary>${esc(head)} Tap to see them.</summary><ul>${rows}</ul></details>`;
  }

  function emptyNote(out, missing) {
    const el = $("#map-empty");
    const show = !out.length;
    el.hidden = !show;
    if (!show) return;
    if (ui.mode === "teams") {
      el.textContent = missing.length
        ? `None of these ${missing.length} schools has a location yet, so the map is empty. They are listed under the map.`
        : "No schools to show here. Try All 12 brackets, or a different region.";
      return;
    }
    el.textContent = !missing.length
      ? `No games ${whenPhrase()}. Try “This week” or “Next round” in the When box above.`
      : `None of these ${missing.length} games has a place yet, so the map is empty. They are listed under the map.`;
  }

  function refreshControls() {
    view.querySelectorAll("[data-map-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mapMode === ui.mode)));
    view.querySelectorAll("[data-map-scope]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mapScope === ui.scope)));
    $("#map-when-field").hidden = ui.mode !== "games";
    const rounds = [];
    for (const x of brackets()) for (const r of x.rounds) if (!rounds.includes(r)) rounds.push(r);
    const opts =
      `<option value="today">Today and tomorrow</option><option value="week">This week</option><option value="next">Next round</option>` +
      `<optgroup label="Pick a round">${rounds.map((r) => `<option value="r:${esc(r)}">${esc(r)}</option>`).join("")}</optgroup>`;
    if (opts !== whenOptions) {
      whenOptions = opts;
      $("#map-when").innerHTML = opts;
    }
    if (ui.when === "round" && !rounds.includes(ui.round)) ui.when = "week";
    $("#map-when").value = ui.when === "round" ? "r:" + ui.round : ui.when;
    $("#map-region").value = ui.region;
  }

  function reset() {
    if (!map) return;
    map.closePopup();
    select(null);
    refreshControls();
    layout();
  }

  view.addEventListener("click", (e) => {
    const el = e.target.closest("[data-map-mode],[data-map-scope],[data-map-select],[data-map-fit]");
    if (!el) return;
    const d = el.dataset;
    if (d.mapSelect) return map && pickFromList(d.mapSelect);
    if (d.mapFit) return map && fitTrip(d.mapFit);
    if (d.mapMode) ui.mode = d.mapMode;
    else ui.scope = d.mapScope;
    reset();
  });
  $("#map-when").addEventListener("change", (e) => {
    const v = e.target.value;
    ui.when = v.startsWith("r:") ? "round" : v;
    ui.round = v.startsWith("r:") ? v.slice(2) : "";
    reset();
  });
  $("#map-region").addEventListener("change", (e) => {
    ui.region = e.target.value;
    reset();
  });

  document.addEventListener("playoffs:render", () => {
    const s = P()?.state;
    if (!s) return;
    if (s.view !== "map" || view.hidden) {
      shown = false;
      return;
    }
    if (s.code !== lastCode) {
      const changed = lastCode !== null;
      lastCode = s.code;
      if (changed && ui.scope === "one" && map) {
        map.closePopup();
        select(null);
      }
    }
    if (!L) return loadLeaflet();
    if (!shown) {
      shown = true;
      map.invalidateSize({ pan: false });
      if (!touched) fitTexas();
    }
    refreshControls();
    layout();
  });

  function applyPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (p.center) {
      touched = true;
      map.setView(p.center, p.zoom ?? map.getZoom(), { animate: false });
    } else if (p.zoom) {
      touched = true;
      map.setZoom(p.zoom, { animate: false });
    }
    if (p.select) pickFromList(p.select);
  }

  window.PlayoffsMap = {
    set(o = {}) {
      if (o.mode) ui.mode = o.mode;
      if (o.scope) ui.scope = o.scope;
      if (o.when) {
        ui.when = o.when;
        ui.round = "";
      }
      if (o.round) {
        ui.when = "round";
        ui.round = o.round;
      }
      if (o.region !== undefined) ui.region = o.region;
      pending = { center: o.center, zoom: o.zoom, select: o.select };
      if (map) {
        refreshControls();
        layout();
        applyPending();
      }
    },
  };
})();
