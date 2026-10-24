// Deadlock Damage Lab: UI for the custom damage test (live sim in worker.js) and the precomputed build searches.
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n, d = 0) => (n == null || !isFinite(n) ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (n, d = 0) => (n == null ? "–" : fmt(n * 100, d) + "%");
const signed = (n) => (n > 0 ? "+" : "") + fmt(n * 100, 0) + "%";
const getJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); };

const OBJ = { burst_5s: "5 s", fight_15s: "15 s", sustained_30s: "30 s" };
const OBJ_MARK = { burst_5s: "5s", fight_15s: "15s", sustained_30s: "30s" };
const MARK_LABEL = { "5s": "5 s", "15s": "15 s", "30s": "30 s" };
const OBJ_LONG = { burst_5s: "First 5 s (burst)", fight_15s: "First 15 s (a fight)", sustained_30s: "Full 30 s (sustained)" };
const SERIES = ["--accent", "--brass", "--spirit", "--weapon", "--vitality", "--muted"];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const S = {
  whenReady: null, readyNow: null,
  items: {}, byName: {}, heroes: [], heroById: {},
  A: { hero: 13, souls: 27000, aim: "p75", items: [], label: null, order: null, preset: null },   // order: ability ids (API format), null = popular; preset: renderPresets key while the build is untouched
  D: { mode: "plain", hero: 6, souls: null, items: [] },
  dmgCache: {}, last: null, prev: null, pins: [], engine: null, ready: false, runId: 0, pending: {}, running: false, again: false, autoT: 0,
};

S.whenReady = new Promise((res) => (S.readyNow = res));
S.dataReady = new Promise((res) => (S.dataNow = res));

// ---------- data ----------
const cached = {};
async function load(path) {
  if (!(path in cached)) cached[path] = getJSON(path).catch(() => null);
  return cached[path];
}
const damageHero = (id) => load(`data/damage/heroes/${id}.json`);

function nearestBudget(keys, souls) {
  const ks = keys.map(Number).sort((a, b) => a - b);
  return String(ks.reduce((best, k) => (Math.abs(k - souls) < Math.abs(best - souls) ? k : best), ks[0]));
}

// ---------- item tiles ----------
function tile(id, opts = {}) {
  const it = S.items[id];
  if (!it) return "";
  const dot = it.effect_modeled ? "" : ' <span class="dot stats" title="Only its always-on stats are modeled"></span>';
  const cls = ["it", opts.cls || "", opts.remove ? "x" : "", opts.owned ? "owned" : "", opts.static ? "static" : ""].join(" ");
  const tag = opts.static ? "span" : "button";
  return `<${tag} class="${cls}" data-slot="${it.slot}" data-id="${id}" title="${esc(it.name)} · ${fmt(it.cost)} souls${it.effect_modeled ? "" : " · stats only"}">`
    + `${esc(it.name)}${dot}${opts.cost ? ` <span class="c">${fmt(it.cost / 1000, 1)}k</span>` : ""}</${tag}>`;
}
const tiles = (ids, opts) => `<div class="build">${ids.map((i) => tile(i, opts)).join("")}</div>`;
// a build whose items open the per-item breakdown when tapped; ctx = {kind, hero, souls, items, popular, hp?, mark?, req?}
const bdTiles = (ctx) => `<div class="build tap" data-bd="${esc(JSON.stringify(ctx))}">${ctx.items.map((i) => tile(i)).join("")}</div>`;

function renderShop(prefix, build) {
  const q = $(`#${prefix}-q`).value.trim().toLowerCase();
  const slot = $(`#${prefix}-slot .on`).dataset.v;
  const byTier = {};
  for (const [id, it] of Object.entries(S.items)) {
    if (slot && it.slot !== slot) continue;
    if (q && !it.name.toLowerCase().includes(q)) continue;
    (byTier[it.tier] ||= []).push(id);
  }
  const owned = new Set(build.map(String));
  $(`#${prefix}-shop`).innerHTML = Object.keys(byTier).sort().map((t) => {
    const ids = byTier[t].sort((a, b) => S.items[a].slot.localeCompare(S.items[b].slot) || S.items[a].name.localeCompare(S.items[b].name));
    return `<div class="tier"><b>${fmt(S.items[ids[0]].cost)}</b><div>${ids.map((id) => tile(id, { owned: owned.has(id) })).join("")}</div></div>`;
  }).join("") || '<p class="hint">No items match.</p>';
}

function wireShop(prefix, getBuild, onChange) {
  $(`#${prefix}-q`).addEventListener("input", () => renderShop(prefix, getBuild()));
  $(`#${prefix}-slot`).addEventListener("click", (e) => {
    if (!e.target.dataset || e.target.tagName !== "BUTTON") return;
    $$(`#${prefix}-slot button`).forEach((b) => b.classList.toggle("on", b === e.target));
    renderShop(prefix, getBuild());
  });
  const toggle = (e) => {
    const b = e.target.closest(".it"); if (!b) return;
    const id = Number(b.dataset.id), build = getBuild(), i = build.indexOf(id);
    if (i >= 0) build.splice(i, 1);
    else if (build.length < 12) build.push(id);
    else { fullNote(prefix); return; }
    onChange();
  };
  $(`#${prefix}-shop`).addEventListener("click", toggle);
  $(`#${prefix}-build`).addEventListener("click", toggle);
}

function fullNote(prefix) {
  const el = $(prefix === "a" ? "#a-budget" : "#d-build");
  $$(".full-note").forEach((x) => x.remove());
  el.insertAdjacentHTML("afterend", '<p class="hint full-note">12 items is the most a hero can hold. Remove one first.</p>');
  const n = el.nextElementSibling; setTimeout(() => n.remove(), 2500); // a no-op when a newer note already replaced it
}

// ---------- attacker ----------
function renderAttacker() {
  const A = S.A;
  $("#a-hero").value = A.hero;
  $("#a-souls").value = A.souls;
  $("#a-aim").value = A.aim;
  $("#custom-aim").hidden = A.aim !== "custom";
  const ids = [...A.items].sort((a, b) => S.items[a].slot.localeCompare(S.items[b].slot) || S.items[a].cost - S.items[b].cost);
  $("#a-build").innerHTML = ids.map((i) => tile(i, { remove: true, cost: true })).join("");
  const cost = A.items.reduce((s, i) => s + (S.items[i]?.cost || 0), 0);
  const share = A.souls > 0 ? cost / A.souls : 0;
  $("#a-bar").style.width = Math.min(100, share * 100) + "%";
  $("#a-bar").classList.toggle("over", cost > A.souls);
  $("#a-budget").textContent = `${fmt(cost)} of ${fmt(A.souls)} souls in items · ${A.items.length}/12`;
  renderShop("a", A.items);
  $("#a-abil").innerHTML = A.order
    ? `Abilities level in the recommended order from Raw damage builds. <button class="chip-btn" id="a-abil-pop">Use the popular order</button>`
    : "Abilities level in the most played real order.";
  if (A.order) $("#a-abil-pop").onclick = () => { A.order = null; A.label = null; renderAttacker(); autoRun(0); };
}

async function renderPresets() {
  const d = await damageHero(S.A.hero);
  const box = $("#presets");
  if (!d) { box.innerHTML = ""; return; }
  const bk = nearestBudget(Object.keys(d.budgets), S.A.souls), b = d.budgets[bk];
  const btn = (k, label) => `<button class="chip-btn" data-k="${k}">${label}</button>`;
  box.innerHTML = `<span class="hint">Load at ${fmt(bk / 1000)}k:</span>` + btn("popular", "Popular")
    + Object.entries(OBJ).map(([k, l]) => btn(k, `Most dmg ${l}`)).join("");
  box.onclick = (e) => {
    const k = e.target.dataset?.k; if (!k) return;
    applyPreset(d, k, Number(bk)); renderAttacker(); syncDummyHint(); autoRun(0);
  };
}
function applyPreset(d, k, bk) {
  const b = d.budgets[String(bk)], items = k === "popular" ? b.popular.items : b.objectives[k].builds[0].items;
  Object.assign(S.A, { items: [...items], souls: bk, preset: k, order: null, label: k === "popular" ? "Popular" : `Most dmg ${OBJ[k]}` });
}
// After a hero or net worth change, an untouched preset build follows to the new hero and budget (Haze's items on
// Abrams is never what a first-time visitor means); a hand-made build stays as it is.
async function followPreset() {
  const k = S.A.preset; if (!k) return;
  const hero = S.A.hero, d = await damageHero(hero);
  if (S.A.hero !== hero || S.A.preset !== k) return;
  if (!d) { S.A.preset = S.A.label = null; return; } // no precomputed builds for this hero: keep the items, drop the stale name
  const souls = S.A.souls, bk = nearestBudget(Object.keys(d.budgets), souls);
  applyPreset(d, k, Number(bk)); S.A.souls = souls;
  renderAttacker();
}

async function syncDummyHint() {
  const d = await damageHero(S.A.hero);
  if (!d) return;
  const bk = nearestBudget(Object.keys(d.budgets), S.A.souls);
  const hp = d.budgets[bk].dummy_hp;
  $("#d-hp-hint").innerHTML = `The precomputed searches use ${fmt(hp)} HP at ${fmt(bk / 1000)}k: the median max HP of real builds at that net worth. <button class="chip-btn" id="use-hp">Use ${fmt(hp)}</button>`;
  $("#use-hp").onclick = () => { $("#d-hp").value = hp; autoRun(0); };
}

// ---------- personal aim (aim.js) ----------
const AIM_KEY = "ddl.aim";
const AIM_FIELDS = { acc: "#a-acc", hs: "#a-hs", dist: "#a-dist", steam: "#a-steam" };

function saveAim() {
  try { localStorage.setItem(AIM_KEY, JSON.stringify(Object.fromEntries(Object.entries(AIM_FIELDS).map(([k, sel]) => [k, $(sel).value])))); } catch { /* storage off */ }
}

function restoreAim() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(AIM_KEY) || "null"); } catch { /* storage off */ }
  if (v) for (const [k, sel] of Object.entries(AIM_FIELDS)) if (v[k] != null && v[k] !== "") $(sel).value = v[k];
}

// Where the typed numbers sit among ranked players of this hero.
async function renderAimHint() {
  const d = await load("data/skill_defaults.json");
  const row = d && (d.heroes[S.A.hero] || d.all);
  if (!row) return;
  const acc = parseFloat($("#a-acc").value) / 100, hs = parseFloat($("#a-hs").value) / 100;
  const nth = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const say = (r) => (!r ? "–" : r.below ? "below the 25th" : r.above ? "above the 90th" : `about the ${nth(r.p)}`);
  const name = S.heroById[S.A.hero]?.name || "this hero";
  $("#a-dist").placeholder = `default ${fmt(row.median_distance_m, 1)}`;
  $("#a-aim-hint").textContent = `Hero-only numbers. Among ranked ${name} players that is ${say(Aim.percentile(acc, row.accuracy))} percentile for accuracy`
    + ` and ${say(Aim.percentile(hs, row.headshot))} for headshots (median ${pct(row.accuracy.p50, 1)} and ${pct(row.headshot.p50, 1)}).`;
}

