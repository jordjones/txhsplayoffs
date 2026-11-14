const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");

const REGIONS = ["I", "II", "III", "IV"];
const state = { index: null, data: {}, code: null, view: "rounds", round: null, region: "all", tab: "I", path: null, hit: null };
const wide = matchMedia("(min-width: 900px)");

async function getJSON(name) {
  const r = await fetch(`data/${name}.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}

async function load() {
  const index = await getJSON("index");
  if (state.index && state.index.updated === index.updated) return false;
  const files = await Promise.all(
    index.brackets.map(async (b) => {
      const [games, teams] = await Promise.all([getJSON(b.code), getJSON(b.code + "-teams").catch(() => ({}))]);
      return { ...games, teams };
    }),
  );
  index.brackets.forEach((b, i) => (state.data[b.code] = prepare(files[i])));
  state.index = index;
  return true;
}

// Order rounds from first to last and games top-to-bottom as they sit in the bracket tree.
// Regional finals are the round with four games; a game with no region inherits its regional final's.
function prepare(b) {
  const count = {};
  b.games.forEach((g) => (count[g.round] = (count[g.round] || 0) + 1));
  b.rounds = Object.keys(count).sort((x, y) => count[y] - count[x]);
  b.stateRounds = b.rounds.filter((r) => count[r] <= 2);
  const feeders = {};
  b.games.forEach((g) => g.next && (feeders[g.next] ||= []).push(g));
  const ordered = [];
  const walk = (g) => {
    (feeders[g.id] || []).forEach(walk);
    ordered.push(g);
  };
  b.games.filter((g) => !g.next).forEach(walk);
  b.games = ordered;
  const tag = (g, r) => {
    if (!REGIONS.includes(g.region)) g.region = r;
    (feeders[g.id] || []).forEach((f) => tag(f, r));
  };
  const finals = ordered.filter((g) => count[g.round] === 4);
  if (finals.length === 4) finals.forEach((g, i) => tag(g, REGIONS[i]));
  b.games.forEach((g) => REGIONS.includes(g.region) || (g.region = null));
  return b;
}

const fmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const parts = (k) => k.split(/[-T:]/).map(Number);
function when(k) {
  if (!k) return "Date to be announced";
  const [y, mo, d, h, mi] = parts(k);
  if (!h && !mi) return `${day(k)} · time to be announced`;
  return fmt.format(new Date(y, mo - 1, d, h, mi));
}
function day(k) {
  if (!k) return "To be announced";
  const [y, mo, d] = parts(k);
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function shortWhen(k) {
  if (!k) return "Date TBA";
  const [y, mo, d, h, mi] = parts(k);
  const dt = new Date(y, mo - 1, d, h || 0, mi || 0);
  const date = dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return h || mi ? `${date} · ${dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : `${date} · time TBA`;
}
function clock(iso) {
  if (!iso) return "";
  if (/Z|[+-]\d\d:?\d\d$/.test(iso)) return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  const [y, mo, d, h, mi] = parts(iso);
  return new Date(y, mo - 1, d, h || 0, mi || 0).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const chicago = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
});
function nowWall() {
  const p = Object.fromEntries(chicago.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute);
}
function status(g) {
  if (g.final) return "final";
  if (g.live) return "live";
  if (!g.kickoff) return "upcoming";
  const [y, mo, d, h, mi] = parts(g.kickoff);
  if (!h && !mi) return "upcoming";
  const since = nowWall() - Date.UTC(y, mo - 1, d, h, mi);
  return since >= 0 && since <= 4 * 3600e3 ? "live" : "upcoming";
}
const PERIODS = { Q1: "1st quarter", Q2: "2nd quarter", Half: "Halftime", Q3: "3rd quarter", Q4: "4th quarter", OT: "Overtime" };
const period = (p) => PERIODS[p] || p || "";

function where(g) {
  const town = g.town || g.city;
  if (town && g.stadium) return `${town} · ${g.stadium}`;
  if (town) return `${town} (stadium not posted)`;
  if (g.stadium) return g.stadium;
  if (g.host) return `Home team: ${g.host} (stadium not posted)`;
  return known(g) ? "Location not posted yet" : "";
}

function seed(s) {
  const m = /^([A-Z])(\d+)$/.exec(s || "");
  if (!m) return esc(s);
  const place = { W: "champion", R: "runner-up", T: "3rd place", F: "4th place" }[m[1]];
  return place ? `District ${m[2]} ${place}` : esc(s);
}
function seedShort(s) {
  const m = /^([WRTF])(\d+)$/.exec(s || "");
  return m ? `Dist. ${m[2]} ${{ W: "champ", R: "runner-up", T: "3rd", F: "4th" }[m[1]]}` : s || "";
}

const logo = (id) => `https://image.maxpreps.io/school-mascot/${esc(id[0])}/${esc(id[1])}/${esc(id[2])}/${esc(id)}.gif?width=96&height=96&fit=bounds`;
const winner = (g) => (g.final && g.teams[0].score !== g.teams[1].score ? (g.teams[0].score > g.teams[1].score ? 0 : 1) : -1);
const known = (g) => g.teams.every((t) => t.id);
const scores = (g) => (!g.final && g.live && Array.isArray(g.live.scores) ? g.live.scores : g.teams.map((t) => t.score));
const tbd = (name) => esc(String(name || "To be decided").replace(/^Winner G/, "Winner of Game "));
const liveOnes = (b) => b.games.filter((g) => status(g) === "live");

function badge(g, st) {
  if (st === "live") return `<span class="st live"><i class="dot"></i>LIVE${g.live?.period ? ` · ${esc(period(g.live.period))}` : ""}</span>`;
  if (st === "final") return `<span class="st final">FINAL</span>`;
  return `<span class="st soon">UPCOMING</span>`;
}

function teamRow(t, won, score) {
  if (!t.id) return `<div class="team"><span class="tbd">${tbd(t.name)}</span></div>`;
  return `<div class="team${won ? " won" : ""}">
    <img src="${logo(t.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <button class="name" type="button" data-team="${esc(t.id)}">${won ? "✔ " : ""}${esc(t.name)}${t.record ? ` <small>(${esc(t.record)})</small>` : ""}</button>
    ${won ? '<span class="wonword">WINNER</span>' : `<span class="seed">${seed(t.seed)}</span>`}
    <span class="score">${score ?? ""}</span>
  </div>`;
}

function gameCard(g) {
  const st = status(g);
  const w = winner(g);
  const sc = scores(g);
  const nfhs = g.watch
    ? `<a class="btn${st === "live" ? " watch" : ""}" href="${safeUrl(g.watch)}" target="_blank" rel="noopener">▶ ${st === "live" ? "Watch live on NFHS Network" : "Watch on NFHS Network"}</a>`
    : known(g) && st !== "final"
      ? `<a class="btn" href="https://www.nfhsnetwork.com/search?query=${encodeURIComponent(g.teams[0].name)}" target="_blank" rel="noopener">Look for this game on NFHS</a>`
      : "";
  const mpLabel = st === "live" ? (g.live_scoring ? "Live score on MaxPreps" : "Live updates on MaxPreps") : st === "final" ? "Game summary on MaxPreps" : "Game page on MaxPreps";
  const mp = g.game_url ? `<a class="btn${st === "live" ? " updates" : ""}" href="${safeUrl(g.game_url)}" target="_blank" rel="noopener">${mpLabel}</a>` : "";
  const note =
    st !== "live"
      ? ""
      : g.live
        ? `<p class="note">Live score from MaxPreps${g.live.at ? `, as of ${esc(clock(g.live.at))}` : ""}.</p>`
        : `<p class="note">Kickoff was ${esc(clock(g.kickoff))}. The live score has not been posted yet.</p>`;
  return `<article class="game ${st}${state.hit === g.id ? " hit" : ""}" id="g-${esc(g.id)}">
    <div class="head"><span>${esc(g.num.replace("G", "Game "))} · ${esc(g.round)}${g.region ? ` · Region ${esc(g.region)}` : ""}</span>${badge(g, st)}</div>
    <div class="meta"><span>${esc(when(g.kickoff))}</span><span class="where">${esc(where(g))}</span></div>
    ${g.teams.map((t, i) => teamRow(t, i === w, sc[i])).join("")}
    ${nfhs || mp ? `<div class="actions">${nfhs}${mp}</div>` : ""}${note}
  </article>`;
}

function cell(g, style) {
  const st = status(g);
  const w = winner(g);
  const sc = scores(g);
  const row = (t, i) =>
    t.id
      ? `<div class="row${i === w ? " won" : ""}"><img src="${logo(t.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="who"><button class="name" type="button" data-team="${esc(t.id)}">${i === w ? "✔ " : ""}${esc(t.name)}</button>
        <small>${[t.record, seedShort(t.seed)].filter(Boolean).map(esc).join(" · ")}</small></div><b class="pts">${sc[i] ?? ""}</b></div>`
      : `<div class="row"><span class="tbd">${tbd(t.name)}</span></div>`;
  const tag = st === "live" ? `<span class="st live"><i class="dot"></i>LIVE${g.live?.period ? ` · ${esc(g.live.period)}` : ""}</span>` : st === "final" ? `<span class="st final">FINAL</span>` : `<span class="st soon">${esc(shortWhen(g.kickoff))}</span>`;
  const cls = ["cell", st, state.hit === g.id ? "hit" : "", state.path && g.teams.some((t) => t.id === state.path) ? "path" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}" id="g-${esc(g.id)}" data-game="${esc(g.id)}" style="${style}">
    <div class="tag"><span class="gnum">${esc(g.num.replace("G", "Game "))}</span>${tag}</div>
    ${g.teams.map(row).join("")}
    <div class="foot"><span class="town">${esc(g.town || g.city || g.stadium || "")}</span><button class="more" type="button" data-game="${esc(g.id)}">Details</button></div>
  </div>`;
}

// A connected bracket: one grid, rounds in alternating cell/gap columns, two grid rows per first-round game.
function grid(b, games, compact) {
  const rounds = b.rounds.filter((r) => games.some((g) => g.round === r));
  const byRound = rounds.map((r) => games.filter((g) => g.round === r));
  const pos = new Map();
  byRound[0].forEach((g, i) => pos.set(g.id, { row: 2 + 2 * i, span: 2 }));
  const feeders = {};
  games.forEach((g) => g.next && (feeders[g.next] ||= []).push(g));
  const fed = (g) => (feeders[g.id] || []).filter((f) => pos.has(f.id)).map((f) => pos.get(f.id));
  byRound.slice(1).forEach((list, k) => {
    let cursor = 2;
    list.forEach((g) => {
      const f = fed(g);
      const row = f.length ? Math.min(...f.map((p) => p.row)) : cursor;
      const end = f.length ? Math.max(...f.map((p) => p.row + p.span)) : cursor + (4 << k);
      pos.set(g.id, { row, span: end - row });
      cursor = end;
    });
  });
  const n = Math.max(...[...pos.values()].map((p) => p.row + p.span)) - 2;
  const heads = rounds.map((r, k) => `<h3 style="grid-column:${2 * k + 1};grid-row:1">${esc(r)}<small>${byRound[k].length} ${byRound[k].length === 1 ? "game" : "games"}</small></h3>`);
  const cells = games.map((g) => {
    const p = pos.get(g.id);
    return cell(g, `grid-column:${2 * rounds.indexOf(g.round) + 1};grid-row:${p.row} / span ${p.span}`);
  });
  const links = games
    .filter((g) => rounds.indexOf(g.round) > 0 && fed(g).length)
    .map((g) => {
      const f = fed(g).sort((x, y) => x.row - y.row);
      const p = pos.get(g.id);
      const pct = (q) => ((q.row + q.span / 2 - p.row) / p.span) * 100;
      return `<div class="link" style="grid-column:${2 * rounds.indexOf(g.round)};grid-row:${p.row} / span ${p.span};--a:${pct(f[0])}%;--b:${pct(f.at(-1))}%"></div>`;
    });
  const cols = rounds.map(() => "var(--cellw)").join(" var(--gapw) ");
  return `<div class="grid${compact ? " compact" : ""}" style="grid-template-columns:${cols};grid-template-rows:auto repeat(${n}, 1fr)">${heads.join("")}${cells.join("")}${links.join("")}</div>`;
}

const stateName = (b, r) => (b.stateRounds.indexOf(r) === b.stateRounds.length - 1 ? "State championship" : "State semifinals");
const current = (yes) => `aria-current="${yes ? "true" : "false"}"`;
const liveDot = (n) => (n ? ` <i class="dot" aria-hidden="true"></i> ${n} live` : "");

function renderRounds(b, live) {
  if (state.round === "live" && !live.length) state.round = defaultRound(b);
  if (!b.rounds.includes(state.round) && state.round !== "live") state.round = defaultRound(b);
  $("#rounds").innerHTML =
    (live.length ? `<button class="livebtn" type="button" data-round="live" ${current(state.round === "live")}><i class="dot"></i>Live now (${live.length})</button>` : "") +
    b.rounds.map((r) => `<button type="button" data-round="${esc(r)}" ${current(r === state.round)}>${esc(r)}${liveDot(live.filter((g) => g.round === r).length)}</button>`).join("");
  const regional = state.round === "live" || !b.stateRounds.includes(state.round);
  let list = state.round === "live" ? live : b.games.filter((g) => g.round === state.round);
  const present = REGIONS.filter((r) => list.some((g) => g.region === r));
  $("#regions").hidden = !regional || !present.length;
  if (regional && present.length) {
    if (state.region !== "all" && !present.includes(state.region)) state.region = "all";
    $("#regions").innerHTML =
      `<button type="button" data-region="all" ${current(state.region === "all")}>All regions</button>` +
      present.map((r) => `<button type="button" data-region="${r}" ${current(r === state.region)}>Region ${r}${liveDot(list.filter((g) => g.region === r && status(g) === "live").length)}</button>`).join("");
    if (state.region !== "all") list = list.filter((g) => g.region === state.region);
  }
  const groups = new Map();
  list.forEach((g) => {
    const key = g.region ? `Region ${g.region}` : stateName(b, g.round);
    (groups.get(key) || groups.set(key, []).get(key)).push(g);
  });
  $("#games").innerHTML = list.length
    ? [...groups]
        .map(([name, gs]) => {
          const n = gs.filter((g) => status(g) === "live").length;
          return `<h3 class="region-h">${esc(name)}<small>${gs.length} ${gs.length === 1 ? "game" : "games"}${n ? ` · ${n} live now` : ""}</small></h3>${gs.map(gameCard).join("")}`;
        })
        .join("")
    : `<p class="empty">No games to show here.</p>`;
}

function renderTree(b, live) {
  const present = REGIONS.filter((r) => b.games.some((g) => g.region === r));
  const tabs = [...present.map((r) => [r, `Region ${r}`]), ["state", "State"]];
  if (wide.matches) tabs.push(["all", "Whole bracket"]);
  if (!tabs.some(([k]) => k === state.tab)) state.tab = tabs[0][0];
  $("#tabs").innerHTML = tabs
    .map(([k, label]) => {
      const n = live.filter((g) => (k === "all" ? true : k === "state" ? !g.region : g.region === k)).length;
      return `<button type="button" data-tab="${k}" ${current(k === state.tab)}>${label}${liveDot(n)}</button>`;
    })
    .join("");
  const games = state.tab === "all" ? b.games : state.tab === "state" ? b.games.filter((g) => !g.region) : b.games.filter((g) => g.region === state.tab);
  const first = games.filter((g) => g.round === b.rounds.find((r) => games.some((x) => x.round === r)));
  const intro =
    state.tab === "all"
      ? `All ${games.length} games, first round on the left and the state championship on the right.`
      : state.tab === "state"
        ? "The four regional champions meet here. Winners of the semifinals play for the state title."
        : `${first.length * 2} teams. The winner of the last game on the right is the Region ${state.tab} champion and goes to the state semifinals.`;
  const team = state.path && b.teams[state.path]?.name || (state.path && b.games.flatMap((g) => g.teams).find((t) => t.id === state.path)?.name);
  $("#tree-note").innerHTML =
    (team ? `<span class="pathbar">${esc(team)}'s games are highlighted <button class="plain" type="button" data-clear-path="1">Clear</button></span>` : "") +
    `<span>${esc(intro)}${wide.matches ? "" : " Swipe sideways or use the buttons to move between rounds."}</span>`;
  $("#tree").innerHTML = games.length ? grid(b, games, state.tab === "all") : `<p class="empty">No games to show here.</p>`;
}

function defaultRound(b) {
  return b.rounds.find((r) => b.games.some((g) => g.round === r && !g.final)) || b.rounds.at(-1);
}

function render() {
  const { index, data } = state;
  const confs = {};
  index.brackets.forEach((b) => (confs[b.label.replace(/ Division.*/, "")] ||= []).push(b));
  $("#brackets").innerHTML = Object.entries(confs)
    .map(
      ([conf, list]) =>
        `<div class="conf"><b>${esc(conf.replace(" Six-Man", ""))}${/Six-Man/.test(conf) ? "<small>six-man</small>" : ""}</b>${list
          .map((b) => `<button class="pick" type="button" data-code="${esc(b.code)}" ${current(b.code === state.code)}>${esc(b.label.replace(/.*(Division)/, "$1"))}</button>`)
          .join("")}</div>`,
    )
    .join("");
  $("#updated").textContent =
    "Scores last updated " +
    new Date(index.updated).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) +
    " Central";

  const b = data[state.code];
  $("#bracket").hidden = !b;
  $("#status").hidden = true;
  if (!b) return;
  const y = scrollY;
  const tx = $("#tree").scrollLeft;
  const live = liveOnes(b);
  $("#title").textContent = b.label;
  $("#live-note").innerHTML = live.length
    ? `<button class="livebtn" type="button" data-round="live" data-view="rounds"><i class="dot"></i>${live.length} ${live.length === 1 ? "game" : "games"} live now</button>`
    : "";
  document.querySelectorAll("#views button").forEach((el) => el.setAttribute("aria-current", el.dataset.view === state.view));
  $("#rounds-view").hidden = state.view !== "rounds";
  $("#bracket-view").hidden = state.view !== "bracket";
  $("#map-view").hidden = state.view !== "map";
  $("main").classList.toggle("wide", state.view === "bracket" && wide.matches);
  if (state.view === "rounds") renderRounds(b, live);
  if (state.view === "bracket") renderTree(b, live);
  history.replaceState(null, "", hash());
  scrollTo(scrollX, y);
  $("#tree").scrollLeft = tx;
  document.dispatchEvent(new CustomEvent("playoffs:render"));
}

