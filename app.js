const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");

const REGIONS = ["I", "II", "III", "IV"];
const state = { index: null, live: null, docs: {}, teams: {}, teamsUpdated: null, data: {}, code: null, want: null, view: "rounds", round: null, region: "all", tab: "I", path: null, hit: null };
const wide = matchMedia("(min-width: 900px)");

async function getJSON(name) {
  const r = await fetch(`data/v1/football/2026/${name}.json`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}

const merge = (id, t) => (state.teams[id] = { ...state.teams[id], ...t });
const loading = {};
function loadComp(code) {
  return (loading[code] ||= getJSON(`c/${code}`)
    .then((doc) => {
      state.docs[code] = doc;
      Object.entries(doc.teams).forEach(([id, t]) => merge(id, t));
      assemble(code);
    })
    .finally(() => delete loading[code]));
}
function loadTeams() {
  return (loading.teams ||= getJSON("teams")
    .then((doc) => {
      Object.entries(doc.teams).forEach(([id, t]) => merge(id, t));
      state.teamsUpdated = doc.updated;
    })
    .finally(() => delete loading.teams));
}
const loadTeam = (id) => getJSON(`t/${id}`).then((t) => merge(id, t));
const loadComps = () => Promise.all(state.index.brackets.filter((b) => !state.data[b.code]).map((b) => loadComp(b.code)));
const mapReady = () => state.teamsUpdated && state.index.brackets.every((b) => state.data[b.code]);

// A live row marked final is authoritative over a competition file that has not caught up yet.
function assemble(code) {
  const doc = state.docs[code];
  const rows = state.live.games;
  const at = state.live.at ?? state.live.updated;
  const before = Object.fromEntries((state.data[code]?.games || []).map((g) => [g.id, g]));
  const games = doc.games.map(({ slots, ...g }) => {
    const row = rows[g.id];
    const kept = !g.final && !row?.final && before[g.id]?.final ? before[g.id] : null; // the live row expired before this competition file caught up
    const final = g.final || !!row?.final || !!kept;
    const teams = slots.map((s, i) => ({
      id: s.team,
      name: s.team ? doc.teams[s.team]?.name ?? "" : s.placeholder,
      seed: s.seed,
      score: (row?.final ? row.scores?.[s.team] ?? s.score : kept ? kept.teams[i].score : s.score) ?? null,
      record: s.record,
      url: s.team ? doc.teams[s.team]?.url ?? null : null,
    }));
    const live = row && !final ? { period: row.period, scores: teams.map((t) => row.scores?.[t.id] ?? null), at } : null;
    return { ...g, teams, final, host: g.host ? doc.teams[g.host]?.name ?? null : null, live };
  });
  // Keys stay in index order whatever order the files arrive in: the map lists brackets in this order.
  const data = { ...state.data, [code]: prepare({ code, label: doc.label, games, teams: state.teams }) };
  state.data = Object.fromEntries(state.index.brackets.filter((b) => data[b.code]).map((b) => [b.code, data[b.code]]));
}

async function load() {
  const [index, live] = await Promise.all([getJSON("index"), getJSON("live").catch(() => state.live || { games: {} })]);
  state.live = live;
  state.index = { brackets: index.competitions, updated: new Date(live.updated) > new Date(index.updated) ? live.updated : index.updated };
  await Promise.all([
    ...index.competitions.filter((c) => state.docs[c.code] && state.docs[c.code].updated !== c.updated).map((c) => loadComp(c.code)),
    state.teamsUpdated && state.teamsUpdated !== index.teams_updated && loadTeams(),
  ]);
  Object.keys(state.docs).forEach(assemble);
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
  return g.live ? "live" : "upcoming";
}

function kickoffPassed(g, now) {
  if (!g.kickoff) return false;
  const [y, mo, d, h, mi] = parts(g.kickoff);
  return Boolean(h || mi) && Date.UTC(y, mo - 1, d, h, mi) <= now;
}
const PERIODS = { Q1: "1st quarter", Q2: "2nd quarter", Half: "Halftime", Q3: "3rd quarter", Q4: "4th quarter", OT: "Overtime" };
const period = (p) => PERIODS[p] || p || "";

function where(g) {
  const town = g.town;
  if (town && g.stadium) return `${town} · ${g.stadium}`;
  if (town) return `${town} (stadium not posted)`;
  if (g.stadium) return g.stadium;
  if (g.host) {
    const slot = g.teams.find((t) => t.name === g.host);
    const home = slot && Object.values(state.data).map((b) => b.teams[slot.id]).find(Boolean);
    return `Home team: ${g.host}${home?.city ? ` of ${home.city}` : ""} (stadium not posted)`;
  }
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
function schoolMark(team) {
  const info = state.teams[team.id];
  const color = /^[0-9a-f]{6}$/i.test(info?.color ?? "") ? `#${info.color}` : "#12355b";
  const words = team.name.trim().split(/\s+/);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  return `<span class="school-mark" aria-hidden="true" style="--school-color:${color}"><span class="school-monogram">${esc(initials)}</span>
    <img src="${info?.logo ? safeUrl(info.logo) : logo(team.id)}" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.hidden=true"></span>`;
}
const winner = (g) => (g.final && g.teams[0].score !== g.teams[1].score ? (g.teams[0].score > g.teams[1].score ? 0 : 1) : -1);
const known = (g) => g.teams.every((t) => t.id);
const scores = (g) => (!g.final && g.live && Array.isArray(g.live.scores) ? g.live.scores : g.teams.map((t) => t.score));
const tbd = (name) => esc(String(name || "To be decided").replace(/^Winner G/, "Winner of Game "));
const liveOnes = (b) => b.games.filter((g) => status(g) === "live");

function badge(g, st, pastKickoff) {
  if (st === "live") return `<span class="match-status live"><i class="dot" aria-hidden="true"></i>Live${g.live?.period ? ` · ${esc(period(g.live.period))}` : ""}</span>`;
  if (st === "final") return `<span class="match-status final">Final</span>`;
  return `<span class="match-status upcoming">${pastKickoff ? "Score pending" : esc(shortWhen(g.kickoff))}</span>`;
}

function teamRow(t, won, score) {
  if (!t.id) return `<div class="team"><span class="tbd">${tbd(t.name)}</span></div>`;
  return `<div class="team${won ? " won" : ""}">
    ${schoolMark(t)}
    <button class="name" type="button" data-team="${esc(t.id)}">${esc(t.name)}${t.record ? ` <small>(${esc(t.record)})</small>` : ""}</button>
    ${won ? '<span class="wonword"><span aria-hidden="true">✓</span><span class="visually-hidden">Winner</span></span>' : ""}
    <span class="seed">${esc(seedShort(t.seed))}</span>
    <span class="score">${score ?? ""}</span>
  </div>`;
}

function gameCard(g, now = nowWall()) {
  const st = status(g);
  const pastKickoff = st === "upcoming" && kickoffPassed(g, now);
  const sc = scores(g);
  const w = sc.every(Number.isFinite) ? winner(g) : -1;
  const matchup = g.teams.map((t) => t.name).filter(Boolean).join(" vs. ");
  const place = where(g);
  const nfhs = g.watch
    ? `<a href="${safeUrl(g.watch)}" target="_blank" rel="noopener" aria-label="Watch · NFHS Network · ${esc(matchup)}">Watch · NFHS</a>`
    : known(g) && st !== "final"
      ? `<a href="https://www.nfhsnetwork.com/search?query=${encodeURIComponent(g.teams[0].name)}" target="_blank" rel="noopener" aria-label="Find · NFHS Network · ${esc(matchup)}">Find · NFHS</a>`
      : "";
  const mpLabel = st === "live" ? (g.live_scoring ? "Live score" : "Updates") : st === "final" ? "Recap" : "Preview";
  const mp = g.game_url ? `<a href="${safeUrl(g.game_url)}" target="_blank" rel="noopener" aria-label="${mpLabel} · MaxPreps · ${esc(matchup)}">${mpLabel} · MaxPreps</a>` : "";
  const note = st === "live"
    ? sc.some(Number.isFinite)
      ? `<span class="score-note">${g.live?.at ? `As of ${esc(clock(g.live.at))} CT` : "Live score"}</span>`
      : '<span class="score-note">Score pending</span>'
    : "";
  return `<article class="game desk-game ${st}${state.hit === g.id ? " hit" : ""}" id="g-${esc(g.id)}">
    <div class="head"><span>${esc(g.num.replace("G", "Game "))} · ${esc(g.round)}${g.region ? ` · Region ${esc(g.region)}` : ""}</span>${badge(g, st, pastKickoff)}</div>
    <div class="matchup">${g.teams.map((t, i) => teamRow(t, i === w, sc[i])).join("")}</div>
    ${place ? `<div class="place"><span class="where">${esc(place)}</span></div>` : ""}
    ${nfhs || mp || note ? `<div class="provider-links">${nfhs}${mp}${note}</div>` : ""}
    ${(st !== "upcoming" || pastKickoff) && g.kickoff ? `<div class="game-kickoff">Kickoff ${esc(when(g.kickoff))}</div>` : ""}
  </article>`;
}

const bracketPicks = new Map();
let lastBracketPick;
let treeSection;

const slotFeeder = (t, game, byNumber) => {
  const source = !t.id && byNumber.get(/^Winner (G\d+)$/i.exec(t.name)?.[1].toUpperCase());
  return source && source.next === game.id ? source : null;
};

function projectedTeams(b) {
  const gamesByNumber = new Map(b.games.map((g) => [g.num, g]));
  const advancing = new Map();
  return new Map(b.games.map((g) => {
    const teams = g.teams.map((t) => {
      if (t.id) return t;
      const source = slotFeeder(t, g, gamesByNumber);
      const projected = source && advancing.get(source.id);
      return projected || t;
    });
    const pick = teams.find((t) => t.id && t.id === bracketPicks.get(g.id));
    if (!g.final && pick) advancing.set(g.id, { ...pick, hypothetical: true });
    else {
      bracketPicks.delete(g.id);
      const actual = g.teams[winner(g)];
      if (actual?.id) advancing.set(g.id, actual);
    }
    return [g.id, teams];
  }));
}

function forecastRoute(b, projected) {
  const start = lastBracketPick?.code === b.code && b.games.find((g) => g.id === lastBracketPick.game);
  const team = start && projected.get(start.id).find((t) => t.id === bracketPicks.get(start.id));
  if (!team) return "";
  const byId = new Map(b.games.map((g) => [g.id, g]));
  const byNumber = new Map(b.games.map((g) => [g.num, g]));
  function options(slot, game) {
    if (slot.id) return [slot];
    const source = slotFeeder(slot, game, byNumber);
    if (!source) return [];
    const slots = projected.get(source.id);
    const priorWinner = source.final ? slots[winner(source)] : slots.find((t) => t.id === bracketPicks.get(source.id));
    if (priorWinner?.id) return [priorWinner];
    return slots.flatMap((t) => options(t, source));
  }
  function opponentText(slot, game) {
    if (slot.id) return esc(slot.name);
    const candidates = [...new Map(options(slot, game).map((t) => [t.id, t.name])).values()];
    const listed = candidates.slice(0, 4).map(esc).join(" / ");
    const more = candidates.length > 4 ? ` +${candidates.length - 4} more` : "";
    return tbd(slot.name) + (listed ? ` (${listed}${more})` : "");
  }
  const route = [];
  for (let feeder = start, game = byId.get(start.next); game; feeder = game, game = byId.get(game.next)) {
    const teams = projected.get(game.id);
    const slot = game.teams.findIndex((t) => t.id === team.id || (!t.id && t.name === `Winner ${feeder.num}`));
    const opponents = slot < 0 ? teams.filter((t) => t.id !== team.id) : [teams[1 - slot]];
    const label = opponents.map((t) => opponentText(t, game)).join(" or ");
    route.push(`<li><b>${esc(game.round)}</b> ${label}</li>`);
    if (game.final && game.teams[winner(game)]?.id !== team.id) break;
  }
  return `<div class="forecast-route" aria-live="polite"><strong>Possible path for ${esc(team.name)}</strong>
    ${route.length ? `<ol>${route.join("")}</ol>` : "<span> Championship pick</span>"}</div>`;
}

function cell(g, style, teams) {
  const st = status(g);
  const sc = scores(g);
  const w = sc.every(Number.isFinite) ? winner(g) : -1;
  const gameLabel = g.num.replace("G", "Game ");
  const row = (t, i) =>
    t.id
      ? `<div class="row${i === w ? " won" : ""}"${t.hypothetical ? " data-pick-projected" : ""}>
        ${schoolMark(t)}
        <div class="who"><button class="name" type="button" data-team="${esc(t.id)}">${esc(t.name)}</button></div>
        ${sc[i] == null ? "" : `<b class="pts">${sc[i]}</b>`}
        ${i === w ? '<span class="visually-hidden">Winner</span>' : ""}
        ${g.final ? "" : `<button class="pick-winner" type="button" data-pick-winner="${esc(g.id)}" data-pick-team="${esc(t.id)}"
          aria-label="Pick ${esc(t.name)} to win ${esc(gameLabel)}" aria-pressed="${bracketPicks.get(g.id) === t.id}">↗</button>`}</div>`
      : `<div class="row"><span class="tbd">${tbd(t.name)}</span></div>`;
  const tag = st === "live" ? `<span class="st live"><i class="dot"></i>LIVE${g.live?.period ? ` · ${esc(g.live.period)}` : ""}</span>` : st === "final" ? `<span class="st final">FINAL</span>` : `<span class="st soon">${esc(shortWhen(g.kickoff))}</span>`;
  const cls = ["cell", st, state.hit === g.id ? "hit" : "", state.path && g.teams.some((t) => t.id === state.path) ? "path" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}" id="g-${esc(g.id)}" data-game="${esc(g.id)}" style="${style}">
    <button class="tag" type="button" tabindex="-1" aria-label="Open ${esc(gameLabel)}"><span class="gnum">${esc(gameLabel)}</span>${tag}</button>
    ${teams.map(row).join("")}
    <div class="foot"><span class="town">${esc(g.town || g.city || g.stadium || "")}</span><button class="more" type="button" data-game="${esc(g.id)}" aria-label="Details for ${esc(gameLabel)}">Details <span aria-hidden="true">›</span></button></div>
  </div>`;
}

// A connected bracket: one grid, rounds in alternating cell/gap columns, two grid rows per first-round game.
function grid(b, games, compact, projected) {
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
  const heads = rounds.map((r, k) => `<h3 data-tree-round="${esc(r)}" style="grid-column:${2 * k + 1};grid-row:1">${esc(r)}<small>${byRound[k].length} ${byRound[k].length === 1 ? "game" : "games"}</small></h3>`);
  const cells = games.map((g) => {
    const p = pos.get(g.id);
    return cell(g, `grid-column:${2 * rounds.indexOf(g.round) + 1};grid-row:${p.row} / span ${p.span}`, projected.get(g.id));
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

function renderRounds(b) {
  const competitions = b ? [b] : Object.values(state.data);
  const rounds = [...new Set(competitions.flatMap((competition) => competition.rounds))];
  const games = competitions.flatMap((competition) => competition.games);
  const live = games.filter((g) => status(g) === "live");
  const defaultView = b ? defaultRound(b) : "current";
  if (state.round === "live" && !live.length) state.round = defaultView;
  const tabs = b ? [...rounds, "all"] : ["current", ...rounds, "all"];
  if (state.round !== "live" && !tabs.includes(state.round)) state.round = defaultView;
  const roundLabel = (round) => ({ live: "Live now", current: "Current rounds", all: "All rounds" })[round] || round;
  const stages = state.round === "current" ? new Set(competitions.map(defaultRound)) : new Set();
  const activeRound = stages.size === 1 ? stages.values().next().value : state.round;
  $("#round-title").textContent = roundLabel(activeRound);
  const roundIndex = rounds.indexOf(activeRound);
  for (const [id, index, arrow] of [["#round-prev", roundIndex - 1, "‹"], ["#round-next", roundIndex + 1, "›"]]) {
    const control = $(id);
    const round = roundIndex >= 0 ? rounds[index] : null;
    control.hidden = !round;
    if (round) {
      control.dataset.round = round;
      const label = roundLabel(round);
      control.textContent = id === "#round-prev" ? `${arrow} ${label}` : `${label} ${arrow}`;
    }
  }
  $("#rounds").innerHTML =
    (live.length ? `<button class="livebtn" type="button" data-round="live" ${current(state.round === "live")}><i class="dot"></i>Live now (${live.length})</button>` : "") +
    tabs.map((r) => `<button type="button" data-round="${esc(r)}" ${current(r === activeRound)}>${esc(roundLabel(r))}${liveDot(live.filter((g) => g.round === r).length)}</button>`).join("");
  const regional = !b || state.round === "live" || !b.stateRounds.includes(state.round);
  let list = state.round === "all" ? games : games.filter((g) => g.round === state.round);
  if (state.round === "live") list = live;
  if (state.round === "current") {
    list = competitions.flatMap((competition) => {
      const round = defaultRound(competition);
      return competition.games.filter((g) => g.round === round && known(g));
    });
  }
  const present = REGIONS.filter((r) => list.some((g) => g.region === r));
  $("#regions").hidden = !regional || !present.length;
  if (regional && present.length) {
    if (state.region !== "all" && !present.includes(state.region)) state.region = "all";
    $("#regions").innerHTML =
      `<button type="button" data-region="all" ${current(state.region === "all")}>All regions</button>` +
      present.map((r) => `<button type="button" data-region="${r}" ${current(r === state.region)}>Region ${r}${liveDot(list.filter((g) => g.region === r && status(g) === "live").length)}</button>`).join("");
    if (state.region !== "all") list = list.filter((g) => g.region === state.region);
  }
  const now = nowWall();
  const groups = { live: [], upcoming: [], final: [] };
  list.forEach((g) => groups[status(g)].push(g));
  const competitionSections = Object.fromEntries(competitions.map((competition) => [competition.code, new Set(competition.games)]));
  const cards = (games) => `<div class="game-cards">${games.map((g) => gameCard(g, now)).join("")}</div>`;
  const displayGames = (games) => b ? cards(games) : competitions.map(({ code, label }) => {
    const sectionGames = games.filter((g) => competitionSections[code].has(g));
    return sectionGames.length ? `<section data-competition="${esc(code)}"><h4 class="scoreboard-competition">${esc(label)}</h4>${cards(sectionGames)}</section>` : "";
  }).join("");
  const labels = {
    live: "Live now",
    upcoming: groups.upcoming.some((g) => kickoffPassed(g, now)) ? "Upcoming or score pending" : "Upcoming",
    final: "Final",
  };
  $("#games").innerHTML = list.length
    ? Object.entries(groups)
        .filter(([, games]) => games.length)
        .map(([statusKey, games]) => `<section class="game-column" data-status="${statusKey}" aria-labelledby="games-${statusKey}">
          <h3 id="games-${statusKey}">${labels[statusKey]} <small>${games.length} ${games.length === 1 ? "game" : "games"}</small></h3>
          ${displayGames(games)}
        </section>`)
        .join("")
    : `<p class="empty">No games to show here.</p>`;
}

function renderTree(b, live) {
  const present = REGIONS.filter((r) => b.games.some((g) => g.region === r));
  const tabs = [...present.map((r) => [r, `Region ${r}`]), ["state", "State"]];
  tabs.push(["all", "Whole bracket"]);
  if (!tabs.some(([k]) => k === state.tab)) state.tab = tabs[0][0];
  $("#tabs").innerHTML = tabs
    .map(([k, label]) => {
      const n = live.filter((g) => (k === "all" ? true : k === "state" ? !g.region : g.region === k)).length;
      return `<button type="button" data-tab="${k}" ${current(k === state.tab)}>${label}${liveDot(n)}</button>`;
    })
    .join("");
  const regional = REGIONS.includes(state.tab);
  const feederGames = new Set(b.games.filter((g) => g.region === state.tab));
  if (regional) {
    const byId = new Map(b.games.map((g) => [g.id, g]));
    for (const g of feederGames) {
      const next = byId.get(g.next);
      if (next) feederGames.add(next);
    }
  }
  const games = b.games.filter((g) => state.tab === "all" || (regional ? feederGames.has(g) : !g.region));
  const projected = projectedTeams(b);
  const intro = regional ? `Region ${state.tab} through the state final` : state.tab === "state" ? "State semifinals and championship" : "Whole tournament";
  const team = state.path && b.teams[state.path]?.name || (state.path && b.games.flatMap((g) => g.teams).find((t) => t.id === state.path)?.name);
  $("#tree-note").innerHTML =
    `<strong>${esc(intro)}</strong><span>Tap ↗ to pick a possible winner.</span>` +
    (b.games.some((g) => bracketPicks.has(g.id)) ? '<button class="clear-forecast" type="button" data-clear-picks>Clear picks</button>' : "") +
    (team ? `<span class="pathbar">${esc(team)}'s games are highlighted <button class="plain" type="button" data-clear-path="1">Clear</button></span>` : "") +
    forecastRoute(b, projected);
  const tree = $("#tree");
  tree.innerHTML = games.length ? grid(b, games, state.tab === "all", projected) : `<p class="empty">No games to show here.</p>`;
  const section = `${b.code}/${state.tab}`;
  if (treeSection === section) return null;
  treeSection = section;
  const first = b.rounds.find((round) => games.some((g) => g.round === round && !g.final));
  const heading = first && tree.querySelector(`[data-tree-round="${CSS.escape(first)}"]`);
  return wide.matches || !heading ? 0 : heading.offsetLeft - tree.offsetLeft;
}

function defaultRound(b) {
  return b.rounds.find((r) => b.games.some((g) => g.round === r && !g.final)) || b.rounds.at(-1);
}

function render() {
  const { index, data } = state;
  const focused = document.activeElement;
  const focusKey = ["code", "round", "region", "tab"].find((key) => focused?.dataset[key]);
  const b = data[state.code];
  $("#brackets").hidden = state.view === "map";
  $("#brackets [data-code='all']").hidden = state.view === "bracket";
  $("#brackets [data-code='all']").setAttribute("aria-current", String(!b));
  $("#title").textContent = b?.label ?? "Statewide scoreboard";
  $("#competition-choices").innerHTML = index.brackets.filter((_, i) => i % 2 === 0).map((divisionOne, i) => {
    const className = divisionOne.code.slice(0, 2);
    const pair = index.brackets.slice(i * 2, i * 2 + 2);
    return `<div class="competition-class"><b>${esc(className)}${className === "1A" ? '<small> Six-man</small>' : ""}</b>
      <div>${pair.map((entry, division) => `<button type="button" data-code="${esc(entry.code)}" aria-label="${esc(entry.label)}" ${current(entry.code === state.code)}>${division === 0 ? "I" : "II"}</button>`).join("")}</div></div>`;
  }).join("");
  $("#updated").textContent =
    "Updated " +
    new Date(index.updated).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) +
    " CT";

  $("#bracket").hidden = state.view === "map";
  $("#views").hidden = false;
  $("#q").disabled = false;
  $("#status").hidden = true;
  const y = scrollY;
  const tx = $("#tree").scrollLeft;

  document.querySelectorAll("#views button").forEach((el) => el.setAttribute("aria-current", el.dataset.view === state.view));
  $("#rounds-view").hidden = state.view !== "rounds";
  $("#bracket-view").hidden = state.view !== "bracket";
  $("#map-view").hidden = state.view !== "map";
  $(".legend").hidden = state.view === "map";
  $("main").classList.toggle("wide", state.view === "bracket" && wide.matches);
  if (state.view === "rounds") renderRounds(b);
  const nextTreePosition = state.view === "bracket" && b ? renderTree(b, liveOnes(b)) : null;
  if (state.view !== "bracket") treeSection = null;
  if (focusKey && !focused.isConnected) {
    const selector = `[data-${focusKey}="${CSS.escape(focused.dataset[focusKey])}"]`;
    const scope = focusKey === "round" ? $("#rounds") : document;
    scope.querySelector(selector)?.focus({ preventScroll: true });
  } else if (focused?.matches(".round-head button[hidden]")) {
    $("#rounds [aria-current='true']")?.focus({ preventScroll: true });
  }
  history.replaceState(null, "", hash() || location.pathname + location.search);
  scrollTo(scrollX, y);
  $("#tree").scrollLeft = nextTreePosition ?? tx;
  if (state.view === "bracket") updateTreeNavigation();
  if (state.view === "map" && !mapReady()) {
    Promise.allSettled([loadComps(), state.teamsUpdated || loadTeams()]).then(() => mapReady() && render());
  }
  document.dispatchEvent(new CustomEvent("playoffs:render"));
}

function hash() {
  if (state.view === "map") return state.code ? `#${state.code}/map` : "#map";
  const sub = state.view === "bracket" ? state.tab : state.region;
  const dflt = state.view === "bracket" ? "I" : "all";
  if (!state.code) return sub === dflt ? "" : `#all/rounds/${sub}`;
  const p = [state.code];
  if (state.view !== "rounds" || sub !== dflt) p.push(state.view);
  if (sub && sub !== dflt) p.push(sub);
  return "#" + p.join("/");
}

function setMapCode(code) {
  state.code = code;
  history.replaceState(null, "", hash());
}

function applyHash() {
  const [code, view, sub] = location.hash.slice(1).split("/");
  const knownCode = state.index.brackets.some((b) => b.code === code) ? code : null;
  state.view = code === "map" || view === "map" ? "map" : knownCode && view === "bracket" ? "bracket" : "rounds";
  state.code = knownCode;
  state.region = state.view === "rounds" ? sub || "all" : "all";
  state.tab = state.view === "bracket" ? sub || "I" : "I";
  state.path = null;
  return pick(knownCode);
}

async function pick(code, round, gameId) {
  state.want = code;
  if (code && !state.data[code]) await loadComp(code);
  if (state.want !== code) return;
  const b = state.data[code];
  if (code !== state.code) {
    state.region = "all";
    state.tab = "I";
    state.path = null;
  }
  state.code = code;
  if (state.view === "bracket" && code) state.bracketCode = code;
  if (state.view === "rounds") state.gamesCode = code;
  const defaultView = b ? defaultRound(b) : "current";
  state.round = round || (b && state.round === "live" && liveOnes(b).length ? "live" : defaultView);
  state.hit = gameId || null;
  if (gameId) {
    const g = b.games.find((x) => x.id === gameId);
    if (state.view === "bracket") state.tab = g?.region || "state";
    else {
      state.view = "rounds";
      state.gamesCode = code;
      state.region = "all";
      state.round = g?.round || state.round;
    }
  }
  render();
  const target = gameId && document.getElementById("g-" + gameId);
  if (target) {
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", inline: "center" });
  }
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
  if (!t?.url) {
    return `<div class="team-head">${schoolMark(slot)}<div><h2>${esc(slot.name)}</h2><p>${esc(b.label)}</p></div></div>
      <p>More details for this team have not been collected yet.</p>
      ${slot.url ? `<p><a class="btn" href="${safeUrl(slot.url)}" target="_blank" rel="noopener">Team page on MaxPreps</a></p>` : ""}`;
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
          ${bracketGame ? `<button class="plain" type="button" data-game="${esc(bracketGame.id)}" data-go="1" data-go-view="bracket">Show in bracket</button>` : ""}</td>
        <td class="res ${/^[WLT]/.test(s.result || "") ? s.result[0] : ""}">${res}</td></tr>`;
    })
    .join("");
  const leaders = (t.leaders || [])
    .map((l) => `<tr><td>${esc(l.stat)}</td><td>${esc(l.player)} <small>${esc(l.pos)}</small></td><td class="res">${esc(l.value)}</td></tr>`)
    .join("");
  return `<div class="team-head" style="border-color:#${/^[0-9a-f]{6}$/i.test(t.color) ? t.color : "12355b"}">
      ${schoolMark(slot)}<div><h2>${esc(t.name)} ${esc(t.mascot || "")}</h2>
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

let detailGame;
function open(html, gameId) {
  if (!html) return;
  detailGame = gameId ? { id: gameId, html } : null;
  $("#panel-body").innerHTML = html;
  if (!$("#panel").open) $("#panel").showModal();
  $("#panel").scrollTop = 0;
}

function refreshGameDetail() {
  const panel = $("#panel");
  if (!panel.open || !detailGame) return;
  const [, game] = findGame(detailGame.id);
  if (!game) return;
  const html = gameCard(game);
  if (html === detailGame.html) return;
  const focused = document.activeElement;
  const key = focused.dataset.team ? "data-team" : focused.hasAttribute("href") ? "href" : null;
  const scroll = panel.scrollTop;
  detailGame.html = html;
  $("#panel-body").innerHTML = html;
  if (key) {
    const next = panel.querySelector(`[${key}="${CSS.escape(focused.getAttribute(key))}"]`);
    (next || panel.querySelector(".close")).focus({ preventScroll: true });
  }
  panel.scrollTop = scroll;
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

function updateTreeNavigation() {
  const tree = $("#tree");
  $("#tree-prev").disabled = tree.scrollLeft <= 0;
  $("#tree-next").disabled = tree.scrollLeft + tree.clientWidth >= tree.scrollWidth - 1;
}
$("#tree").addEventListener("scroll", updateTreeNavigation, { passive: true });

function stepTree(dir) {
  const t = $("#tree");
  const heads = t.querySelectorAll("h3");
  const unit = heads.length > 1 ? heads[1].offsetLeft - heads[0].offsetLeft : t.clientWidth;
  t.scrollTo({ left: (Math.round(t.scrollLeft / unit) + dir) * unit });
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-code],[data-round],[data-region],[data-view],[data-tab],[data-clear-path],[data-pick-winner],[data-clear-picks],[data-team],[data-game],.close,#tree-prev,#tree-next");
  if (!el) return;
  if (el.matches(".close")) return $("#panel").close();
  if (el.id === "tree-prev") return stepTree(-1);
  if (el.id === "tree-next") return stepTree(1);
  if (el.dataset.code) {
    return pick(el.dataset.code === "all" ? null : el.dataset.code);
  }
  if (el.dataset.round) {
    if (el.dataset.view) state.view = el.dataset.view;
    return pick(state.code, el.dataset.round);
  }
  if (el.dataset.view) {
    const previousView = state.view;
    state.view = el.dataset.view;
    if (state.view === previousView) return;
    if (state.view === "bracket") return pick(state.bracketCode || (previousView === "rounds" && state.code) || state.index.brackets[0].code);
    if (state.view === "map") return pick(null);
    return pick(state.gamesCode ?? null);
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
  if (el.hasAttribute("data-clear-picks")) {
    state.data[state.code].games.forEach((g) => bracketPicks.delete(g.id));
    lastBracketPick = null;
    render();
    return $("#tabs [aria-current='true']")?.focus({ preventScroll: true });
  }
  if (el.dataset.pickWinner) {
    const { pickWinner, pickTeam } = el.dataset;
    if (bracketPicks.get(pickWinner) === pickTeam) {
      bracketPicks.delete(pickWinner);
      lastBracketPick = null;
    } else {
      bracketPicks.set(pickWinner, pickTeam);
      lastBracketPick = { code: state.code, game: pickWinner };
    }
    render();
    return $(`[data-pick-winner="${CSS.escape(pickWinner)}"][data-pick-team="${CSS.escape(pickTeam)}"]`)?.focus({ preventScroll: true });
  }
  if (el.dataset.team) {
    if (el.closest("#tree")) {
      state.path = el.dataset.team;
      render();
    }
    const ask = (state.asked = el.dataset.team);
    return loadTeam(ask).catch(() => {}).then(() => state.asked === ask && open(teamPanel(ask)));
  }
  const [b, g] = findGame(el.dataset.game);
  if (!g) return;
  if (el.dataset.go) {
    $("#panel").close();
    $("#results").hidden = true;
    $("#q").value = "";
    state.view = el.dataset.goView === "bracket" ? "bracket" : "rounds";
    return pick(b.code, g.round, g.id);
  }
  if (el.matches("#tree .cell")) el.querySelector(".more")?.focus({ preventScroll: true });
  state.asked = null;
  open(gameCard(g), g.id);
});
$("#panel").addEventListener("click", (e) => e.target === $("#panel") && $("#panel").close());
$("#q").addEventListener("input", (e) => search(e.target.value));
wide.addEventListener("change", () => $("#status").hidden && render());
addEventListener("hashchange", () => $("#status").hidden && location.hash !== hash() && applyHash());

async function refresh() {
  try {
    await load();
    if (!state.teamsUpdated) await loadTeams();
    await loadComps();
    if ($("#status").hidden) render();
    else await applyHash();
    refreshGameDetail();
  } catch (err) {
    if (!$("#status").hidden) $("#status").textContent = "The brackets could not be loaded. Please try again in a few minutes.";
  }
}
window.Playoffs = { state, status, gameCard, open, teamPanel, pick, where, setMapCode, schoolMark };
document.addEventListener("DOMContentLoaded", refresh, { once: true });
setInterval(refresh, 60 * 1000);