async function pullAim() {
  const btn = $("#a-pull"), msg = $("#a-pull-msg");
  btn.disabled = true; msg.textContent = "Looking up the player…";
  try {
    const who = await Aim.resolve($("#a-steam").value);
    const hero = S.A.hero, heroName = S.heroById[hero]?.name || "this hero";
    const r = await Aim.fromMatches(who.id, hero, { onProgress: (a, b) => { msg.textContent = `Reading match ${a} of ${b}…`; } });
    if (S.A.hero !== hero) { msg.textContent = `The hero changed while loading ${heroName} matches. Press the button again.`; return; }
    $("#a-acc").value = (r.accuracy * 100).toFixed(1);
    $("#a-hs").value = (r.headshot * 100).toFixed(1);
    if (r.distance) $("#a-dist").value = r.distance.toFixed(1);
    msg.textContent = `${who.name ? `Steam player "${who.name}": ` : ""}${pct(r.accuracy, 1)} accuracy and ${pct(r.headshot, 1)} headshots over ${fmt(r.shots)} shots at heroes in the last ${r.matches} matches`
      + (r.scope === "hero" ? ` on ${heroName}` : ` (all heroes; fewer than 3 recent ${heroName} matches)`) + (r.distance ? `, median hit distance ${fmt(r.distance, 1)} m.` : ".")
      + (r.failed && r.matches < 10 ? ` ${r.failed} more could not be read (the API may be busy), so try again for a fuller sample.` : "");
    saveAim(); renderAimHint(); autoRun(0);
  } catch (e) {
    msg.textContent = e.message;
  } finally { btn.disabled = false; }
}

// ---------- target ----------
function renderTarget() {
  const D = S.D;
  $$("#d-mode button").forEach((b) => b.classList.toggle("on", b.dataset.v === D.mode));
  $("#d-plain").hidden = D.mode !== "plain";
  $("#d-hero").hidden = D.mode !== "hero";
  $("#d-heroname").value = D.hero;
  $("#d-build").innerHTML = D.items.map((i) => tile(i, { remove: true, cost: true })).join("");
  renderShop("d", D.items);
}

// the standard dummy walks out of Alchemical Fire after this long; boot() reads the published value
// (damage/scripts/dummy_search.py DUMMY_ZONE_EXIT, in data/damage/index.json)
let ZONE_EXIT_S = 2.0;

function request() {
  const A = S.A, D = S.D, num = (s) => { const v = parseFloat($(s).value); return isFinite(v) ? v : null; };
  const req = { hero: A.hero, items: [...A.items], souls: A.souls, aim: A.aim === "custom" ? "p50" : A.aim };
  if (A.order) req.ability_order = A.order;
  if (A.aim === "custom") { const pc = (sel) => { const v = num(sel); return v == null ? null : v / 100; }; req.accuracy = pc("#a-acc"); req.headshot = pc("#a-hs"); req.distance = num("#a-dist"); req.melee_rate = num("#a-mel"); }
  const immortal = $("#d-immortal").checked, zone_exit_s = $("#d-walk").checked ? ZONE_EXIT_S : null;
  if (D.mode === "plain") {
    req.dummy = { hero: "Haze", items: [], hp: num("#d-hp"), immortal, zone_exit_s,
      bullet_resist: (num("#d-br") || 0) / 100, spirit_resist: (num("#d-sr") || 0) / 100, melee_resist: (num("#d-mr") || 0) / 100 };
  } else {
    req.dummy = { hero: D.hero, items: [...D.items], souls: num("#d-souls"), immortal, zone_exit_s };
  }
  return req;
}

function targetLabel(req) {
  const d = req.dummy;
  if (d.hero !== "Haze" || d.items.length) return `${S.heroById[d.hero]?.name || d.hero}${d.items.length ? ` + ${d.items.length} items` : ""}`;
  const r = [d.bullet_resist, d.spirit_resist].map((x) => Math.round(x * 100));
  return `Dummy ${fmt(d.hp)} HP${r[0] || r[1] ? `, ${r[0]}/${r[1]}% res` : ""}`;
}

// ---------- engine ----------
function startEngine() {
  const base = new URL(".", location.href).href;
  const state = (s, t) => { $("#engine").dataset.state = s; $("#engine").textContent = t; };
  try {
    S.engine = new Worker(new URL("worker.js", location.href));
  } catch (e) {
    state("error", "Sim unavailable"); showErr("This browser could not start the sim: " + e.message); return;
  }
  S.engine.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") { S.ready = true; S.readyNow(); state("ready", "Sim ready"); $("#run").disabled = false; runTest(); }
    else if (m.type === "result") { S.pending[m.id]?.(m); delete S.pending[m.id]; }
    else if (m.type === "error") {
      if (m.id && S.pending[m.id]) { S.pending[m.id](m); delete S.pending[m.id]; }
      else { state("error", "Sim failed"); showErr("The sim could not load. " + lastLine(m.message)); }
    }
  };
  S.engine.onerror = (e) => { state("error", "Sim failed"); showErr("The sim could not load. " + (e.message || "")); };
  S.engine.postMessage({ type: "init", base, b64: !!window.__ARTIFACT__ });
}
const lastLine = (s) => String(s).trim().split("\n").filter(Boolean).pop();
function showErr(t) { $("#err").hidden = !t; $("#err").textContent = t || ""; }

function simCall(type, req) {
  return S.whenReady.then(() => new Promise((resolve, reject) => {
    const id = ++S.runId;
    S.pending[id] = (m) => (m.type === "error" ? reject(new Error(lastLine(m.message))) : resolve(m.result));
    S.engine.postMessage({ type, id, req });
  }));
}

// Every change to the attacker or target reruns the test (a run takes well under a second), so the result never
// shows a setup that is no longer on screen. Changes that land while a run is going queue one more run.
function autoRun(ms = 350) {
  clearTimeout(S.autoT);
  if (S.ready) { S.autoT = setTimeout(runTest, ms); renderResbar(true); }
}

function runTest() {
  if (!S.ready) return;
  clearTimeout(S.autoT);
  if (S.running) { S.again = true; return; }
  const err = checkInputs();
  showErr(err);
  // the result on screen no longer matches the form: dim it until a run succeeds
  $("#results").classList.toggle("stale", !!err);
  if (err) { renderResbar(); return; }
  const req = request(), url = shareURL(), id = ++S.runId;
  S.running = true;
  $("#run").disabled = true; $("#run").textContent = "Running…"; renderResbar(true);
  S.pending[id] = (m) => {
    S.running = false;
    $("#run").disabled = false; $("#run").textContent = "Run damage test";
    if (m.type === "error") showErr("That run failed: " + lastLine(m.message));
    else {
      if (S.last?.res.timeline) S.prev = S.last;
      S.last = { req, res: m.result, label: S.A.label || `${S.heroById[S.A.hero].name} build`, ms: m.ms };
      renderResult();
      try { history.replaceState(null, "", url); } catch { /* sandboxed embed */ }
    }
    if (S.again) { S.again = false; runTest(); } else renderResbar();
  };
  S.engine.postMessage({ type: "run", id, req });
}

// plain-language problems with the typed numbers, shown instead of running (the sim would fail or mislead)
function checkInputs() {
  const v = (s) => $(s).value.trim(), n = (s) => parseFloat(v(s));
  if (S.D.mode === "plain") {
    if (!(n("#d-hp") >= 1)) return "Give the dummy a max HP of at least 1.";
    for (const [s, l] of [["#d-br", "Bullet"], ["#d-sr", "Spirit"], ["#d-mr", "Melee"]])
      if (v(s) && !(n(s) >= -100 && n(s) <= 95)) return `${l} resist must be between -100% and 95%.`;
  }
  if (S.A.aim === "custom") {
    if (!(n("#a-acc") > 0 && n("#a-acc") <= 100)) return "Hero accuracy must be above 0% and at most 100%.";
    if (!(n("#a-hs") >= 0 && n("#a-hs") <= 100)) return "Headshot % must be between 0 and 100.";
  }
  return "";
}

// A bar pinned to the bottom of the screen while the result is out of view: the 15 s number, how it moved, and a
// jump to the result. On phones the result sits far below the item shop.
let resultInView = true;
function renderResbar(busy = false) {
  const bar = $("#resbar"), L = S.last;
  bar.hidden = resultInView || !L || $("#tab-test").hidden;
  if (bar.hidden) return;
  const d = L.res.damage["15s"], dl = delta("15s", true);
  const stale = $("#results").classList.contains("stale");
  $("#resbar-v").textContent = busy || S.running ? "Running…" : stale ? "–" : fmt(d);
  $("#resbar-d").innerHTML = busy || S.running ? "" : stale ? '<span class="dl down">fix the input above</span>' : dl;
}

// change against the previous live run, when the setup differs
function delta(k, short = false) {
  const L = S.last, P = S.prev;
  if (!L?.res.timeline || !P || JSON.stringify(P.req) === JSON.stringify(L.req)) return "";
  const a = L.res.damage[k], b = P.res.damage[k];
  if (!(b > 0)) return "";
  const r = a / b - 1;
  if (Math.abs(r) < 0.005) return `<span class="dl">${short ? "no change" : "same as last run"}</span>`;
  return `<span class="dl ${r > 0 ? "up" : "down"}">${r > 0 ? "▲" : "▼"} ${short ? signed(r) : `${fmt(Math.abs(a - b))} (${signed(r)}) vs last run`}</span>`;
}

// ---------- share links ----------
// The test setup lives in the query string (the hash is the tab), so a link reopens the same test.
const SHARE_NUM = { acc: "#a-acc", hs: "#a-hs", dist: "#a-dist", mel: "#a-mel", hp: "#d-hp", br: "#d-br", sr: "#d-sr", mr: "#d-mr", es: "#d-souls" };
const AIMS = ["p25", "p50", "p75", "p90", "custom"];

function shareURL(hash = location.hash) {
  const A = S.A, D = S.D, p = new URLSearchParams(), val = (k) => $(SHARE_NUM[k]).value.trim();
  p.set("h", A.hero); p.set("s", A.souls);
  if (A.items.length) p.set("i", A.items.join("."));
  if (A.order) p.set("ao", A.order.join("."));
  p.set("aim", A.aim);
  if (A.aim === "custom") for (const k of ["acc", "hs", "dist", "mel"]) p.set(k, val(k)); // blanks too, so the recipient's saved aim can't fill them
  if (D.mode === "plain") {
    for (const k of ["hp", "br", "sr", "mr"]) if (val(k) && (k === "hp" || Number(val(k)) !== 0)) p.set(k, val(k));
  } else {
    p.set("t", "hero"); p.set("eh", D.hero);
    if (D.items.length) p.set("ei", D.items.join("."));
    if (val("es")) p.set("es", val("es"));
  }
  if (!$("#d-immortal").checked) p.set("die", "1");
  if (!$("#d-walk").checked) p.set("stay", "1");
  if (A.label) p.set("n", A.label);
  const u = new URL(location.href);
  u.search = p.toString(); u.hash = hash;
  return u.href;
}

