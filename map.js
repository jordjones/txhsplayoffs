(() => {
  const view = document.getElementById("map-view");
  if (!view) return;
  const P = () => window.Playoffs;
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const REGIONS = ["I", "II", "III", "IV"];

  const defaultFilters = { mode: "games", scope: "all", when: "week", round: "", region: "", status: "all", "game-status": "all", selected: null };
  const ui = { ...defaultFilters };
  const markers = new Map();
  let L, map, canvasR, pins, lines, freePopup;
  let shown = false, reconciling = false, loading = false, pending = null;
  let placed = [], scopeOptions = "", whenOptions = "", touched = false, fitting = false;
  let roundDay = new Map();

  const choices = (field, values) => values.map(([value, label, name]) => {
    const accessible = name || (field === "when" && value.startsWith("r:") ? value.slice(2) : "");
    return `<button type="button" data-map-${field}="${esc(value)}" aria-pressed="false"${accessible ? ` aria-label="${esc(accessible)}"` : ""}>${esc(label)}</button>`;
  }).join("");
  const windows = [["week", "This week"], ["today", "Today + tomorrow"], ["next", "Next round"]];
  const roundLabels = { "Regional Semifinals": "Regional semis", "Regional Finals": "Regional finals", Quarterfinals: "Quarters", Semifinals: "Semis", Championship: "Final" };

  view.innerHTML = `<div class="map-dateline">
      <div class="map-edition-head">
        <h2>Texas map</h2>
        <div class="map-edition-mode" role="group" aria-label="What to show on the map">
          ${choices("mode", [["games", "Games"], ["teams", "Teams"]])}
        </div>
      </div>
      <div class="map-ledger">
        <div class="map-filter-line map-competition" role="group" aria-labelledby="map-scope-label">
          <b id="map-scope-label">Brackets</b><div id="map-scope-choices"></div>
        </div>
        <div class="map-filter-line" role="group" aria-labelledby="map-region-label">
          <b id="map-region-label">Region</b><div>${choices("region", [["", "All regions"], ...REGIONS.map((r) => [r, r])])}</div>
        </div>
        <div class="map-filter-line map-schedule" id="map-when-field" role="group" aria-labelledby="map-when-label">
          <b id="map-when-label">Schedule</b><div>${choices("when", windows)}</div>
        </div>
        <div class="map-filter-line map-schedule" id="map-round-field" role="group" aria-labelledby="map-round-label">
          <b id="map-round-label">Round</b><div id="map-round-choices"></div>
        </div>
        <div class="map-filter-line" id="map-game-status-field" role="group" aria-labelledby="map-game-status-label">
          <b id="map-game-status-label">Status</b><div>${choices("game-status", [["all", "All games"], ["live", "Live"], ["upcoming", "Scheduled"], ["final", "Final"]])}</div>
        </div>
        <div class="map-filter-line map-team-filter" id="map-status-field" role="group" aria-labelledby="map-status-label" hidden>
          <b id="map-status-label">Status</b><div>${choices("status", [["all", "All teams"], ["alive", "Alive"], ["out", "Eliminated"], ["champ", "Champions"]])}</div>
        </div>
      </div>
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

  function addTexasOverview(L, map) {
    const pane = "texas-overview";
    map.createPane(pane).style.zIndex = 190;
    map.getPane(pane).style.pointerEvents = "none";
    // Generalized outline for the statewide view.
    L.polygon([
      [36.50,-103.00],[36.50,-100.00],[34.56,-100.00],[34.42,-99.60],
      [34.14,-98.68],[34.11,-98.17],[34.06,-97.53],[33.88,-97.21],
      [33.75,-96.84],[33.85,-96.19],[33.69,-95.32],[33.55,-94.48],
      [33.56,-94.04],[31.98,-94.04],[31.83,-93.82],[31.21,-93.57],
      [30.99,-93.55],[30.40,-93.76],[30.14,-93.70],[29.77,-93.90],
      [29.40,-94.72],[28.74,-95.73],[28.39,-96.53],[27.82,-97.05],
      [27.17,-97.38],[26.08,-97.15],[25.97,-97.37],[26.06,-98.24],
      [26.37,-99.10],[27.05,-99.43],[27.52,-99.53],[28.31,-100.31],
      [29.01,-100.67],[29.52,-101.27],[29.82,-101.38],[29.78,-102.06],
      [29.22,-102.70],[28.98,-103.15],[29.25,-103.70],[29.52,-104.02],
      [29.68,-104.47],[30.15,-104.69],[30.61,-104.98],[31.47,-106.22],
      [31.78,-106.64],[31.78,-103.06],[32.00,-103.06],
    ], { pane, color: "#79928b", weight: 2, fillColor: "#dae8dc", fillOpacity: 0.85, interactive: false }).addTo(map);
    for (const [name, point] of [
      ["Amarillo", [35.22,-101.83]], ["El Paso", [31.76,-106.49]],
      ["Lubbock", [33.57,-101.85]], ["Dallas", [32.78,-96.80]],
      ["Austin", [30.27,-97.74]], ["Houston", [29.76,-95.37]],
      ["San Antonio", [29.42,-98.49]], ["Corpus Christi", [27.80,-97.40]],
      ["Brownsville", [25.90,-97.50]],
    ]) {
      L.marker(point, {
        pane, interactive: false, keyboard: false,
        icon: L.divIcon({ className: "overview-city", html: name, iconSize: [0, 0] }),
      }).addTo(map);
    }
  }

  function build() {
    const canvas = $("#map-canvas");
    canvas.textContent = "";
    map = L.map(canvas, { minZoom: 4, maxZoom: 17, zoomSnap: 0, zoomDelta: 0.75, maxBounds: TX().pad(0.6), maxBoundsViscosity: 0.7, zoomControl: false });
    addTexasOverview(L, map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.control.zoom({ position: "bottomright", zoomInTitle: "Zoom in", zoomOutTitle: "Zoom out" }).addTo(map);
    const Reset = L.Control.extend({
      onAdd() {
        const controls = L.DomUtil.create("div", "map-camera");
        controls.innerHTML = '<button type="button" class="map-reset">Show all of Texas</button><button type="button" class="map-reset" id="map-fit-results">Fit results</button>';
        L.DomEvent.disableClickPropagation(controls);
        controls.firstElementChild.addEventListener("click", () => {
          touched = false;
          fitTexas();
        });
        controls.lastElementChild.addEventListener("click", () => {
          if (!placed.length) return;
          touched = true;
          map.fitBounds(L.latLngBounds(placed.map((it) => [it.lat, it.lon])), { padding: [26, 32], maxZoom: 10, animate: false });
        });
        return controls;
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
    return ui.scope === "all" ? Object.values(s.data) : [s.data[ui.scope]].filter(Boolean);
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
  const slotName = (s) => P().slotName(s);
  const teamColor = (t) => (/^#?[0-9a-f]{6}$/i.test(t?.color || "") ? "#" + t.color.replace(/^#/, "") : "#12355b");

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
        if (ui["game-status"] !== "all" && it.status !== ui["game-status"]) continue;
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
        if (ui.status !== "all" && itemClass(it) !== ui.status) continue;
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
  const labelText = (it) => it.kind === "game"
    ? `${it.g.teams.map((s, i) => [slotName(s), scoreOf(it, i)].filter(Boolean).join(" ")).join(" · ")} | ${statusWord(it)}`
    : [it.t.name, it.info.city, it.champ ? "Champion" : it.alive ? "Alive" : "Eliminated"].filter(Boolean).join(" · ");

  const markerText = (w) => {
    if (w.item) return labelText(w.item);
    const live = w.items.find((it) => it.status === "live");
    const count = `${w.items.length} ${ui.mode === "games" ? "games" : "schools"} at this spot`;
    return live ? `${count} · ${labelText(live)}` : count;
  };

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
    $("#map-fit-results").disabled = !out.length;
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
          const title = markerText(w);
          m = L.marker(w.latlng, { icon: divIcon(w, sel), zIndexOffset: w.z, title });
          m.on("add", () => m.getElement().setAttribute("aria-label", m.options.title));
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
        if (w.type !== "dot" && m.getElement()) {
          m.options.title = markerText(w);
          m.getElement().title = m.options.title;
          m.getElement().setAttribute("aria-label", m.options.title);
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
    const zoom = map.getZoom();
    const vb = map.getBounds().pad(-0.06);
    const edge = map.getSize().x * 0.5;
    const occupied = [];
    const screenWidth = map.getSize().x;
    const zoomForLabels = placed.length <= 20 ? 6.5 : screenWidth < 500 ? 9 : 8;
    const byPriority = [...markers.values()].sort((a, b) => Number(b._w.cls === "live") - Number(a._w.cls === "live"));
    for (const m of byPriority) {
      const w = m._w;
      const where = m.getLatLng();
      const point = map.latLngToContainerPoint(where);
      const dir = point.x > edge ? "left" : "right";
      const live = w.cls === "live";
      const eligible = vb.contains(where) && (live || (w.item && zoom >= zoomForLabels));
      const maxWidth = Math.min(screenWidth * 0.46, 245);
      const dx = (w.size ? w.size / 2 : dotRadius()) + 5;
      const box = { left: dir === "left" ? point.x - dx - maxWidth : point.x + dx,
        right: dir === "left" ? point.x - dx : point.x + dx + maxWidth, y: point.y };
      const fits = !occupied.some((p) => Math.abs(box.y - p.y) < 48 && box.left < p.right && p.left < box.right);
      const want = eligible && fits ? markerText(w) : null;
      if (want) occupied.push(box);
      if (want === (w.label ?? null) && (!want || dir === w.labelDir)) continue;
      if (!want) m.unbindTooltip();
      else if (m.getTooltip() && dir === w.labelDir) m.setTooltipContent(esc(want));
      else {
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
          m.getElement()?.setAttribute("aria-label", m.options.title);
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
      ? `LIVE${it.g.live?.period ? " · " + it.g.live.period : ""}${it.g.live?.scores?.some((s) => s != null) ? "" : " · score pending"}`
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
    return `<p class="pop-crumb">${ui.scope === "all" ? esc(b.label) + " · " : ""}${esc(g.round)}</p>
      <p class="pop-where"><b>${esc(P().where(g))}</b>${loose ? "<small>Marker is at the town, not the stadium.</small>" : ""}</p>
      <p class="pop-status ${st}">${esc(statusWord(it))}</p>
      <div class="pop-teams">${g.teams.map((s, i) => `<div class="${i === w ? "won" : ""}"><span>${esc(slotName(s))}</span><b>${esc(scoreOf(it, i))}</b>${P().districtStanding(s.id)}</div>`).join("")}</div>
      ${trip.length ? `<p class="pop-travel">${trip.join("<br>")}</p>` : ""}
      <div class="pop-actions">
        <button class="btn" type="button" data-game="${esc(g.id)}">Full details</button>
        <button class="btn" type="button" data-game="${esc(g.id)}" data-go="1" data-go-view="bracket">Show in bracket</button>
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
    const district = P().districtStanding(t.id);
    return `<div class="pop-head" style="--school-ink:${teamColor(info)};border-color:var(--school-ink)">${P().schoolMark(t)}<div><b>${esc(t.name)} ${esc(info.mascot || "")}</b><span>${esc(info.city ? info.city + ", Texas" : "")}${t.record ? ` · ${esc(t.record)}` : ""}</span></div></div>
      <p class="pop-status ${alive ? "alive" : "out"}">${champ ? "State champion" : alive ? "Still playing" : `Knocked out in the ${esc(last.round)} round`} · ${esc(b.label)}</p>
      ${district ? `<p>${district}</p>` : ""}
      <p>${gameLine}</p>
      ${loose ? `<p class="pop-note">Shown at the town centre.</p>` : ""}
      <div class="pop-actions">
        <button class="btn" type="button" data-team="${esc(t.id)}">Team details</button>
        ${game ? `<button class="btn" type="button" data-game="${esc(game.id)}" data-go="1" data-go-view="bracket">Show in bracket</button>` : ""}
      </div>`;
  }

  function summary(out, missing) {
    const scope = P().state.index.brackets.find((b) => b.code === ui.scope)?.label || "All 12 brackets";
    const total = out.length + missing.length;
    let text;
    if (ui.mode === "games") {
      const n = { live: 0, final: 0, upcoming: 0 };
      out.forEach((i) => n[i.status]++);
      missing.forEach((i) => n[i.status]++);
      text = `${scope} · ${whenWord()}: ${total} game${total === 1 ? "" : "s"} · ${n.live} live · ${n.upcoming} scheduled · ${n.final} final.`;
    } else {
      const alive = out.filter((i) => i.alive && !i.champ).length;
      const eliminated = out.filter((i) => !i.alive).length;
      const champions = out.filter((i) => i.champ).length;
      text = `${scope}: ${out.length} school${out.length === 1 ? "" : "s"} on the map · ${alive} alive · ${eliminated} eliminated${champions ? " · " + champions + " champions" : ""}.`;
    }
    if (ui.region) text += ` Region ${ui.region} only.`;
    if (missing.length)
      text += ` ${missing.length} without locations are listed below.`;
    $("#map-summary").textContent = text;
  }

  function legend(out) {
    const dot = (cls, txt, n = "") => `<span><i class="mk ${cls}">${n}</i>${txt}</span>`;
    $("#map-legend").innerHTML =
      ui.mode === "games"
        ? dot("live", "Playing now") + dot("final", "Final") + dot("upcoming", "Not started yet") + dot("upcoming stack", "Several games at the same spot — tap for the list", "3")
        : dot("dot alive", "Still playing") +
          dot("dot out", "Eliminated") +
          (out.some((i) => i.champ) ? dot("dot champ", "State champion") : "") +
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
        : "No schools match these filters. Try All teams, All 12 brackets, or another region.";
      return;
    }
    el.textContent = !missing.length
      ? `No games ${whenPhrase()} match these filters. Try All games, This week, or another region.`
      : `None of these ${missing.length} games has a place yet, so the map is empty. They are listed under the map.`;
  }

  function refreshControls() {
    const competitions = P().state.index.brackets;
    const scope = choices("scope", [["all", "All 12 brackets"], ...competitions.map(({ code, label }) =>
      [code, code.replace("D1", " I").replace("D2", " II"), label])]);
    if (scope !== scopeOptions) {
      scopeOptions = scope;
      $("#map-scope-choices").innerHTML = scope;
    }
    const rounds = [...new Set(brackets().flatMap((b) => b.rounds))];
    const opts = choices("when", rounds.map((r) => ["r:" + r, roundLabels[r] || r]));
    if (opts !== whenOptions) {
      whenOptions = opts;
      $("#map-round-choices").innerHTML = opts;
    }
    if (ui.when === "round" && !rounds.includes(ui.round)) ui.when = "week";
    const active = { ...ui, when: ui.when === "round" ? "r:" + ui.round : ui.when };
    for (const field of fields) {
      view.querySelectorAll(`[data-map-${field}]`).forEach((button) =>
        button.setAttribute("aria-pressed", button.getAttribute(`data-map-${field}`) === active[field]));
    }
    $("#map-when-field").hidden = ui.mode !== "games";
    $("#map-round-field").hidden = ui.mode !== "games";
    $("#map-status-field").hidden = ui.mode !== "teams";
    $("#map-game-status-field").hidden = ui.mode !== "games";
  }

  function reset() {
    if (!map) return;
    map.closePopup();
    select(null);
    refreshControls();
    layout();
  }

  const fields = ["mode", "scope", "region", "when", "status", "game-status"];
  view.addEventListener("click", (e) => {
    const el = e.target.closest("[data-map-select],[data-map-fit], " + fields.map((f) => `[data-map-${f}]`).join(", "));
    if (!el || !map) return;
    if (el.dataset.mapSelect) return pickFromList(el.dataset.mapSelect);
    if (el.dataset.mapFit) return fitTrip(el.dataset.mapFit);
    const field = fields.find((f) => el.hasAttribute(`data-map-${f}`));
    const value = el.getAttribute(`data-map-${field}`);
    if (field === "scope") {
      ui.scope = value;
      P().setMapCode(value === "all" ? null : value);
      return reset();
    }
    if (field === "when" && value.startsWith("r:")) {
      ui.when = "round";
      ui.round = value.slice(2);
    } else ui[field] = value;
    reset();
  });

  document.addEventListener("playoffs:render", () => {
    const s = P()?.state;
    if (!s) return;
    if (s.view !== "map" || view.hidden) {
      if (shown) {
        shown = false;
        map.closePopup();
        select(null);
        Object.assign(ui, defaultFilters);
        touched = false;
      }
      return;
    }
    const scope = s.code || "all";
    if (ui.scope !== scope) {
      ui.scope = scope;
      if (map) {
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
      if (o.scope) {
        const key = o.scope === "one" ? P()?.state.code : o.scope;
        ui.scope = P()?.state.index.brackets.some((b) => b.code === key) ? key : "all";
      }
      if (o.when) {
        ui.when = o.when;
        ui.round = "";
      }
      if (o.round) {
        ui.when = "round";
        ui.round = o.round;
      }
      if (o.region !== undefined) ui.region = o.region;
      if (o.status !== undefined) ui.status = o.status;
      if (o.gameStatus !== undefined) ui["game-status"] = o.gameStatus;
      pending = { center: o.center, zoom: o.zoom, select: o.select };
      if (map) {
        refreshControls();
        layout();
        applyPending();
      }
    },
  };
})();