function hash() {
  const sub = state.view === "bracket" ? state.tab : state.view === "rounds" ? state.region : "";
  const dflt = state.view === "bracket" ? "I" : "all";
  const p = [state.code];
  if (state.view !== "rounds" || sub !== dflt) p.push(state.view);
  if (sub && sub !== dflt) p.push(sub);
  return "#" + p.join("/");
}
function applyHash() {
  const [code, view, sub] = location.hash.slice(1).split("/");
  if (!state.data[code]) return false;
  if (code !== state.code) {
    state.code = code;
    state.region = "all";
    state.tab = "I";
    state.path = null;
  }
  if (["rounds", "bracket", "map"].includes(view)) state.view = view;
  if (sub && state.view === "bracket") state.tab = sub;
  if (sub && state.view === "rounds") state.region = sub;
  pick(code);
  return true;
}

function pick(code, round, gameId) {
  const b = state.data[code];
  if (!b) return;
  if (code !== state.code) {
    state.region = "all";
    state.tab = "I";
    state.path = null;
  }
  state.code = code;
  state.round = round || (state.round === "live" && liveOnes(b).length ? "live" : defaultRound(b));
  state.hit = gameId || null;
  if (gameId) {
    const g = b.games.find((x) => x.id === gameId);
    if (state.view === "bracket") state.tab = g?.region || "state";
    else {
      state.view = "rounds";
      state.region = "all";
      state.round = g?.round || state.round;
    }
  }
  render();
  if (gameId) document.getElementById("g-" + gameId)?.scrollIntoView({ block: "center", inline: "center" });
}