function readShare() {
  const p = new URLSearchParams(location.search);
  if (!p.has("h")) return false;
  const hero = Number(p.get("h"));
  if (!S.heroById[hero]) return false;
  let dropped = 0;
  const items = (k) => {
    const ids = (p.get(k) || "").split(".").filter(Boolean), ok = ids.filter((x) => /^\d+$/.test(x) && Object.hasOwn(S.items, x));
    dropped += ids.length - ok.length;
    return [...new Set(ok.map(Number))].slice(0, 12);
  };
  const souls = parseFloat(p.get("s"));
  Object.assign(S.A, { hero, souls: souls >= 0 ? souls : S.A.souls, items: items("i"),
    aim: AIMS.includes(p.get("aim")) ? p.get("aim") : "p50", label: p.get("n")?.slice(0, 60) || null,
    order: /^\d+(\.\d+){0,31}$/.test(p.get("ao") || "") ? p.get("ao").split(".").map(Number) : null });
  for (const [k, sel] of Object.entries(SHARE_NUM)) {
    const v = parseFloat(p.get(k)), el = $(sel);
    if (isFinite(v)) el.value = Math.min(Number(el.max || Infinity), Math.max(Number(el.min || -Infinity), v));
    else if (p.get(k) === "") el.value = "";
  }
  if (p.get("t") === "hero") {
    const eh = Number(p.get("eh"));
    Object.assign(S.D, { mode: "hero", hero: S.heroById[eh] ? eh : S.D.hero, items: items("ei") });
  }
  $("#d-immortal").checked = p.get("die") !== "1";
  $("#d-walk").checked = p.get("stay") !== "1";
  if (dropped) S.A.label = null; // "Popular" etc. no longer describes a build missing items
  if (dropped) $("#share-note").textContent += ` ${dropped} item${dropped > 1 ? "s" : ""} from this link no longer exist${dropped > 1 ? "" : "s"} in the current patch, so ${dropped > 1 ? "they were" : "it was"} left out.`;
  return true;
}

async function copyShare() {
  // the address bar holds the last run (see runTest), so the link matches the result on screen even after edits
  const u = new URL(location.href); u.hash = "test";
  const url = u.search ? u.href : shareURL("#test"), btn = $("#share");
  try { await navigator.clipboard.writeText(url); btn.textContent = "Link copied"; }
  catch { window.prompt("Copy this link:", url); return; }
  setTimeout(() => (btn.textContent = "Copy link"), 2000);
}

// ---------- results ----------
function renderResult() {
  const L = S.last; if (!L) return;
  const r = L.res, cost = r.used?.item_cost ?? L.req.items.reduce((s, i) => s + S.items[i].cost, 0);
  const per1k = cost > 0 ? r.damage["15s"] / (cost / 1000) : null;
  const mark = (k, l) => `<div class="mk"><span class="l">Damage by ${l}</span><span class="v">${fmt(r.damage[k])}</span><span class="s">${fmt(r.dps[k])} DPS</span>${delta(k)}</div>`;
  $("#marks").innerHTML = mark("5s", "5 s") + mark("15s", "15 s") + mark("30s", "30 s")
    + `<div class="mk eff"><span class="l">15 s damage per 1k souls</span><span class="v">${fmt(per1k)}</span><span class="s">${r.kill_time ? `kills in ${fmt(r.kill_time, 1)} s` : `${fmt(cost)} souls in items`}</span></div>`;
  $("#pin").disabled = !r.timeline;
  $("#res-build").innerHTML = L.req.hero != null && L.req.items.length
    ? `<p class="hint">Tap an item to see how much of this damage it adds.</p>${bdTiles({ kind: "test", hero: L.req.hero, souls: L.req.souls, items: L.req.items, req: L.req })}` : "";
  drawTimeline();
  drawSources(r.sources, r.damage["30s"]);
  const u = r.used;
  $("#used").textContent = u
    ? `${u.hero} at ${fmt(r.attacker_souls)} souls · aim ${pct(u.accuracy, 1)} hero accuracy, ${pct(u.headshot, 1)} headshots · ${fmt(u.distance, 1)} m · ${u.melee_rate != null ? `${fmt(u.melee_rate, 3)} melee hits/s · ` : ""}target ${L.req.dummy?.hero === "Haze" && !L.req.dummy.items.length ? targetLabel(L.req) : `${targetLabel(L.req)}, ${fmt(r.dummy_max_hp)} max HP`}${L.ms ? ` · ran in ${fmt(L.ms)} ms` : ""}`
    : L.note || "";
}

function drawSources(src, total) {
  const rows = Object.entries(src || {}).filter(([, v]) => v > 0);
  const max = Math.max(1, ...rows.map(([, v]) => v));
  $("#sources").innerHTML = rows.length ? `<div class="src">${rows.map(([k, v]) =>
    `<span class="n" title="${esc(k)}">${esc(k[0].toUpperCase() + k.slice(1))}</span><span><i class="b ${k === "gun" ? "gun" : k === "melee" ? "melee" : ""}" style="display:block;width:${(v / max) * 100}%"></i></span><span class="p">${fmt(v)}<br>${pct(v / total)}</span>`).join("")}</div>`
    : '<p class="hint">No damage dealt.</p>';
}

function niceStep(max) {
  const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function drawTimeline() {
  const series = [...S.pins.map((p, i) => ({ ...p, color: css(SERIES[(i + 1) % SERIES.length]), dash: "" }))];
  if (S.last?.res.timeline) series.push({ ...S.last, color: css("--accent"), dash: "", current: true });
  const box = $("#timeline");
  if (!series.length) { box.innerHTML = `<p class="hint">${S.ready ? "Run the test to see damage over time." : "The live sim is loading; the timeline appears after the first run."}</p>`; return; }
  const W = 560, H = 230, l = 46, r = 12, t = 10, b = 26;
  const ymax = Math.max(1, ...series.flatMap((s) => s.res.timeline.map((p) => p[1])));
  const step = niceStep(ymax), top = Math.ceil(ymax / step) * step;
  const X = (s) => l + (s / 30) * (W - l - r), Y = (v) => H - b - (v / top) * (H - t - b);
  let g = "";
  for (let v = 0; v <= top + 1e-6; v += step) g += `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${css("--line")}" /><text x="${l - 6}" y="${Y(v) + 4}" text-anchor="end">${v >= 1000 ? fmt(v / 1000, v % 1000 ? 1 : 0) + "k" : fmt(v)}</text>`;
  for (let s = 0; s <= 30; s += 5) g += `<text x="${X(s)}" y="${H - 8}" text-anchor="middle">${s}s</text>`;
  for (const s of [5, 15]) g += `<line x1="${X(s)}" x2="${X(s)}" y1="${t}" y2="${H - b}" stroke="${css("--muted")}" stroke-dasharray="2 4" />`;
  const lines = series.map((s) => {
    const pts = [[0, 0], ...s.res.timeline];
    const d = pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
    const end = pts[pts.length - 1];
    const area = s.current && S.pins.length === 0 ? `<polygon points="${X(0)},${Y(0)} ${d} ${X(end[0])},${Y(0)}" fill="${s.color}" fill-opacity=".12" />` : "";
    const kill = s.res.kill_time ? `<circle cx="${X(s.res.kill_time)}" cy="${Y(s.res.dummy_max_hp)}" r="4" fill="${s.color}" />` : "";
    return `${area}<polyline points="${d}" fill="none" stroke="${s.color}" stroke-width="${s.current ? 2.5 : 1.8}" stroke-linejoin="round" />${kill}<circle cx="${X(end[0])}" cy="${Y(end[1])}" r="3" fill="${s.color}" />`;
  }).join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative damage over 30 seconds">${g}${lines}</svg>`
    + (series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}${s.current ? " (latest)" : ""}</span>`).join("")}</div>` : "");
}

