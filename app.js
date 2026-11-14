const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");

const state = { index: null, data: {}, code: null, round: null, tree: false, hit: null };
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
function prepare(b) {
  const count = {};
  b.games.forEach((g) => (count[g.round] = (count[g.round] || 0) + 1));
  b.rounds = Object.keys(count).sort((x, y) => count[y] - count[x]);
  const feeders = {};
  b.games.forEach((g) => g.next && (feeders[g.next] ||= []).push(g));
  const ordered = [];
  const walk = (g) => {
    (feeders[g.id] || []).forEach(walk);
    ordered.push(g);
  };
  b.games.filter((g) => !g.next).forEach(walk);
  b.games = ordered;
  return b;
}

const fmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function when(k) {
  if (!k) return "Date to be announced";
  const [y, mo, d, h, mi] = k.split(/[-T:]/).map(Number);
  if (!h && !mi) return `${day(k)} · time to be announced`;
  return fmt.format(new Date(y, mo - 1, d, h, mi));
}
function day(k) {
  if (!k) return "To be announced";
  const [y, mo, d] = k.split(/[-T:]/).map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function seed(s) {
  const m = /^([A-Z])(\d+)$/.exec(s || "");
  if (!m) return esc(s);
  const place = { W: "champion", R: "runner-up", T: "3rd place", F: "4th place" }[m[1]];
  return place ? `District ${m[2]} ${place}` : esc(s);
}

const logo = (id) => `https://image.maxpreps.io/school-mascot/${esc(id[0])}/${esc(id[1])}/${esc(id[2])}/${esc(id)}.gif?width=96&height=96&fit=bounds`;
const winner = (g) => (g.final && g.teams[0].score !== g.teams[1].score ? (g.teams[0].score > g.teams[1].score ? 0 : 1) : -1);
const known = (g) => g.teams.every((t) => t.id);

function teamRow(t, won) {
  if (!t.id) return `<div class="team"><span class="tbd">${esc(t.name.replace(/^Winner G/, "Winner of Game "))}</span></div>`;
  return `<div class="team${won ? " won" : ""}">
    <img src="${logo(t.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <button class="name" type="button" data-team="${esc(t.id)}">${esc(t.name)}${t.record ? ` <small>(${esc(t.record)})</small>` : ""}</button>
    <span class="seed">${seed(t.seed)}</span>
    <span class="score">${t.score ?? ""}</span>
  </div>`;
}

function gameCard(g) {
  const w = winner(g);
  const where =
    g.stadium ||
    (g.city && `In ${g.city} (stadium not posted)`) ||
    (g.host && `Home team: ${g.host} (stadium not posted)`) ||
    (known(g) ? "Location not posted yet" : "");
  const watch = g.nfhs_url
    ? `<a class="btn watch" href="${safeUrl(g.nfhs_url)}" target="_blank" rel="noopener">▶ Watch on NFHS Network</a>`
    : known(g)
      ? `<a class="btn" href="https://www.nfhsnetwork.com/search?query=${encodeURIComponent(g.teams[0].name)}" target="_blank" rel="noopener">Look for this game on NFHS</a>`
      : "";
  const summary = g.game_url ? `<a class="btn" href="${safeUrl(g.game_url)}" target="_blank" rel="noopener">Game summary on MaxPreps</a>` : "";
  return `<article class="game${state.hit === g.id ? " hit" : ""}" id="g-${esc(g.id)}">
    <div class="when"><span>${esc(g.num.replace("G", "Game "))} · ${when(g.kickoff)}</span>
      <span class="where">${esc(where)}</span>${g.final ? '<span class="badge">FINAL</span>' : ""}</div>
    ${g.teams.map((t, i) => teamRow(t, i === w)).join("")}
    ${watch || summary ? `<div class="actions">${watch}${summary}</div>` : ""}
  </article>`;
}

function treeCell(g) {
  const w = winner(g);
  const line = (t, i) =>
    `<span class="${i === w ? "w" : ""}"><span>${esc(t.id ? t.name : t.name.replace(/^Winner G/, "Winner Game "))}</span><b>${t.score ?? ""}</b></span>`;
  return `<button class="cell" type="button" data-game="${esc(g.id)}">${g.teams.map(line).join("")}<em>${g.final ? "Final" : when(g.kickoff)}</em></button>`;
}

function render() {
  const { index, data } = state;
  const confs = {};
  index.brackets.forEach((b) => (confs[b.label.replace(/ Division.*/, "")] ||= []).push(b));
  $("#brackets").innerHTML = Object.entries(confs)
    .map(
      ([conf, list]) =>
        `<div class="conf"><b>${esc(conf.replace(" Six-Man", ""))}</b>${list
          .map((b) => `<button class="pick" type="button" data-code="${b.code}" aria-current="${b.code === state.code}">${esc(b.label.replace(/.*(Division)/, "$1"))}</button>`)
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
  const tree = state.tree && wide.matches;
  $("main").classList.toggle("wide", tree);
  $("#title").textContent = b.label;
  $("#view").textContent = tree ? "Show one round at a time" : "Show the full bracket";
  $("#view").hidden = !wide.matches;
  $("#rounds").hidden = tree;
  $("#rounds").innerHTML = b.rounds
    .map((r) => `<button type="button" data-round="${esc(r)}" aria-current="${r === state.round}">${esc(r)}</button>`)
    .join("");
  $("#games").innerHTML = tree
    ? `<div class="tree">${b.rounds
        .map((r) => `<div class="col"><h3>${esc(r)}</h3><div class="slots">${b.games.filter((g) => g.round === r).map(treeCell).join("")}</div></div>`)
        .join("")}</div>`
    : b.games.filter((g) => g.round === state.round).map(gameCard).join("");
}

function pick(code, round, gameId) {
  const b = state.data[code];
  if (!b) return;
  state.code = code;
  state.round = round || b.rounds.find((r) => b.games.some((g) => g.round === r && !g.final)) || b.rounds.at(-1);
  state.hit = gameId || null;
  if (gameId) state.tree = false;
  history.replaceState(null, "", "#" + code);
  render();
  if (gameId) document.getElementById("g-" + gameId)?.scrollIntoView({ block: "center" });
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
  const head = t.staff.find((s) => /head coach/i.test(s.role));
  const others = t.staff.filter((s) => s !== head);
  const rows = t.schedule
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
  const leaders = t.leaders
    .map((l) => `<tr><td>${esc(l.stat)}</td><td>${esc(l.player)} <small>${esc(l.pos)}</small></td><td class="res">${esc(l.value)}</td></tr>`)
    .join("");
  return `<div class="team-head" style="border-color:#${/^[0-9a-f]{6}$/i.test(t.color) ? t.color : "12355b"}">
      <img src="${logo(id)}" alt=""><div><h2>${esc(t.name)} ${esc(t.mascot || "")}</h2>
      <p>${esc(t.city)}, Texas · ${esc(b.label)}</p></div></div>
    <dl class="facts">
      ${fact("Record", t.record)}
      ${fact("District", t.district_record ? `${t.district_record}${t.district_place ? ` (${t.district_place})` : ""}` : null)}
      ${fact("Points scored", t.pf)}${fact("Points allowed", t.pa)}
      ${fact("Home", t.home)}${fact("Away", t.away)}
      ${fact("Streak", t.streak ? `${{ W: "Won", L: "Lost", T: "Tied" }[t.streak[0]] || ""} ${t.streak.slice(1)}` : null)}
      ${fact("Head coach", head?.name)}
    </dl>
    <p>${esc(t.district)}</p>
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

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-code],[data-round],[data-team],[data-game],.close,#view");
  if (!el) return;
  if (el.matches(".close")) return $("#panel").close();
  if (el.id === "view") {
    state.tree = !state.tree;
    return render();
  }
  if (el.dataset.code) return pick(el.dataset.code);
  if (el.dataset.round) return pick(state.code, el.dataset.round);
  if (el.dataset.team) return open(teamPanel(el.dataset.team));
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
wide.addEventListener("change", render);
addEventListener("hashchange", () => location.hash.slice(1) !== state.code && pick(location.hash.slice(1)));

async function refresh() {
  try {
    if (await load()) state.code ? render() : pick(state.data[location.hash.slice(1)] ? location.hash.slice(1) : state.index.brackets[0].code);
  } catch (err) {
    if (!state.index) $("#status").textContent = "The brackets could not be loaded. Please try again in a few minutes.";
  }
}
refresh();
setInterval(refresh, 5 * 60 * 1000);
