(() => {
  const view = document.getElementById("map-view");
  if (!view) return;
  const P = () => window.Playoffs;
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "");
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const REGIONS = ["I", "II", "III", "IV"];
  const CELL = 56;

  const ui = { mode: "games", scope: "one", round: "", region: "", selected: null };
  const markers = new Map();
  let L, map, pins, lines, freePopup, shown = false, lastCode = null, reconciling = false, loading = false, pending = null;
  let placed = [], roundOptions = "";

  view.innerHTML = `<div class="map-controls">
      <div class="map-seg" role="group" aria-label="What to show on the map">
        <button type="button" data-map-mode="games" aria-pressed="true">Games</button>
        <button type="button" data-map-mode="teams" aria-pressed="false">Teams</button>
      </div>
      <div class="map-seg" role="group" aria-label="Which brackets to show">
        <button type="button" data-map-scope="one" aria-pressed="true">This bracket</button>
        <button type="button" data-map-scope="all" aria-pressed="false">All 12 brackets</button>
      </div>
      <label class="map-field" id="map-round-field">Round <select id="map-round"></select></label>
      <label class="map-field">Region <select id="map-region"><option value="">All regions</option>${REGIONS.map((r) => `<option value="${r}">Region ${r}</option>`).join("")}</select></label>
    </div>
    <p id="map-summary" class="map-summary"></p>
    <div id="map-canvas" class="map-canvas">Loading the map…</div>
    <div id="map-legend" class="map-legend"></div>
    <details id="map-missing" class="map-missing" hidden><summary></summary><ul></ul></details>`;
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

  function build() {
    const TX = L.latLngBounds([25.6, -106.8], [36.7, -93.3]);
    const canvas = $("#map-canvas");
    canvas.textContent = "";
    map = L.map(canvas, { minZoom: 5, maxZoom: 17, zoomSnap: 0.5, maxBounds: TX.pad(1), maxBoundsViscosity: 0.8, zoomControl: false });
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
        b.addEventListener("click", () => map.fitBounds(TX));
        return b;
      },
    });
    new Reset({ position: "bottomleft" }).addTo(map);
    lines = L.layerGroup().addTo(map);
    pins = L.layerGroup().addTo(map);
    map.fitBounds(TX);
    map.on("zoomend", layout);
    map.on("popupclose", () => !reconciling && select(null));
    map.on("resize", () => {
      for (const m of markers.values()) if (m.getPopup()) Object.assign(m.getPopup().options, popOpts());
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
  const roundFor = (b) => (ui.round ? (b.rounds.includes(ui.round) ? ui.round : null) : currentRound(b));
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
    for (const b of brackets()) {
      const r = roundFor(b);
      if (!r) continue;
      for (const g of b.games) {
        if (g.round !== r || (ui.region && g.region !== ui.region)) continue;
        const it = { key: "g:" + g.id, kind: "game", g, b, status: status(g), lat: g.lat, lon: g.lon };
        (isNum(g.lat) && isNum(g.lon) ? out : missing).push(it);
      }
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
        const it = { key: "t:" + t.id, kind: "team", t, info, b, alive: !lost, champ, last, next, lat: info.lat, lon: info.lon };
        (isNum(info.lat) && isNum(info.lon) ? out : missing).push(it);
      }
    }
    return { out, missing };
  }

  const itemClass = (it) => (it.kind === "game" ? it.status : it.champ ? "champ" : it.alive ? "alive" : "out");
  const clusterClass = (list) =>
    list[0].kind === "game"
      ? list.some((i) => i.status === "live") ? "live" : list.some((i) => i.status === "upcoming") ? "upcoming" : "final"
      : list.some((i) => i.alive) ? "alive" : "out";
  const labelText = (it) => (it.kind === "game" ? it.g.teams.map(slotName).join(" v ") : it.t.name);
  const icon = (w, sel) =>
    L.divIcon({
      className: `mk ${w.cls}${w.items ? " cluster" : ""}${w.html.length > 2 ? " wide" : ""}${sel ? " sel" : ""}`,
      html: w.html,
      iconSize: [w.size, w.size],
      iconAnchor: [w.size / 2, w.size / 2],
      popupAnchor: [0, -w.size / 2 - 2],
      tooltipAnchor: [w.size / 2, 0],
    });

  function layout() {
    if (!map) return;
    const { out, missing } = ui.mode === "games" ? gameItems() : teamItems();
    placed = out;
    if (ui.selected && !out.some((i) => i.key === ui.selected)) ui.selected = null;
    const z = map.getZoom();
    const cells = new Map();
    for (const it of out) {
      const p = map.project([it.lat, it.lon], z);
      const k = `${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`;
      const c = cells.get(k) || cells.set(k, { key: k, items: [], x: 0, y: 0 }).get(k);
      c.items.push(it);
      c.x += p.x;
      c.y += p.y;
    }
    const mid = (c) => [c.x / c.items.length, c.y / c.items.length];
    const groups = [...cells.values()].sort((a, b) => b.items.length - a.items.length);
    for (const g of groups) {
      if (g.gone) continue;
      const [cx, cy] = g.key.split(":").map(Number);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const n = cells.get(`${cx + dx}:${cy + dy}`);
          if (!n || n === g || n.gone || n.items.length > g.items.length) continue;
          const [ax, ay] = mid(g), [bx, by] = mid(n);
          if (Math.hypot(ax - bx, ay - by) < CELL) {
            g.items.push(...n.items);
            g.x += n.x;
            g.y += n.y;
            n.gone = true;
          }
        }
    }
    const want = new Map();
    for (const g of groups) {
      if (g.gone) continue;
      const list = g.items;
      if (list.length === 1) {
        const it = list[0];
        want.set(it.key, { latlng: [it.lat, it.lon], html: "", cls: itemClass(it), size: 34, popup: popupHtml(it), label: labelText(it), z: it.status === "live" ? 1000 : 0, item: it });
      } else {
        const n = list.length;
        const latlng = [list.reduce((s, i) => s + i.lat, 0) / n, list.reduce((s, i) => s + i.lon, 0) / n];
        want.set(`c:${z}:${g.key}`, { latlng, html: String(n), cls: clusterClass(list), size: n < 10 ? 44 : n < 100 ? 50 : 56, items: list, z: 500 });
      }
    }
    reconcile(want, z >= 10);
    if (freePopup?.isOpen() && ui.selected) {
      const it = out.find((i) => i.key === ui.selected);
      if (it) freePopup.setContent(popupHtml(it));
    }
    summary(out, missing);
    legend();
    missingList(missing);
    drawLines();
  }

  function reconcile(want, labels) {
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
        const title = w.item ? labelText(w.item) : `${w.items.length} ${ui.mode === "games" ? "games" : "schools"} close together`;
        m = L.marker(w.latlng, { icon: icon(w, sel), zIndexOffset: w.z, title });
        m._w = { sel };
        if (w.item) {
          m.bindPopup(w.popup, popOpts());
          m.on("popupopen", () => ui.selected !== k && select(k));
        } else m.on("click", () => clusterClick(m._w));
        pins.addLayer(m);
        markers.set(k, m);
      } else {
        if (w.cls !== m._w.cls || w.html !== m._w.html || sel !== m._w.sel) m.setIcon(icon(w, sel));
        if (w.item && w.popup !== m._w.popup) m.setPopupContent(w.popup);
        if (w.z !== m._w.z) m.setZIndexOffset(w.z);
      }
      const label = labels && w.item ? w.label : null;
      if (label !== (m._w.label ?? null)) {
        if (!label) m.unbindTooltip();
        else if (m.getTooltip()) m.setTooltipContent(esc(label));
        else m.bindTooltip(esc(label), { permanent: true, direction: "right", offset: [6, 0], className: "mk-label" });
      }
      m._w = { ...w, sel, label };
    }
    const m = ui.selected && markers.get(ui.selected);
    if (m && !m.isPopupOpen()) m.openPopup();
    reconciling = false;
  }

  function select(k) {
    const prev = ui.selected;
    if (prev === k) return;
    ui.selected = k;
    for (const key of [prev, k]) {
      const m = key && markers.get(key);
      if (m) {
        m._w.sel = key === k;
        m.setIcon(icon(m._w, key === k));
      }
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

  function clusterClick(w) {
    const b = L.latLngBounds(w.items.map((i) => [i.lat, i.lon])).pad(0.3);
    const zoom = map.getBoundsZoom(b);
    if (zoom <= 15 && zoom > map.getZoom()) map.fitBounds(b, { maxZoom: 15 });
    else openList(w);
  }

  function openList(w) {
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
        return `<li><button type="button" data-map-select="${esc(it.key)}"><i class="mk ${itemClass(it)}"></i><span>${text}</span></button></li>`;
      })
      .join("");
    freePopup = L.popup(popOpts(20))
      .setLatLng(w.latlng)
      .setContent(`<p class="pop-crumb">${items.length} ${noun} here${towns.size === 1 ? " · " + esc([...towns][0]) : ""}. Tap one.</p><ul class="pop-list">${rows}</ul>`)
      .openOn(map);
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
    map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 13 });
  }

  const scoreOf = (it, i) => {
    const v = it.status === "live" && it.g.live?.scores ? it.g.live.scores[i] : it.g.teams[i].score;
    return v == null ? "" : String(v);
  };
  const statusWord = (it) =>
    it.status === "live" ? `Playing now${it.g.live?.period ? " · " + it.g.live.period : ""}` : it.status === "final" ? "Final" : `Kickoff: ${when(it.g.kickoff)}`;
  const popupHtml = (it) => (it.kind === "game" ? gamePopup(it) : teamPopup(it));

  function gamePopup(it) {
    const { g, b, status: st } = it;
    const w = winner(g);
    const trip = g.teams.filter((s) => s.id).map((s) => {
      const t = school(b, s);
      return `${esc(s.name)}: ${t ? esc(tripText(t, it)) : "distance unknown"}`;
    });
    const canFit = g.teams.some((s) => school(b, s));
    return `<p class="pop-crumb">${ui.scope === "all" ? esc(b.label) + " · " : ""}${esc(g.round)} · ${esc(String(g.num).replace("G", "Game "))}</p>
      <p class="pop-where"><b>${esc(P().where(g))}</b>${g.venue_exact === false ? "<small>Marker is at the town, not the stadium.</small>" : ""}</p>
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
    const { t, info, b, alive, champ, last, next } = it;
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
      <div class="pop-actions">
        <button class="btn" type="button" data-team="${esc(t.id)}">Team details</button>
        ${game ? `<button class="btn" type="button" data-game="${esc(game.id)}" data-go="1">Show in bracket</button>` : ""}
      </div>`;
  }

  function summary(out, missing) {
    const s = P().state, b = s.data[s.code];
    const scope = ui.scope === "all" ? "All 12 brackets" : b ? b.label : "";
    let text;
    if (ui.mode === "games") {
      const n = { live: 0, final: 0, upcoming: 0 };
      out.forEach((i) => n[i.status]++);
      const round = ui.round || (ui.scope === "one" && b ? currentRound(b) : "this week's round");
      text = `${scope} · ${round}: ${out.length} game${out.length === 1 ? "" : "s"} on the map — ${n.live} playing now, ${n.final} final, ${n.upcoming} not started yet.`;
    } else {
      const alive = out.filter((i) => i.alive).length;
      text = `${scope}: ${out.length} school${out.length === 1 ? "" : "s"} on the map — ${alive} still playing, ${out.length - alive} knocked out.`;
    }
    if (ui.region) text += ` Region ${ui.region} only.`;
    if (missing.length) text += ` ${missing.length} not placed (see below).`;
    $("#map-summary").textContent = text;
  }

  function legend() {
    const dot = (cls, txt, n = "") => `<span><i class="mk ${cls}">${n}</i>${txt}</span>`;
    $("#map-legend").innerHTML =
      ui.mode === "games"
        ? dot("live", "Playing now") + dot("final", "Final") + dot("upcoming", "Not started yet") + dot("upcoming cluster", "Several games close together — tap to zoom in", "3")
        : dot("alive", "Still playing") + dot("out", "Knocked out") + dot("alive cluster", "Several schools close together — tap to zoom in", "3");
  }

  function missingList(missing) {
    const d = $("#map-missing");
    d.hidden = !missing.length;
    if (!missing.length) return;
    const one = missing.length === 1;
    d.querySelector("summary").textContent = `${missing.length} ${ui.mode === "games" ? "game" : "school"}${one ? " is" : "s are"} not on the map (no location yet). Tap to see ${one ? "it" : "them"}.`;
    d.querySelector("ul").innerHTML = missing
      .map((it) =>
        it.kind === "game"
          ? `<li><button class="plain" type="button" data-game="${esc(it.g.id)}">${esc(labelText(it))}<small>${ui.scope === "all" ? esc(it.b.label) + " · " : ""}${esc(P().where(it.g))}</small></button></li>`
          : `<li><button class="plain" type="button" data-team="${esc(it.t.id)}">${esc(it.t.name)}<small>${esc(it.info.city || "Town not known")}${ui.scope === "all" ? " · " + esc(it.b.label) : ""}</small></button></li>`,
      )
      .join("");
  }

  function refreshControls() {
    view.querySelectorAll("[data-map-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mapMode === ui.mode)));
    view.querySelectorAll("[data-map-scope]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mapScope === ui.scope)));
    $("#map-round-field").hidden = ui.mode !== "games";
    const rounds = [];
    for (const x of brackets()) for (const r of x.rounds) if (!rounds.includes(r)) rounds.push(r);
    const opts = `<option value="">Current round</option>` + rounds.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
    if (opts !== roundOptions) {
      roundOptions = opts;
      $("#map-round").innerHTML = opts;
    }
    $("#map-round").value = rounds.includes(ui.round) ? ui.round : "";
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
  $("#map-round").addEventListener("change", (e) => {
    ui.round = e.target.value;
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
      ui.round = "";
      if (changed && ui.scope === "one" && map) {
        map.closePopup();
        select(null);
      }
    }
    if (!L) return loadLeaflet();
    if (!shown) {
      shown = true;
      map.invalidateSize();
    }
    refreshControls();
    layout();
  });

  function applyPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (p.center) map.setView(p.center, p.zoom ?? map.getZoom(), { animate: false });
    else if (p.zoom) map.setZoom(p.zoom, { animate: false });
    if (p.select) pickFromList(p.select);
  }

  window.PlayoffsMap = {
    set(o = {}) {
      if (o.mode) ui.mode = o.mode;
      if (o.scope) ui.scope = o.scope;
      if (o.round !== undefined) ui.round = o.round;
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