function renderCompare() {
  $("#compare").hidden = !S.pins.length;
  if (!S.pins.length) return;
  const rows = S.pins.map((p, i) => {
    const r = p.res, cost = r.used.item_cost, per = cost ? r.damage["15s"] / (cost / 1000) : null;
    return `<tr><td><span class="swatch" style="background:${css(SERIES[(i + 1) % SERIES.length])}"></span>${esc(p.label)}<br><span class="hint">${esc(r.used.hero)} vs ${esc(targetLabel(p.req))}</span></td>`
      + `<td>${tiles(p.req.items, { static: true })}</td><td class="n">${fmt(cost)}</td>`
      + ["5s", "15s", "30s"].map((k) => `<td class="n">${fmt(r.damage[k])}</td>`).join("")
      + `<td class="n">${fmt(per)}</td><td class="n">${r.kill_time ? fmt(r.kill_time, 1) + " s" : "–"}</td>`
      + `<td><button class="chip-btn" data-load="${i}">Load</button> <button class="chip-btn" data-drop="${i}">Remove</button></td></tr>`;
  }).join("");
  $("#cmp").innerHTML = `<thead><tr><th>Run</th><th>Items</th><th class="n">Item souls</th><th class="n">5 s</th><th class="n">15 s</th><th class="n">30 s</th><th class="n">15 s per 1k souls</th><th class="n">Kill</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

// ---------- precomputed tabs ----------
function fillHeroSelect(sel, ids) {
  sel.innerHTML = S.heroes.filter((h) => !ids || ids.includes(String(h.id))).map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
}
function fillBudgetSelect(sel, keys, keep) {
  sel.innerHTML = keys.map((k) => `<option value="${k}">${fmt(k / 1000)}k souls</option>`).join("");
  if (keys.includes(keep)) sel.value = keep; else sel.value = keys.includes("27000") ? "27000" : keys[0];
}
const testBtn = (hero, budget, items, label, order = null) => `<button class="chip-btn" data-test='${esc(JSON.stringify({ hero, budget: Number(budget), items, label, order }))}'>Test</button>`;

function onTest(e) {
  const b = e.target.closest("[data-test]"); if (!b) return;
  const t = JSON.parse(b.dataset.test);
  Object.assign(S.A, { hero: t.hero, souls: t.budget, items: t.items, label: t.label, order: t.order || null, preset: null });
  location.hash = "test";
  renderAttacker(); renderPresets(); syncDummyHint(); runTest();
}

let gObj = "fight_15s";
async function renderDamageTab() {
  const id = $("#g-hero").value, d = await damageHero(id), out = $("#g-out");
  if (!d) { out.innerHTML = '<p class="empty">No damage search results for this hero yet.</p>'; $("#g-order").innerHTML = $("#g-skill").innerHTML = ""; return; }
  const keys = Object.keys(d.budgets);
  if ($("#g-budget").options.length !== keys.length) fillBudgetSelect($("#g-budget"), keys, $("#g-budget").value);
  const bk = $("#g-budget").value, b = d.budgets[bk], o = b.objectives[gObj], pop = b.popular;
  const best = o.builds[0], gain = best.damage[gObj] / pop.damage[gObj] - 1;
  const cols = Object.keys(OBJ);
  const ctx = (x) => ({ kind: "damage", hero: Number(id), souls: Number(bk), items: x.items, popular: pop.items, hp: b.dummy_hp, mark: OBJ_MARK[gObj] });
  const row = (x, label, cls = "") => `<tr class="${cls}"><td>${label}</td><td>${bdTiles(ctx(x))}</td><td class="n">${fmt(x.cost)}</td>`
    + cols.map((k) => `<td class="n"${k === gObj ? ' style="font-weight:600"' : ""}>${fmt(x.damage[k])}</td>`).join("")
    + `<td class="n">${fmt(x.damage.fight_15s / (x.cost / 1000))}</td><td>${testBtn(Number(id), bk, x.items, label.replace(/<[^>]+>/g, ""))}</td></tr>`;
  const val = Object.entries(o.item_value_on_popular).filter(([i, v]) => S.items[i] && v.gain > 0).sort((a, b) => b[1].per_1000_souls - a[1].per_1000_souls).slice(0, 12);
  const loss = Object.entries(o.best_item_removal_loss).filter(([i]) => S.items[i]).sort((a, b) => b[1] - a[1]);
  out.innerHTML = `<p class="hint">Best build: <b class="up">${signed(gain)}</b> damage in the ${OBJ[gObj]} window over the most popular real build. Dummy has ${fmt(b.dummy_hp)} HP, item budget ${fmt(b.item_budget)} souls, and no more 3200+ and 6400+ soul items than 9 in 10 Phantom+ players hold at this net worth. Tap any item to see what it adds.</p>
    <div class="scroll"><table><thead><tr><th>Build</th><th>Items</th><th class="n">Cost</th>${cols.map((k) => `<th class="n">${OBJ[k]}</th>`).join("")}<th class="n">15 s per 1k</th><th></th></tr></thead>
    <tbody>${row(pop, 'Popular<span class="tag">real</span>', "pop")}${o.builds.map((x, i) => row(x, `#${i + 1}`)).join("")}</tbody></table></div>
    <div class="cards">
      <div class="card"><h3>Best items to add to the popular build</h3><p class="hint">Extra ${OBJ[gObj]} damage for every 1,000 souls the item costs.</p>
        <div class="kv">${val.map(([i, v]) => `<span>${tile(i, { static: true })}</span><span>+${fmt(v.per_1000_souls)}</span>`).join("") || "<span>None help.</span><span></span>"}</div></div>
      <div class="card"><h3>What each best-build item adds</h3><p class="hint">Damage lost if that item is removed.</p>
        <div class="kv">${loss.map(([i, v]) => `<span>${tile(i, { static: true })}</span><span>${fmt(v)}</span>`).join("")}</div></div>
    </div>`;
  renderSkillOrder(id, bk);
  renderBuyOrder(id);
}

// ability upgrade order for the best builds (damage/scripts/skill_order.py): tiers at each net worth vs the popular order
async function renderSkillOrder(id, bk) {
  const d = await load(`data/damage/skill/${id}.json`), out = $("#g-skill");
  if (id !== $("#g-hero").value) return;
  const o = d?.objectives[gObj];
  if (!o) { out.innerHTML = ""; return; }
  const name = Object.fromEntries(d.abilities.map((a) => [a.id, a.name]));
  const spread = (t) => d.abilities.map((a, i) => `${esc(a.name)} ${t[i]}`).join(" · ");
  const rows = Object.entries(o.budgets).map(([b, r]) => {
    const g = r.damage / r.popular_damage - 1;
    const quirk = r.below_fewer_upgrades ? " The sim deals less with these tiers than with fewer upgrades (its cast logic for this hero), so treat this row with care." : "";
    return `<tr class="${b === bk ? "pop" : ""}"><td class="n">${fmt(b / 1000)}k</td><td>${spread(r.tiers)}<br><span class="hint">popular: ${spread(r.popular_tiers)}.${quirk}</span></td>`
      + `<td class="n">${fmt(r.points)}</td><td class="n">${fmt(r.damage)}</td><td class="n ${g > 0.0005 ? "up" : g < -0.0005 ? "down" : ""}">${g > -0.0005 && g < 0.0005 ? "same" : signed(g)}</td>`
      + `<td>${testBtn(Number(id), b, r.items, `Best ${OBJ[gObj]} build, recommended abilities`, o.order)}</td></tr>`;
  }).join("");
  const steps = o.steps.map((s) => `<li><b>${esc(name[s.ability])}</b> ${s.tier ? "tier " + s.tier : "unlock"} <span class="hint">lvl ${s.level}${s.net_worth ? ", ~" + fmt(s.net_worth / 1000, 1) + "k" : ""}</span></li>`).join("");
  out.innerHTML = `<div class="card" style="margin-top:16px"><h3>Ability upgrade order for these builds</h3>
    <p class="hint">The order to spend ability points in that gives the best ${OBJ[gObj]} damage with each net worth's best build, compared with the most played real order. Upgrades cost 1, 2 and 5 points; one order has to work at every net worth, so a row can sit a little below the best spread for that net worth alone. Numbers are tiers bought (0 to 3).</p>
    <div class="scroll"><table><thead><tr><th class="n">Net worth</th><th>Tiers</th><th class="n">Points</th><th class="n">${OBJ[gObj]} damage</th><th class="n">vs popular order</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <ol class="hint" style="columns:14rem;margin:0;padding-left:1.4rem">${steps}</ol></div>`;
}

// order to buy the best 50k build in (damage/scripts/buy_order.py), with the net worth milestones on the way
async function renderBuyOrder(id) {
  const d = await load(`data/damage/order/${id}.json`), out = $("#g-order");
  if (id !== $("#g-hero").value) return;   // the hero changed while this loaded
  const o = d?.objectives[gObj];
  if (!o) { out.innerHTML = ""; return; }
  const ms = Object.entries(o.milestones).map(([b, m]) => [Number(b), m]).sort((a, b) => a[0] - b[0]);
  const msRow = ([b, m]) => `<tr class="pop"><td><b>${fmt(b / 1000)}k</b></td><td colspan="2">${m.items.length} items, ${fmt(m.cost)} of ${fmt(m.item_budget)} item souls.`
    + (m.share_of_best != null ? ` ${pct(m.share_of_best)} of the best ${fmt(b / 1000)}k build's damage, ${m.popular_damage ? signed(m.damage / m.popular_damage - 1) : "–"} vs popular.` : "")
    + `</td><td class="n">${fmt(m.damage)}</td><td>${m.items.length ? testBtn(Number(id), b, m.items, `Buy order at ${fmt(b / 1000)}k`) : ""}</td></tr>`;
  let k = 0;
  const rows = [];
  for (const s of o.steps) {
    while (k < ms.length && s.net_worth > ms[k][0]) rows.push(msRow(ms[k++]));
    const rep = s.replaces.filter((i) => S.items[i]).map((i) => S.items[i].name);
    rows.push(`<tr><td class="n">${fmt(s.net_worth)}</td><td>${tile(s.item, { static: true })}${rep.length ? ` <span class="hint">upgrades ${esc(rep.join(", "))}</span>` : ""}</td>`
      + `<td class="n">${fmt(s.paid)}</td><td class="n">${fmt(s.damage)} <span class="up">+${fmt(s.gain)}</span></td><td></td></tr>`);
  }
  while (k < ms.length) rows.push(msRow(ms[k++]));
  out.innerHTML = `<div class="card" style="margin-top:16px"><h3>Buy order to the best ${fmt(d.target_budget / 1000)}k build</h3>
    <p class="hint">Each step buys the item that adds the most ${OBJ[gObj]} damage per soul at the net worth you can afford it, counting the hero's level then. Upgrades credit the component you hold, and an expensive item waits until real players hold that many at your net worth. Milestone rows compare what you hold there with the best build for that exact net worth, which may use items you'd later sell.</p>
    <div class="scroll"><table><thead><tr><th class="n">Net worth</th><th>Buy</th><th class="n">Pays</th><th class="n">${OBJ[gObj]} damage</th><th></th></tr></thead>
    <tbody>${rows.join("")}</tbody></table></div></div>`;
}

// rank brackets in the order the reruns refresh them (pipeline/tiers.json); Phantom and up is the standard
const BRACKET_ORDER = ["phantom", "ascendant", "eternus", "all", "eternus5", "low"];
function fillBracketSelect(sel, ids, labels) {
  ids = [...ids].sort((a, b) => (BRACKET_ORDER.indexOf(a) + 99) % 99 - (BRACKET_ORDER.indexOf(b) + 99) % 99);
  if ([...sel.options].map((o) => o.value).join() === ids.join()) return;
  const keep = sel.value;
  sel.innerHTML = ids.map((b) => `<option value="${b}">${esc(labels[b] || b)}</option>`).join("");
  sel.value = ids.includes(keep) ? keep : ids[0];
}

async function renderDuelTab() {
  const idx = await load("data/duel/index.json"), out = $("#u-out");
  const id = $("#u-hero").value, d = await load(`data/duel/heroes/${id}.json`);
  if (!idx || !d) { out.innerHTML = '<p class="empty">No duel results for this hero yet.</p>'; return; }
  const brs = Object.keys(d.brackets);
  const sel = $("#u-bracket");
  fillBracketSelect(sel, brs, Object.fromEntries(idx.brackets.map((b) => [b.id, b.label])));
  const br = d.brackets[sel.value];
  const keys = Object.keys(br);
  if ($("#u-budget").options.length !== keys.length) fillBudgetSelect($("#u-budget"), keys, $("#u-budget").value);
  const bk = $("#u-budget").value, b = br[bk];
  const ctx = (x) => ({ kind: "duel", hero: Number(id), souls: Number(bk), items: x.items, popular: b.popular?.items || [] });
  const row = (x, label, cls = "") => `<tr class="${cls}"><td>${label}</td><td>${bdTiles(ctx(x))}</td><td class="n">${fmt(x.cost)}</td><td class="n">${fmt(x.score, 3)}</td><td class="n">${pct(x.win_rate)}</td><td class="n">${pct(x.loss_rate)}</td><td class="n">${x.random_pool ? pct(x.random_pool.win_rate) : "–"}</td><td class="n">${fmt(x.avg_win_time_s, 1)} s</td><td>${testBtn(Number(id), bk, x.items, label.replace(/<[^>]+>/g, ""))}</td></tr>`;
  const meta = idx.brackets.find((x) => x.id === sel.value), latest = idx.brackets.map((x) => x.generated || "").sort().pop();
  const stale = meta?.generated && meta.generated < latest ? ` These ${esc(meta.label)} results are from an earlier run (${esc(meta.generated.slice(0, 10))}, patch ${esc(meta.patch)}); they refresh after the brackets before them.` : "";
  out.innerHTML = `<p class="hint">${brs.length} rank bracket${brs.length > 1 ? "s" : ""} so far. Phantom and up is the standard and refreshes first after each patch.${stale} Tap any item to see what it adds to the build's damage.</p>
    <div class="scroll"><table><thead><tr><th>Build</th><th>Items</th><th class="n">Cost</th><th class="n">Score</th><th class="n">Win</th><th class="n">Loss</th><th class="n" title="Win rate against randomly drawn real builds">Win vs random</th><th class="n">Time to win</th><th></th></tr></thead>
    <tbody>${b.popular ? row(b.popular, 'Popular<span class="tag">real</span>', "pop") : ""}${b.builds.map((x, i) => row(x, `#${x.rank || i + 1}`)).join("")}</tbody></table></div>`;
}