function findGame(id) {
  for (const b of Object.values(state.data)) {
    const g = b.games.find((x) => x.id === id);
    if (g) return [b, g];
  }
  return [];
}

function teamGames(id) {
  for (const b of Object.values(state.data)) {
    const games = b.games.filter((g) => g.teams.some((t) => t.id === id));
    if (games.length) return [b, games];
  }
  return [null, []];
}

function teamPanel(id) {
  const [b, games] = teamGames(id);
  if (!b) return;
  const slot = games[0].teams.find((t) => t.id === id);
  const t = b.teams[id];
  if (!t) {
    return `<div class="team-head"><img src="${logo(id)}" alt=""><div><h2>${esc(slot.name)}</h2><p>${esc(b.label)}</p></div></div>
      <p>More details for this team have not been collected yet.</p>
      <p><a class="btn" href="${safeUrl(slot.url)}" target="_blank" rel="noopener">Team page on MaxPreps</a></p>`;
  }
  const fact = (k, v) => (v || v === 0 ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : "");
  const staff = t.staff || [];
  const head = staff.find((s) => /head coach/i.test(s.role));
  const others = staff.filter((s) => s !== head);
  const rows = (t.schedule || [])
    .map((s) => {
      const bracketGame = s.playoff && games.find((g) => g.teams.some((x) => x.id === s.opponent_id));
      const res = s.result
        ? s.url
          ? `<a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.result)}</a>`
          : esc(s.result)
        : s.date
          ? when(s.date).split(", ").pop()
          : "";
      return `<tr class="${s.playoff ? "playoff" : ""}">
        <td>${day(s.date)}</td>
        <td>${s.site === "away" ? "at" : "vs"} ${esc(s.opponent || "To be decided")}
          ${s.playoff ? "<small>Playoff game</small>" : ""}${s.stadium ? `<small>${esc(s.stadium)}</small>` : ""}
          ${bracketGame ? `<button class="plain" type="button" data-game="${esc(bracketGame.id)}" data-go="1">Show in bracket</button>` : ""}</td>
        <td class="res ${/^[WLT]/.test(s.result || "") ? s.result[0] : ""}">${res}</td></tr>`;
    })
    .join("");
  const leaders = (t.leaders || [])
    .map((l) => `<tr><td>${esc(l.stat)}</td><td>${esc(l.player)} <small>${esc(l.pos)}</small></td><td class="res">${esc(l.value)}</td></tr>`)
    .join("");
  return `<div class="team-head" style="border-color:#${/^[0-9a-f]{6}$/i.test(t.color) ? t.color : "12355b"}">
      <img src="${logo(id)}" alt=""><div><h2>${esc(t.name)} ${esc(t.mascot || "")}</h2>
      <p>${t.city ? `${esc(t.city)}, Texas · ` : ""}${esc(b.label)}</p></div></div>
    <dl class="facts">
      ${fact("Record", t.record)}
      ${fact("District", t.district_record ? `${t.district_record}${t.district_place ? ` (${t.district_place})` : ""}` : null)}
      ${fact("Points scored", t.pf)}${fact("Points allowed", t.pa)}
      ${fact("Home", t.home)}${fact("Away", t.away)}
      ${fact("Streak", t.streak ? `${{ W: "Won", L: "Lost", T: "Tied" }[t.streak[0]] || ""} ${t.streak.slice(1)}` : null)}
      ${fact("Head coach", head?.name)}
    </dl>
    ${t.district ? `<p>${esc(t.district)}</p>` : ""}
    ${others.length ? `<details><summary>Coaching staff (${others.length} more)</summary><table>${others.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.role)}</td></tr>`).join("")}</table></details>` : ""}
    <h3>Season schedule</h3>
    ${rows ? `<table><tr><th>Date</th><th>Opponent</th><th>Result</th></tr>${rows}</table>` : "<p>No schedule is posted for this team.</p>"}
    <h3>Team leaders</h3>
    ${leaders ? `<table><tr><th>Category</th><th>Player</th><th>Total</th></tr>${leaders}</table>` : "<p>No player statistics have been posted for this team.</p>"}
    <p><a class="btn" href="${safeUrl(t.url)}" target="_blank" rel="noopener">Team page on MaxPreps</a></p>`;
}

function open(html) {
  if (!html) return;
  $("#panel-body").innerHTML = html;
  if (!$("#panel").open) $("#panel").showModal();
  $("#panel").scrollTop = 0;
}

function search(q) {
  const box = $("#results");
  q = q.trim().toLowerCase();
  if (q.length < 2) return (box.hidden = true);
  const seen = new Map();
  for (const b of Object.values(state.data))
    for (const g of b.games)
      for (const t of g.teams)
        if (t.id && t.name.toLowerCase().includes(q)) seen.set(t.id, { t, b, g });
  const hits = [...seen.values()].sort((x, y) => x.t.name.localeCompare(y.t.name)).slice(0, 8);
  box.hidden = false;
  box.innerHTML = hits.length
    ? hits
        .map(({ t, b, g }) => `<li><button type="button" data-game="${esc(g.id)}" data-go="1">${esc(t.name)}<small>${esc(b.teams[t.id]?.city || "")} · ${esc(b.label)} · ${esc(g.round)}</small></button></li>`)
        .join("")
    : "<li><button type='button' disabled>No playoff team matches that name</button></li>";
}

function stepTree(dir) {
  const t = $("#tree");
  const heads = t.querySelectorAll("h3");
  const unit = heads.length > 1 ? heads[1].offsetLeft - heads[0].offsetLeft : t.clientWidth;
  t.scrollTo({ left: (Math.round(t.scrollLeft / unit) + dir) * unit });
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-code],[data-round],[data-region],[data-view],[data-tab],[data-clear-path],[data-team],[data-game],.close,#tree-prev,#tree-next");
  if (!el) return;
  if (el.matches(".close")) return $("#panel").close();
  if (el.id === "tree-prev") return stepTree(-1);
  if (el.id === "tree-next") return stepTree(1);
  if (el.dataset.code) return pick(el.dataset.code);
  if (el.dataset.round) {
    if (el.dataset.view) state.view = el.dataset.view;
    return pick(state.code, el.dataset.round);
  }
  if (el.dataset.view) {
    state.view = el.dataset.view;
    return render();
  }
  if (el.dataset.region) {
    state.region = el.dataset.region;
    return render();
  }
  if (el.dataset.tab) {
    state.tab = el.dataset.tab;
    return render();
  }
  if (el.dataset.clearPath) {
    state.path = null;
    return render();
  }
  if (el.dataset.team) {
    if (el.closest("#tree")) {
      state.path = el.dataset.team;
      render();
    }
    return open(teamPanel(el.dataset.team));
  }
  const [b, g] = findGame(el.dataset.game);
  if (!g) return;
  if (el.dataset.go) {
    $("#panel").close();
    $("#results").hidden = true;
    $("#q").value = "";
    return pick(b.code, g.round, g.id);
  }
  open(gameCard(g));
});
$("#panel").addEventListener("click", (e) => e.target === $("#panel") && $("#panel").close());
$("#q").addEventListener("input", (e) => search(e.target.value));
wide.addEventListener("change", () => state.code && render());
addEventListener("hashchange", () => location.hash !== hash() && applyHash());

async function refresh() {
  try {
    await load();
    if (state.code) render();
    else applyHash() || pick(state.index.brackets[0].code);
  } catch (err) {
    if (!state.index) $("#status").textContent = "The brackets could not be loaded. Please try again in a few minutes.";
  }
}
window.Playoffs = { state, status, gameCard, open, teamPanel, pick, where };
refresh();
setInterval(refresh, 5 * 60 * 1000);