async function renderOverallTab() {
  const out = $("#o-out"), idx = await load("data/overall/index.json"), id = $("#o-hero").value;
  const h = idx?.heroes[id];
  if (!h || !Object.keys(h.brackets || {}).length) { out.innerHTML = '<p class="empty">No overall results for this hero yet.</p>'; return; }
  const meta = Object.fromEntries(idx.brackets.map((x) => [x.id, x]));
  fillBracketSelect($("#o-rank"), Object.keys(h.brackets), Object.fromEntries(idx.brackets.map((x) => [x.id, x.label])));
  const br = $("#o-rank").value, hb = h.brackets[br], keys = Object.keys(hb);
  if ($("#o-budget").options.length !== keys.length) fillBudgetSelect($("#o-budget"), keys, $("#o-budget").value);
  const bk = $("#o-budget").value, b = hb[bk], d = await load(`data/overall/heroes/${id}_${br}_${bk}.json`);
  const latest = idx.brackets.map((x) => x.generated).sort().pop();
  const old = b.patch && meta[br] && b.patch !== meta[br].patch ? ` This hero and net worth didn't finish in the latest run, so it shows the patch ${esc(b.patch)} result.` : "";
  const stale = old || (meta[br] && meta[br].generated < latest ? ` These ${esc(meta[br].label)} results are from an earlier run (${esc(meta[br].generated.slice(0, 10))}, patch ${esc(meta[br].patch)}); they refresh after the brackets before them.` : "");
  const ctx = (x) => ({ kind: "overall", hero: Number(id), souls: Number(bk), items: x.items, popular: b.popular.items });
  const card = (title, x, note) => `<div class="card"><h3>${title}</h3>${bdTiles(ctx(x))}
    <div class="kv"><span>Damage before dying</span><span><b>${fmt(x.damage_before_death)}</b>${note ? ` (${signed(x.damage_before_death / b.popular.damage_before_death - 1)})` : ""}</span>
    <span>Time alive</span><span>${fmt(x.time_alive_s, 1)} s</span>
    <span>Survives 30 s</span><span>${pct(x.survived_30s)}</span>
    <span>Dummy damage by 15 s</span><span>${fmt(x.dummy_15s)}</span></div>${testBtn(Number(id), bk, x.items, title)}</div>`;
  const row = (x, label) => `<tr><td>${label}</td><td>${bdTiles(ctx(x))}</td><td class="n">${fmt(x.cost)}</td><td class="n">${fmt(x.F.damage_before_death)}</td><td class="n">${fmt(x.F.time_alive_s, 1)} s</td><td class="n">${pct(x.F.survived_30s)}</td><td>${testBtn(Number(id), bk, x.items, label)}</td></tr>`;
  const loss = d ? Object.entries(d.best_item_removal_loss).filter(([i]) => S.items[i]).sort((a, b) => b[1] - a[1]) : [];
  const weAll = await load("data/win_edge.json"), we = weAll?.heroes?.[id] || {}, weMeta = weAll?.meta || {};
  const weStale = weMeta.patch && meta[br]?.patch && weMeta.patch !== meta[br].patch ? ` These win edges are from patch ${esc(weMeta.patch)}, older than these builds (patch ${esc(meta[br].patch)}): the new patch didn't have enough games yet. They refresh with the next rerun that has.` : "";
  const edgeTxt = (i) => { const e = we[i]; if (!e) return "–"; const cls = e[0] - 1.96 * e[1] > 0 ? "good" : e[0] + 1.96 * e[1] < 0 ? "bad" : ""; return `<span class="${cls}" title="±${fmt(1.96 * e[1], 1)} (95%)">${e[0] > 0 ? "+" : ""}${fmt(e[0], 1)}</span>`; };
  const inBest = new Set(b.best.items.map(String));
  const strong = Object.entries(we).filter(([i, e]) => !inBest.has(i) && S.items[i] && S.items[i].tier <= 4 && e[0] >= 1.5 && e[0] - 1.96 * e[1] > 0 && S.items[i].cost <= Number(bk) / 2)
    .sort((a, c) => c[1][0] - a[1][0]).slice(0, 6);
  const losing = b.best.items.filter((i) => we[i] && we[i][0] + 1.96 * we[i][1] < 0);
  out.innerHTML = `<p class="hint">Damage before dying is averaged over all 41 heroes' typical real builds in this rank bracket, at its aim, minus the healing the enemy gets back during the fight. Fights start at the health real players bring into a fight; builds that heal more between fights arrive fuller. The score also counts each item's real win edge on this hero (about 5% per point of win rate, see the card below), since a 1v1 can't see team auras or area hits.${stale} Tap any item to see what it adds to the build's damage.</p>
    <div class="cards">${card("Best overall build", b.best, true)}${card("Popular real build", b.popular, false)}${b.damage_best ? card("Best raw damage build", b.damage_best, true) : ""}</div>
    ${d ? `<div class="scroll"><table><thead><tr><th>Build</th><th>Items</th><th class="n">Cost</th><th class="n">Damage before dying</th><th class="n">Time alive</th><th class="n">Survives 30 s</th><th></th></tr></thead>
    <tbody>${d.builds.map((x, i) => row(x, `#${i + 1}`)).join("")}</tbody></table></div>
    <div class="cards"><div class="card"><h3>What each best-build item adds</h3><p class="hint">Share of the build's damage before dying lost if that item is removed (1.0 = the popular build's total), and the item's real win edge on this hero.</p>
      <div class="kv kv3"><span></span><span>Sim</span><span title="Win-rate points vs other items of the same slot and tier">Real win</span>${loss.map(([i, v]) => `<span>${tile(i, { static: true })}</span><span>${fmt(v, 3)}</span><span>${edgeTxt(i)}</span>`).join("")}</div></div>
    ${Object.keys(we).length ? `<div class="card"><h3>Checked against real games</h3><p class="hint">Real win edge: how much more often players on this hero win when they buy the item instead of another item of the same slot and tier, matched on game time, team lead and own souls (Ritualist and up, points of win rate, shrunk toward the item's edge on all heroes). Green and red are clear of the 95% noise band. Damage in a 1v1 can't see team auras, vision or objectives, so a red sim pick is worth a second look. ${weMeta.matches ? `${Number(weMeta.matches).toLocaleString()} matches, ${esc(weMeta.matches_from)} to ` : "Matches through "}${esc(weMeta.matches_through || "?")}, refreshed after each patch.${weStale}</p>
      ${losing.length ? `<p><b>Picked here but losing real games:</b></p>${tiles(losing, { static: true })}` : `<p class="hint">No item in the best build loses real games on this hero.</p>`}
      ${strong.length ? `<p style="margin-top:8px"><b>Winning real games but not in this build:</b></p><div class="kv">${strong.map(([i, e]) => `<span>${tile(i, { static: true })}</span><span class="good">+${fmt(e[0], 1)}</span>`).join("")}</div>` : ""}</div>` : ""}</div>` : ""}`;
}

// full game build paths (damage/scripts/game_path.py): one build from 0 souls to 50k, stage scores, buy order with spikes
const SLOT_NAME = { weapon: "Weapon", vitality: "Vitality", spirit: "Spirit" };
const START_LABEL = { best_start: "the best 3k build", best_10k: "the best 10k build", toward_late_game: "pieces of the late game build" };
const spikeTag = (x) => `<span class="spike${x.at >= 4800 && x.at < 6400 ? " big" : ""}" data-slot="${x.slot}" title="${SLOT_NAME[x.slot]} items cost ${fmt(x.at)} souls or more">${SLOT_NAME[x.slot]} ${fmt(x.at / 1000, 1)}k: +${fmt(x.bonus)}%</span>`;
function invBars(inv) {
  return `<div class="inv">${Object.entries(inv).map(([sl, v]) => {
    const top = Math.max(6400, (v.next_at || v.spent) * 1.05), w = Math.min(100, v.spent / top * 100);
    const next = v.next_at ? `next +${fmt(v.next_bonus)}% at ${fmt(v.next_at / 1000, 1)}k (${fmt(v.next_at - v.spent)} more)` : "top tier";
    return `<div class="inv-row" data-slot="${sl}" title="${SLOT_NAME[sl]}: ${fmt(v.spent)} souls in items, ${next}"><span>${SLOT_NAME[sl]}</span>`
      + `<span class="inv-bar"><i style="width:${w}%"></i><b style="left:${Math.min(99, 4800 / top * 100)}%"></b></span><span>+${fmt(v.bonus)}%</span></div>`;
  }).join("")}</div>`;
}

// stage stats: the laning stages are scored over a lane of short trades (regen pays off between them), 10k half lane
function pathStats(st) {
  const o = st.overall, p = st.popular, lane = o.mode === "lane" ? o : o.lane, pl = o.mode === "lane" ? p : p.lane;
  const fight = `<span>Damage before dying</span><span><b>${fmt(o.damage_before_death)}</b> <span class="hint">pop. ${fmt(p.damage_before_death)}</span></span>
      <span>Time alive</span><span>${fmt(o.time_alive_s, 1)} s <span class="hint">pop. ${fmt(p.time_alive_s, 1)}</span></span>${o.entry_hp ? `
      <span title="Health this build brings into a fight: the real average for the popular build, more for builds that heal more between fights (regen, heal pickups with Healing Booster, Radiant Regeneration...)">Health at fight start</span><span>${fmt(o.entry_hp)} <span class="hint">pop. ${fmt(p.entry_hp)}</span></span>` : ""}`;
  if (!lane) return fight;
  const ls = `<span title="Damage dealt over up to ${lane.trades} short 1v1 trades minus the enemy's healing in them. Both sides carry health between trades and heal in the gaps (regen, out-of-combat regen, Fortitude, heal pickups, Radiant Regeneration, Restorative Shot on creeps; Healbane cuts the enemy's). An enemy forced to back frees the rest of the lane">Lane damage (${lane.trades} trades)</span><span><b>${fmt(lane.damage_before_death)}</b> <span class="hint">pop. ${fmt(pl?.damage_before_death)}</span></span>
      <span title="Share of the lane's trades played before backing (under 25% health) or dying">Lane played</span><span>${pct(lane.lane_share)} <span class="hint">pop. ${pct(pl?.lane_share)}</span></span>`;
  return o.mode === "lane" ? ls : `${ls}
      <span title="Half of this stage's score is the lane, half the 30 s fight">Fight score</span><span>${signed(o.fight_score - 1)}</span>
      ${fight}`;
}

async function renderPathTab() {
  const out = $("#p-out"), idx = await load("data/path/index.json"), id = $("#p-hero").value;
  const h = idx?.heroes[id];
  if (!h || !Object.keys(h.brackets || {}).length) { out.innerHTML = '<p class="empty">No full game build for this hero yet.</p>'; return; }
  const meta = Object.fromEntries(idx.brackets.map((x) => [x.id, x]));
  fillBracketSelect($("#p-rank"), Object.keys(h.brackets), Object.fromEntries(idx.brackets.map((x) => [x.id, x.label])));
  const br = $("#p-rank").value, d = await load(`data/path/heroes/${id}_${br}.json`);
  if (id !== $("#p-hero").value) return;
  if (!d) { out.innerHTML = '<p class="empty">No full game build for this hero and rank yet.</p>'; return; }
  const latest = idx.brackets.map((x) => x.generated).sort().pop();
  const stale = meta[br] && meta[br].generated < latest ? ` These ${esc(meta[br].label)} results are from an earlier run (${esc(meta[br].generated.slice(0, 10))}); they refresh after the brackets before them.` : "";
  const name = (i) => S.items[i]?.name || "?";
  const weakest = Math.min(...d.stage_scores);
  const cards = d.stages.map((st, k) => {
    const prev = k ? d.stages[k - 1].items : [], kept = st.items.filter((i) => prev.includes(i));
    const fresh = st.items.filter((i) => !prev.includes(i));
    const sc = st.overall.score, alone = st.best_alone;
    const ctx = { kind: "overall", hero: Number(id), souls: st.budget, items: st.items, popular: st.popular.items };
    return `<div class="card stage"><h3><span>${fmt(st.budget / 1000)}k</span><span class="${sc >= 1 ? "up" : "down"}">${signed(sc - 1)}</span></h3>
      ${bdTiles(ctx)}
      <p class="hint">${k ? `New: ${fresh.map((i) => esc(name(i))).join(", ") || "nothing"}.` : "Opening build."}${st.sold?.length ? ` Sold: ${st.sold.map((i) => esc(name(i))).join(", ")}.` : ""}${sc === weakest ? " Weakest stage of the path." : ""}</p>
      <div class="kv">${pathStats(st)}
      ${alone ? `<span title="The best overall build for this net worth alone, free to use items a path would have to sell">vs best for ${fmt(st.budget / 1000)}k alone</span><span>${pct(alone.score ? sc / alone.score : null)}</span>` : ""}
      <span>Item souls</span><span>${fmt(st.cost)} / ${fmt(st.item_budget)}</span>
      ${st.lost_to_sales ? `<span title="Half of each sold item's cost, spent for the rest of the game">Lost to sales</span><span>${fmt(st.lost_to_sales)}</span>` : ""}</div>
      ${invBars(st.invest)}
      ${testBtn(Number(id), st.budget, st.items, `Full game build at ${fmt(st.budget / 1000)}k`)}</div>`;
  }).join("");
  let stage = null;
  const rows = d.order.map((s) => {
    let head = "";
    if (s.stage !== stage) {
      stage = s.stage;
      head = `<tr class="pop"><td colspan="4"><b>Toward ${fmt(stage / 1000)}k</b></td></tr>`;
    }
    if (s.sell) return head + `<tr><td class="n">${fmt(s.net_worth)}</td><td>Sell ${s.sell.map((i) => tile(i, { static: true })).join(" ")}</td><td class="n up">+${fmt(s.refund)}</td><td></td></tr>`;
    const rep = s.replaces.filter((i) => S.items[i]).map(name);
    return head + `<tr><td class="n">${fmt(s.net_worth)}</td><td>${tile(s.item, { static: true })}${rep.length ? ` <span class="hint">upgrades ${esc(rep.join(", "))}</span>` : ""}</td>`
      + `<td class="n">${fmt(s.paid)}</td><td>${s.spikes.map(spikeTag).join("")}</td></tr>`;
  }).join("");
  const lin = d.lineages.map((x) => `<tr class="${x.start === d.start ? "pop" : ""}"><td>${esc(START_LABEL[x.start] || x.start)}</td>${x.stage_scores.map((v) => `<td class="n ${v >= 1 ? "up" : "down"}">${signed(v - 1)}</td>`).join("")}<td class="n"><b>${fmt(x.path_score, 3)}</b></td></tr>`).join("");
  out.innerHTML = `<p class="hint">Each stage's score is its damage compared with the most popular real build at that net worth (+0% = popular): over a lane of short trades at 3k and 6k (so regen and healing between trades count), half lane and half the 30 s fight at 10k, the 30 s fight after that. Starts from ${esc(START_LABEL[d.start] || d.start)}.${stale} Tap any item to see what it adds.</p>
    <div class="stages">${cards}</div>
    <div class="card" style="margin-top:16px"><h3>Buy order and investment spikes</h3>
    <p class="hint">Each step buys the piece with the most fight value per soul against the next stage's enemies; two pieces that only cross a slot threshold together are valued as a pair, so spikes are hit as early as the souls allow. Net worth is when you can afford it at the share of souls real players hold in items. Spike tags are the slot bonus reached (weapon damage %, max health %, flat spirit).</p>
    <div class="scroll"><table><thead><tr><th class="n">Net worth</th><th>Buy</th><th class="n">Pays</th><th>Spikes</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="card" style="margin-top:16px"><h3>Starts compared</h3>
    <p class="hint">Two starts at the first stage, the best build there and one made of the late game build's items and components, each grown stage by stage. Path score is the average stage score with the weakest stage counted twice (1.0 = popular everywhere).</p>
    <div class="scroll"><table><thead><tr><th>Start</th>${d.budgets.map((b) => `<th class="n">${fmt(b / 1000)}k</th>`).join("")}<th class="n">Path</th></tr></thead><tbody>${lin}</tbody></table></div></div>`;
}

async function renderTankTab() {
  const out = $("#t-out"), id = $("#t-hero").value, d = await load(`data/tank/heroes/${id}.json`);
  if (!d) { out.innerHTML = '<p class="empty">No survival results for this hero.</p>'; return; }
  const keys = Object.keys(d.budgets);
  if ($("#t-budget").options.length !== keys.length) fillBudgetSelect($("#t-budget"), keys, $("#t-budget").value);
  const bk = $("#t-budget").value, b = d.budgets[bk], core = new Set(b.core.map(String));
  const names = { "0": "Keep all the damage", "0.1": "Give up to 10% damage", "0.25": "Give up to 25% damage" };
  const card = (title, x, note) => `<div class="card"><h3>${title}</h3>${bdTiles({ kind: "tank", hero: Number(id), souls: Number(bk), items: x.items, popular: b.popular.items, hp: b.dummy_hp })}
    <div class="kv"><span>Alive vs 2× focus</span><span>${fmt(x.focus_2?.time_alive, 1)} s</span>
    <span>Survives 60 s</span><span>${pct(x.focus_2?.survived_60s)}</span>
    <span>Damage by 15 s</span><span>${fmt(x.damage?.fight_15s)}${x.damage_vs_popular != null && note ? ` (${signed(x.damage_vs_popular)})` : ""}</span>
    <span>Cost</span><span>${fmt(x.cost)}</span></div>${testBtn(Number(id), bk, x.items, title)}</div>`;
  out.innerHTML = `<p class="hint">Core items kept in every build: ${b.core.map((i) => S.items[i]?.name).filter(Boolean).join(", ") || "none"}.</p>
    <div class="cards">${card("Popular real build", b.popular, false)}${Object.entries(b.margins).map(([m, v]) => v.builds?.[0] ? card(names[m] || m, v.builds[0], true) : "").join("")}</div>`;
  void core;
}

// ---------- per-item breakdown ----------
const BD = { cache: new Map(), ctx: null, item: null, mark: "15s", data: null };

async function bdRequest(ctx) {
  if (ctx.req) return ctx.req;
  let hp = ctx.hp;
  if (hp == null) {
    const d = await damageHero(ctx.hero);
    if (d) hp = d.budgets[nearestBudget(Object.keys(d.budgets), ctx.souls)].dummy_hp;
  }
  return { hero: ctx.hero, items: ctx.items, souls: ctx.souls, aim: "p75", dummy: { hero: "Haze", items: [], hp, immortal: true, zone_exit_s: ZONE_EXIT_S } };
}

async function bdPopular(ctx) {
  if (ctx.popular) return ctx.popular;
  const d = await damageHero(ctx.hero);
  return d ? d.budgets[nearestBudget(Object.keys(d.budgets), ctx.souls)].popular.items : [];
}

async function openBreakdown(ctx, itemId) {
  BD.ctx = ctx; BD.item = Number(itemId); BD.mark = ctx.mark || "15s"; BD.data = null;
  $("#sheet").hidden = false; document.body.classList.add("sheet-open");
  $("#sh-close").focus();
  renderSheet();
  try {
    ctx.popular = await bdPopular(ctx);
    const req = await bdRequest(ctx), key = JSON.stringify(req);
    if (!BD.cache.has(key)) BD.cache.set(key, simCall("breakdown", req));
    const data = await BD.cache.get(key);
    if (BD.ctx === ctx) { BD.data = data; renderSheet(); }
  } catch (e) {
    BD.cache.clear();
    if (BD.ctx === ctx) { BD.data = { error: e.message }; renderSheet(); }
  }
}

function closeSheet() { $("#sheet").hidden = true; document.body.classList.remove("sheet-open"); BD.ctx = null; }

function whyText(ctx, d, x, m) {
  const it = S.items[x.id], pop = new Set((ctx.popular || []).map(Number)), mine = new Set(ctx.items.map(Number));
  const out = [];
  if (ctx.kind === "duel" || ctx.kind === "tank" || ctx.kind === "overall")
    out.push(`This build was picked for ${ctx.kind === "duel" ? "winning 1v1 duels" : ctx.kind === "tank" ? "staying alive under focus" : "dealing the most damage before dying against real builds"}, so items can earn their place without adding damage. Damage here is measured on the standard training dummy.`);
  if (pop.size) {
    if (pop.has(x.id)) out.push("The most popular real build buys it too.");
    else {
      const dropped = [...pop].filter((i) => !mine.has(i) && S.items[i])
        .sort((a, b) => (S.items[b].slot === it.slot) - (S.items[a].slot === it.slot) || S.items[b].cost - S.items[a].cost)
        .slice(0, 3).map((i) => S.items[i].name);
      out.push(`The most popular real build doesn't buy it.${dropped.length ? ` Its souls go here instead of popular picks like ${dropped.join(", ")}.` : ""}`);
    }
  }
  if (x.loss[m] <= 0) {
    out.push(it && !it.effect_modeled ? "It adds no damage here. Only its always-on stats are modeled, so its own effect isn't counted yet."
      : "It adds no damage against this target.");
  } else {
    const own = x.direct, boosts = Object.entries(x.sources).filter(([k, v]) => v > 0 && k !== it.name && !k.startsWith(it.name + " ")).slice(0, 3);
    if (own >= 0.5 * x.loss["30s"]) out.push(`Most of its value is its own damage: ${fmt(own)} over 30 s.`);
    else if (boosts.length) out.push(`It works by making the rest of the build hit harder: ${boosts.map(([k, v]) => `+${fmt(v)} ${k === "gun" ? "gun damage" : k}`).join(", ")} over 30 s.`);
    const totalCost = d.items.reduce((s, y) => s + y.cost, 0), extra = d.total[m] - d.base[m];
    const per = x.share[m] / (x.cost / 1000), avg = totalCost ? extra / (totalCost / 1000) : 0;
    if (avg > 0) out.push(`That's ${fmt(per)} damage per 1,000 souls, ${per >= avg ? "above" : "below"} this build's average of ${fmt(avg)}.`);
  }
  if (x.loss[m] > 0 && Math.abs(x.loss[m] - x.share[m]) > 0.15 * Math.max(x.loss[m], 1))
    out.push(`Removing it alone would cost ${fmt(x.loss[m])}; items overlap or stack with each other, so shares are scaled to add up to the total.`);
  return out;
}

function renderSheet() {
  const ctx = BD.ctx; if (!ctx) return;
  const it = S.items[BD.item], d = BD.data, m = BD.mark;
  $("#sh-title").innerHTML = it ? `${esc(it.name)} <span class="c">${fmt(it.cost)} souls</span>` : "Item";
  $("#sh-title").dataset.slot = it?.slot || "";
  $("#sh-marks").innerHTML = Object.entries(MARK_LABEL).map(([k, l]) => `<button data-v="${k}" class="${k === m ? "on" : ""}">${l}</button>`).join("");
  const body = $("#sh-body");
  if (!d) { body.innerHTML = `<p class="hint">${S.ready ? "Running the build once without each item…" : "The sim is still loading. This fills in as soon as it's ready."}</p>`; return; }
  if (d.error) { body.innerHTML = `<p class="err">Couldn't measure this build: ${esc(d.error)}</p>`; return; }
  const x = d.items.find((y) => y.id === BD.item), total = d.total[m];
  if (!x) { body.innerHTML = '<p class="hint">This item isn\'t in the build.</p>'; return; }
  const segs = [{ name: "Hero with no items", v: d.base[m], cls: "base" }, ...d.items.map((y) => ({ name: y.name, v: y.share[m], id: y.id, slot: S.items[y.id]?.slot }))];
  const bar = `<div class="stack-bar" role="img" aria-label="Damage split by item">${segs.filter((sg) => sg.v > 0).map((sg) =>
    `<i class="${sg.cls || ""}${sg.id === BD.item ? " sel" : ""}" data-slot="${sg.slot || ""}" style="flex-grow:${sg.v}" title="${esc(sg.name)}: ${fmt(sg.v)}"></i>`).join("")}</div>`;
  const list = [...d.items].sort((a, b) => b.share[m] - a.share[m]).map((y) =>
    `<button class="bd-row${y.id === BD.item ? " on" : ""}" data-id="${y.id}"><span class="dot" style="--slot:var(--${S.items[y.id]?.slot})"></span><span class="n">${esc(y.name)}</span><span class="v">${fmt(y.share[m])}</span><span class="p">${pct(y.share[m] / total)}</span></button>`).join("");
  body.innerHTML = `<div class="bd-head"><span class="v">${fmt(x.share[m])}</span><span class="l">of ${fmt(total)} damage by ${MARK_LABEL[m]} (${pct(x.share[m] / total)})</span></div>
    ${bar}
    <ul class="why">${whyText(ctx, d, x, m).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    <h3>Whole build, damage by ${MARK_LABEL[m]}</h3>
    <div class="bd-list"><div class="bd-row base"><span class="dot"></span><span class="n">Hero with no items</span><span class="v">${fmt(d.base[m])}</span><span class="p">${pct(d.base[m] / total)}</span></div>${list}</div>
    <p class="fine" style="margin-top:12px">Measured live with the current sim against this build's dummy, so totals can differ a little from the table.</p>`;
}

// counter items (counters/scripts/sim_counters.py): per enemy hero, the sim value of each defensive item next to
// real players' buy trigger and win edge (counters/scripts/report.py, triggers.py)
async function renderCounterTab() {
  const out = $("#k-out"), idx = await load("data/counters/index.json");
  if (!idx) { out.innerHTML = '<p class="empty">No counter-item results yet.</p>'; return; }
  const keys = Object.keys(idx.budgets);
  if ($("#k-budget").options.length !== keys.length) fillBudgetSelect($("#k-budget"), keys, $("#k-budget").value);
  const bk = $("#k-budget").value, b = idx.budgets[bk], e = $("#k-enemy").value, me = $("#k-hero").value;
  const ei = b.enemies.indexOf(e), hd = me ? (await load(`data/counters/heroes/${me}.json`))?.[bk] : null;
  if (ei < 0 || (me && !hd)) { out.innerHTML = '<p class="empty">No counter-item results for this pick yet.</p>'; return; }
  const real = idx.real?.items || {}, ename = idx.heroes[e];
  const rows = idx.items.map((it) => {
    const s = b.items[it.name], r = real[it.name];
    let vs, avg, lift, held = false;
    if (me) {
      const h = hd.items[it.name];
      if (!h) held = true;
      else {
        vs = h.vs[ei];
        avg = h.vs.reduce((a, x, i) => a + (x || 0) * (b.weights[b.enemies[i]] || 0), 0) / b.enemies.reduce((a, x) => a + (b.weights[x] || 0), 0);
        lift = vs == null ? null : vs - avg;
      }
    } else {
      const m = b.enemy[e]?.[it.name];
      if (m) { [vs, lift] = m; avg = s.mean_vs; }
    }
    return { it, vs, avg, lift, held, per: me ? hd.items[it.name]?.per_1000 : s.per_1000, trig: r?.hero_lift?.[e], edge: r?.win_edge, rate: r?.buy_rate };
  }).filter((x) => x.held || x.vs != null).sort((a, b) => (b.vs ?? -9) - (a.vs ?? -9));
  const cls = (v, eps = 0.005) => (v > eps ? "up" : v < -eps ? "down" : "");
  const row = (x) => x.held ? `<tr><td>${tile(x.it.id, { static: true })}</td><td class="n">${fmt(x.it.cost)}</td><td colspan="4" class="hint">Already in this hero's popular build.</td><td class="n">${x.trig ? "×" + fmt(x.trig, 2) : "–"}</td><td class="n">${x.edge == null ? "–" : (x.edge > 0 ? "+" : "") + fmt(x.edge * 100, 1)}</td></tr>`
    : `<tr><td>${tile(x.it.id, { static: true })}</td><td class="n">${fmt(x.it.cost)}</td><td class="n ${cls(x.vs)}"><b>${signed(x.vs)}</b></td><td class="n">${signed(x.avg)}</td>`
      + `<td class="n ${cls(x.lift)}">${x.lift == null ? "–" : signed(x.lift)}</td><td class="n">${x.per == null ? "–" : signed(x.per)}</td>`
      + `<td class="n ${x.trig > 1.1 ? "up" : x.trig < 0.9 ? "down" : ""}">${x.trig ? "×" + fmt(x.trig, 2) : "–"}</td>`
      + `<td class="n ${cls(x.edge, 0.002)}">${x.edge == null ? "–" : (x.edge > 0 ? "+" : "") + fmt(x.edge * 100, 1)}</td></tr>`;
  const who = me ? esc(idx.heroes[me]) : "the average hero (weighted by how often each reaches this net worth)";
  out.innerHTML = `<p class="hint">Sim values are for ${who} in ${esc(idx.bracket === "phantom" ? "Phantom and up" : idx.bracket)} games at ${fmt(bk / 1000)}k souls, with the item added on top of the popular build (built ${esc(idx.built.slice(0, 10))}). <b>Vs ${esc(ename)}</b> is how much more damage the build deals before dying in that matchup, as a share of the popular build's average over all matchups; <b>vs average</b> is the same over all enemies; <b>extra vs ${esc(ename)}</b> is the difference, so a high number means the item is a real counter to ${esc(ename)} rather than just good. Real-player columns come from ${fmt(idx.real?.matches || 0)} ranked matches of the patch the analysis ran on, all ranks: <b>overall per 1k souls</b> is the overall score gain per 1,000 souls, which also counts the item's real win edge on this hero (like the Best overall builds tab), so items real buyers lose with (Metal Skin, Return Fire) rank low there even when the sim likes them; <b>bought more</b> is how much more often players buy it in the 5 minutes after facing ${esc(ename)}; <b>win edge</b> is the buyers' win rate against same-price defensive alternatives, in points.</p>
    <div class="scroll"><table><thead><tr><th>Item</th><th class="n">Cost</th><th class="n">Vs ${esc(ename)}</th><th class="n">Vs average</th><th class="n">Extra vs ${esc(ename)}</th><th class="n" title="Overall score gain per 1,000 souls, including the real win edge">Overall per 1k souls</th><th class="n" title="Real players: buy rate with this hero on the enemy team / without">Bought more</th><th class="n" title="Real players: win rate of buyers minus same-price defensive alternatives, percentage points">Win edge</th></tr></thead>
    <tbody>${rows.map(row).join("")}</tbody></table></div>
    <p class="fine">The sim adds the item for free, so every item looks good on a fragile hero; compare items with each other and read the extra column for counters. Real win edges are observational (being focused or out-played isn't captured).</p>`;
}

// what each rerun changed in the best builds, and why (pipeline/changes.py -> data/changes.json)
const TIER_LABEL = { phantom: "Phantom+", ascendant: "Ascendant+", eternus: "Eternus+", all: "All ranks" };
const REPO = "https://github.com/TylerNodell/deadlock-damage-lab";
function causeLine(c) {
  if (c.kind === "model") {
    const ref = c.pr ? ` (<a href="${REPO}/pull/${c.pr}" target="_blank" rel="noopener">#${c.pr}</a>)` : c.sha ? ` (<a href="${REPO}/commit/${esc(c.sha)}" target="_blank" rel="noopener">${esc(c.sha)}</a>)` : "";
    return `<li><span class="tag">Model</span> ${esc(c.title)}${ref}</li>`;
  }
  const tag = { patch: "Game patch", hotfix: "Hotfix", builds: "Player builds", request: "Rerun note", standard: "Rank" }[c.kind] || c.kind;
  const text = c.link ? `<a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.text)}</a>` : esc(c.text);
  return `<li><span class="tag">${esc(tag)}</span> ${text}</li>`;
}
async function renderChangesTab() {
  const out = $("#c-out"), d = await load("data/changes.json");
  if (!d || !d.entries?.length) { out.innerHTML = '<p class="empty">No reruns recorded yet. The next rerun after a patch or model change will show up here.</p>'; return; }
  const hero = $("#c-hero").value, kind = $("#c-kind").value, metric = kind === "overall" ? "Damage before dying" : "Dummy damage by 15 s";
  const html = d.entries.map((e, i) => {
    const all = e.rows.filter((r) => r.kind === kind), rows = all.filter((r) => !hero || String(r.hero) === hero);
    const changed = all.filter((r) => r.in.length || r.out.length), total = Math.round(e.summary.builds / 2);
    const when = new Date(e.date), date = isNaN(when) ? esc(e.date) : when.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const head = `${date} · ${esc(TIER_LABEL[e.tier] || e.tier)} · patch ${esc(e.patch || "?")} · <b>${changed.length}</b> of ${total} best builds changed`
      + (changed.length ? ` across ${new Set(changed.map((r) => r.hero)).size} heroes` : "");
    const causes = e.causes.length ? e.causes.map(causeLine).join("") : `<li><span class="tag">Rerun</span> ${esc(e.reason || "rerun")}</li>`;
    const row = (r) => {
      const ch = r.old > 0 ? r.new / r.old - 1 : 0;
      return `<tr><td>${esc(r.name || S.heroById[r.hero]?.name || r.hero)}</td><td class="n">${fmt(r.souls / 1000)}k</td>
        <td><div class="build mini">${r.out.map((x) => tile(x, { static: true, cls: "gone" })).join("") || '<span class="fine">–</span>'}</div></td>
        <td><div class="build mini">${r.in.map((x) => tile(x, { static: true, cls: "new" })).join("") || '<span class="fine">same items</span>'}</div></td>
        <td class="n">${fmt(r.old)} → <b>${fmt(r.new)}</b> <span class="${ch > 0.005 ? "up" : ch < -0.005 ? "down" : ""}">${signed(ch)}</span></td>
        <td>${testBtn(r.hero, r.souls, [...r.kept, ...r.in], "After rerun")}</td></tr>`;
    };
    const table = rows.length ? `<div class="scroll"><table><thead><tr><th>Hero</th><th class="n">Net worth</th><th>Out</th><th>In</th><th class="n">${metric}</th><th></th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`
      : `<p class="fine">${hero ? "No change for this hero in this run." : "No best build changed in this run."}</p>`;
    return `<details class="chg"${i === 0 ? " open" : ""}><summary>${head}</summary><div class="chg-b"><h3>Why it ran</h3><ul class="causes">${causes}</ul>${table}</div></details>`;
  }).join("");
  out.innerHTML = `<p class="hint">${d.entries.length} reruns, newest first. Numbers are for the rerun's rank bracket. Some runs change many builds at once: when several builds score within a hair of each other, a small model change can reorder them.</p>${html}`;
}

// ---------- tabs ----------
function showTab() {
  const t = (location.hash || "#test").slice(1).split("/")[0];
  const tab = ["test", "maker", "match", "overall", "path", "damage", "duel", "tank", "counter", "team", "changes"].includes(t) ? t : "test";
  $$(".tab").forEach((s) => (s.hidden = s.id !== "tab-" + tab));
  renderResbar();
  $$("#tabs a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  if (tab === "overall") renderOverallTab();
  if (tab === "path") renderPathTab();
  if (tab === "damage") renderDamageTab();
  if (tab === "duel") renderDuelTab();
  if (tab === "tank") renderTankTab();
  if (tab === "counter") renderCounterTab();
  if (tab === "changes") renderChangesTab();
}

// ---------- phones ----------
// Tables with a text column (builds, buy orders, ability tiers) become stacked cards on narrow screens (app.css table.cards-sm): each number cell gets its
// column name to show above it, and the label, item and button cells take a full row.
function stackTables() {
  for (const t of $$("table")) {
    // rows are marked one by one: a renderer can swap a table's rows (or its whole innerHTML) without replacing it
    const rows = [...(t.tBodies[0]?.rows || [])].filter((r) => !r.dataset.stk);
    if (!rows.length || !t.tHead || !t.querySelector("tbody td:not(.n)") || !t.querySelector("tbody td.n")) continue;
    const heads = [...(t.tHead.rows[0]?.cells || [])].map((c) => c.textContent.trim());
    for (const r of rows) {
      let col = 0;   // header column of each cell, counting colspans
      for (const c of r.cells) {
        if (c.colSpan > 1 || !c.classList.contains("n")) c.classList.add("wide");
        else if (heads[col]) c.dataset.label = heads[col];
        col += c.colSpan;
      }
      r.dataset.stk = "1";
    }
    t.classList.add("cards-sm");
  }
}
// Long tab intros fold to three lines on phones, with a button to read the rest.
function clampIntros() {
  for (const p of $$(".intro p")) {
    if (p.textContent.length < 220 || p.nextElementSibling?.classList.contains("more")) continue;
    p.classList.add("clamp");
    p.insertAdjacentHTML("afterend", `<button class="more" type="button">Read more</button>`);
    p.nextElementSibling.onclick = (e) => { const open = p.classList.toggle("clamp"); e.target.textContent = open ? "Read more" : "Show less"; };
  }
}
function phoneLayout() {
  clampIntros();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; stackTables(); });
  }).observe(document.body, { childList: true, subtree: true });
  stackTables();
}

// ---------- boot ----------
async function boot() {
  load("data/damage/index.json").then((d) => { if (d && d.dummy_zone_exit_s != null) ZONE_EXIT_S = d.dummy_zone_exit_s; });
  const [items, heroes] = await Promise.all([getJSON("data/items.json"), getJSON("data/heroes.json")]);
  S.items = items; S.heroes = heroes;
  for (const h of heroes) S.heroById[h.id] = h;
  S.dataNow();
  const opts = heroes.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  $("#a-hero").innerHTML = opts; $("#d-heroname").innerHTML = opts;
  fillHeroSelect($("#g-hero")); fillHeroSelect($("#u-hero")); fillHeroSelect($("#o-hero")); fillHeroSelect($("#p-hero"));
  const tank = await load("data/tank/index.json");
  fillHeroSelect($("#t-hero"), tank ? Object.keys(tank.heroes) : []);
  for (const s of ["#g-hero", "#u-hero", "#o-hero", "#p-hero"]) $(s).value = 13;
  $("#c-hero").innerHTML = '<option value="">All heroes</option>' + opts;
  fillHeroSelect($("#k-enemy")); $("#k-enemy").value = 13;
  $("#k-hero").innerHTML = '<option value="">Any hero (average)</option>' + $("#k-enemy").innerHTML;
  load("data/patch.json").then((p) => {
    if (!p) return;
    $("#patch").textContent = p.patch;
    if (p.results_built) $("#patch-updated").textContent = `, results updated ${p.results_built.slice(0, 10)}`;
  });

  // starting state: Haze's most popular real 27k build against the standard dummy
  const d = await damageHero(S.A.hero);
  const b = d?.budgets["27000"];
  if (b) $("#d-hp").value = b.dummy_hp;
  restoreAim(); // before the link, so a shared link's aim wins over the numbers saved in this browser
  if (readShare()) $("#share-note").hidden = false;
  else if (b) {
    S.A.items = [...b.popular.items]; S.A.label = "Popular"; S.A.preset = "popular";
    S.last = { req: { items: S.A.items }, label: "Popular", note: "Precomputed result for this build (same sim, standard dummy). The live sim takes over when it finishes loading.",
      res: { damage: { "5s": b.popular.damage.burst_5s, "15s": b.popular.damage.fight_15s, "30s": b.popular.damage.sustained_30s },
        dps: { "5s": b.popular.dps.burst_5s, "15s": b.popular.dps.fight_15s, "30s": b.popular.dps.sustained_30s }, sources: b.popular.sources_30s } };
  }
  renderAttacker(); renderTarget(); renderPresets(); syncDummyHint(); renderResult();

  $("#a-hero").onchange = async (e) => { S.A.hero = Number(e.target.value); if (!S.A.preset) S.A.label = null; S.A.order = null; renderAttacker(); renderPresets(); syncDummyHint(); renderAimHint(); await followPreset(); autoRun(0); };
  $("#a-souls").onchange = async (e) => { S.A.souls = Number(e.target.value) || 0; renderAttacker(); renderPresets(); syncDummyHint(); await followPreset(); autoRun(0); };
  $("#a-aim").onchange = (e) => { S.A.aim = e.target.value; renderAttacker(); renderAimHint(); };
  renderAimHint();
  for (const sel of Object.values(AIM_FIELDS)) $(sel).addEventListener("change", () => { saveAim(); renderAimHint(); });
  $("#a-pull").onclick = pullAim;
  $("#a-steam").addEventListener("keydown", (e) => { if (e.key === "Enter") pullAim(); });
  wireShop("a", () => S.A.items, () => { S.A.label = null; S.A.preset = null; renderAttacker(); autoRun(); });
  wireShop("d", () => S.D.items, () => { renderTarget(); autoRun(); });
  $("#d-mode").onclick = (e) => { if (e.target.dataset.v && e.target.dataset.v !== S.D.mode) { S.D.mode = e.target.dataset.v; renderTarget(); autoRun(0); } };
  $("#d-heroname").onchange = (e) => { S.D.hero = Number(e.target.value); };
  // typed numbers, checkboxes and selects rerun the test (hero and net worth rerun from their own handlers above,
  // after the build follows them)
  const AUTO_SKIP = new Set(["a-hero", "a-souls", "a-q", "d-q", "a-steam"]);
  $("#tab-test").addEventListener("change", (e) => { if (e.target.matches("input, select") && !AUTO_SKIP.has(e.target.id)) autoRun(0); });
  $("#tab-test").addEventListener("input", (e) => { if (e.target.matches('input[type="number"]') && !AUTO_SKIP.has(e.target.id)) autoRun(600); });
  new IntersectionObserver(([en]) => { resultInView = en.isIntersecting; renderResbar(); }).observe($("#results"));
  $("#resbar").onclick = () => $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#run").onclick = runTest;
  $("#share").onclick = copyShare;
  $("#pin").onclick = () => {
    if (!S.last?.res.timeline) return;
    if (S.pins.length >= 5) S.pins.shift();
    S.pins.push(S.last); S.prev = S.last; S.last = null;
    renderCompare(); drawTimeline(); $("#pin").disabled = true;
  };
  $("#cmp").onclick = (e) => {
    const drop = e.target.dataset.drop, ld = e.target.dataset.load;
    if (drop != null) { S.pins.splice(Number(drop), 1); renderCompare(); drawTimeline(); }
    if (ld != null) { const p = S.pins[Number(ld)]; Object.assign(S.A, { hero: p.req.hero, souls: p.req.souls, items: [...p.req.items], label: p.label, order: p.req.ability_order || null, preset: null }); renderAttacker(); renderPresets(); autoRun(0); }
  };
  $("#g-obj").innerHTML = Object.entries(OBJ_LONG).map(([k, l]) => `<button data-v="${k}" class="${k === gObj ? "on" : ""}">${l.split(" (")[0]}</button>`).join("");
  $("#g-obj").onclick = (e) => { if (!e.target.dataset.v) return; gObj = e.target.dataset.v; $$("#g-obj button").forEach((x) => x.classList.toggle("on", x === e.target)); renderDamageTab(); };
  $("#g-hero").onchange = renderDamageTab; $("#g-budget").onchange = renderDamageTab;
  $("#u-hero").onchange = renderDuelTab; $("#u-budget").onchange = renderDuelTab; $("#u-bracket").onchange = renderDuelTab;
  $("#t-hero").onchange = renderTankTab; $("#t-budget").onchange = renderTankTab;
  $("#p-hero").onchange = renderPathTab; $("#p-rank").onchange = renderPathTab;
  $("#k-enemy").onchange = renderCounterTab; $("#k-hero").onchange = renderCounterTab; $("#k-budget").onchange = renderCounterTab;
  $("#c-hero").onchange = renderChangesTab; $("#c-kind").onchange = renderChangesTab;
  $("#o-hero").onchange = renderOverallTab; $("#o-budget").onchange = renderOverallTab; $("#o-rank").onchange = renderOverallTab;
  for (const s of ["#g-out", "#g-skill", "#g-order", "#u-out", "#t-out", "#o-out", "#p-out", "#c-out"]) $(s).addEventListener("click", onTest);
  document.addEventListener("click", (e) => {
    const t = e.target.closest(".build.tap .it");
    if (t) openBreakdown(JSON.parse(t.closest(".build").dataset.bd), t.dataset.id);
  });
  $("#sh-close").onclick = closeSheet;
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });
  $("#sh-marks").onclick = (e) => { if (e.target.dataset.v) { BD.mark = e.target.dataset.v; renderSheet(); } };
  $("#sh-body").addEventListener("click", (e) => { const r = e.target.closest(".bd-row[data-id]"); if (r) { BD.item = Number(r.dataset.id); renderSheet(); } });
  window.addEventListener("hashchange", showTab);
  phoneLayout();
  showTab();
  startEngine();
}

boot().catch((e) => showErr("The page could not load its data: " + e.message));
