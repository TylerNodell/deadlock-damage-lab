// Browser test of the built site: node web/tests/browser_test.cjs [--shots DIR]
//
// Serves web/ (after `python3 web/build.py --pyodide DIR`) on localhost, opens it in headless Chromium at desktop and
// phone size and goes through every tab: the live sim loads in Pyodide, the damage test, item breakdown, build maker,
// real match (a made-up match served in place of the Deadlock API), team fight and every precomputed tab with its
// Test button. Fails on any page or worker error (JS or Python), console error, local file that 404s, request to an
// unexpected host, error box left showing, or (on the phone) a page wider than the screen.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium, devices } = require("playwright");

const WEB = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const SHOTS = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : null;
const SIM_LOAD_MS = 180000;
const STEP_MS = 90000;
const MATCH_ID = 990000001;
// hosts the page may ask for: Google Fonts (dropped, the page falls back to system fonts) and the Deadlock API (the
// Real match tab, answered with a made-up match)
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const API_HOST = "api.deadlock-api.com";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".wasm": "application/wasm", ".zip": "application/zip", ".txt": "text/plain", ".mjs": "text/javascript" };

// ---------- static server ----------
function serve(missing) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let p = path.normalize(path.join(WEB, decodeURIComponent(url.pathname)));
    if (p !== WEB && !p.startsWith(WEB + path.sep)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
    if (!fs.existsSync(p)) { missing.push(url.pathname); res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// ---------- made-up match for the Real match tab (bulk /v1/matches/metadata shape) ----------
function fakeMatch() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(WEB, "data", f)));
  const heroes = read("heroes.json").filter((h) => fs.existsSync(path.join(WEB, "data/damage/heroes", `${h.id}.json`))).slice(0, 12);
  if (heroes.length < 2) throw new Error("web/data/damage has fewer than 2 heroes: run web/build.py first");
  const duration = 1800;
  const players = heroes.map((h, k) => {
    const d = read(`damage/heroes/${h.id}.json`);
    const items = (d.budgets["27000"] || Object.values(d.budgets)[0]).popular.items;
    return {
      player_slot: k + 1, account_id: 1000 + k, hero_id: h.id, team: `Team${k % 2}`, assigned_lane: [1, 4, 6][Math.floor(k / 2) % 3],
      kills: 5, deaths: 4, assists: 8, net_worth: 30000 + 500 * k,
      items: items.map((id, i) => ({ item_id: id, game_time_s: 120 + i * 120, sold_time_s: 0 })),
      stats: [300, 600, 900, 1200, 1500].map((t) => ({ time_stamp_s: t, net_worth: Math.round((30000 * t) / duration) })),
      final_stats: { custom_user_stats: { "Enemy Hero Accuracy##Shots": 2000, "Enemy Hero Accuracy##Hits": 700, "Enemy Hero Accuracy##Headshots": 90 } },
    };
  });
  return [{ match_id: MATCH_ID, duration_s: duration, players }];
}

// ---------- checks ----------
const failures = [];
function fail(where, msg) { failures.push(`[${where}] ${msg}`); console.log(`  FAIL ${msg}`); }

async function watch(context, where, base, missing) {
  const origin = new URL(base).origin, match = JSON.stringify(fakeMatch());
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === origin) return route.continue();
    if (FONT_HOSTS.includes(u.hostname)) return route.abort();
    if (u.hostname === API_HOST && u.pathname === "/v1/matches/metadata")
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: match });
    fail(where, `request to an unexpected host: ${u.href}`);
    return route.abort();
  });
  // worker.js answers {type:"error"} for Python exceptions; log those so they count like any console error
  await context.addInitScript(() => {
    const W = window.Worker;
    window.Worker = class extends W {
      constructor(...a) {
        super(...a);
        this.addEventListener("message", (e) => { if (e.data && e.data.type === "error") console.error("[sim worker] " + e.data.message); });
        this.addEventListener("error", (e) => console.error("[sim worker error] " + (e.message || e)));
      }
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => fail(where, `page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED/.test(m.text())) fail(where, `console error: ${m.text().slice(0, 2000)}`); });
  page.on("requestfailed", (r) => { if (new URL(r.url()).origin === origin) fail(where, `request failed: ${r.url()} ${r.failure()?.errorText}`); });
  page.on("response", (r) => { if (new URL(r.url()).origin === origin && r.status() >= 400) fail(where, `${r.status()} for ${new URL(r.url()).pathname}`); });
  page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") fail(where, `worker console error: ${m.text().slice(0, 2000)}`); }));
  return page;
}

// error boxes the page shows (.err elements: #err, #tf-err, #mk-msg, #m-status when bad, sim failures in #m-out)
async function errorBoxes(page) {
  return page.$$eval(".err", (els) => els.filter((e) => !e.hidden && e.offsetParent !== null && e.textContent.trim()).map((e) => `#${e.id || e.className}: ${e.textContent.trim()}`));
}

async function step(page, where, name, fn) {
  const t = Date.now(), before = failures.length;
  console.log(`- ${where}: ${name}`);
  try {
    await fn();
  } catch (e) {
    fail(where, `${name}: ${e.message.split("\n")[0]}`);
  }
  for (const b of await errorBoxes(page).catch(() => [])) fail(where, `${name}: error shown on the page: ${b}`);
  if (where === "phone") {
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    if (w[0] > w[1] + 1) fail(where, `${name}: page is ${w[0]} px wide on a ${w[1]} px screen`);
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${where}-${name.replace(/\W+/g, "_")}.png`), fullPage: false }).catch(() => {});
  console.log(`  ${failures.length > before ? "failed" : "ok"} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  return failures.length === before;
}

const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
// wait until the damage test has a live result newer than `after` (S.runId counts every sim request)
const liveResult = (page, after) => page.waitForFunction((n) => S.runId > n && S.last && S.last.res && S.last.res.timeline && !$("#run").disabled, after, { timeout: STEP_MS });
const runId = (page) => page.evaluate(() => S.runId);

// false when the sim never loaded (every later sim step would only time out)
async function testTab(page, where) {
  const loaded = await step(page, where, "sim loads", async () => {
    await page.waitForFunction(() => ["ready", "error"].includes($("#engine").dataset.state), null, { timeout: SIM_LOAD_MS });
    const st = await page.$eval("#engine", (e) => `${e.dataset.state}: ${e.textContent}`);
    if (!st.startsWith("ready")) throw new Error(`sim did not load (${st})`);
  });
  if (!loaded) return false;
  await step(page, where, "damage test runs", async () => {
    await liveResult(page, 0);
    const d = await page.evaluate(() => S.last.res.damage["15s"]);
    if (!(d > 0)) throw new Error(`15 s damage is ${d}`);
  });
  await step(page, where, "edits rerun by themselves", async () => {
    // an untouched preset build follows a hero change, and the test reruns without pressing Run
    let n = await runId(page);
    const abrams = await page.evaluate(() => S.heroes.find((h) => h.name === "Abrams").id);
    await page.selectOption("#a-hero", String(abrams));
    await liveResult(page, n);
    const st = await page.evaluate(() => ({ hero: S.last.req.hero, preset: S.A.preset, items: S.last.req.items.join(".") }));
    const pop = await page.evaluate(async (h) => (await damageHero(h)).budgets["27000"].popular.items.join("."), abrams);
    if (st.hero !== abrams || st.preset !== "popular" || st.items !== pop) throw new Error(`hero change kept the old build: ${JSON.stringify(st)}`);
    n = await runId(page);
    await page.click("#a-shop .it:not(.owned)");
    await liveResult(page, n);
    if (!(await page.$("#marks .dl"))) throw new Error("no change against the last run shown");
    // the summary bar shows while the result is out of view
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForSelector("#resbar:not([hidden])", { timeout: 5000 });
    // a bad number shows a plain message instead of running, and clears once fixed
    await page.fill("#d-hp", "");
    await page.waitForFunction(() => !$("#err").hidden && /max HP/.test($("#err").textContent), null, { timeout: 5000 });
    if (!(await page.$("#results.stale"))) throw new Error("old result not dimmed while the input is bad");
    n = await runId(page);
    await page.fill("#d-hp", "2700");
    await liveResult(page, n);
    if (!(await page.$eval("#err", (e) => e.hidden))) throw new Error("input error still shown after fixing it");
    if (await page.$("#results.stale")) throw new Error("result still dimmed after fixing the input");
  });
  await step(page, where, "preset build + enemy hero target", async () => {
    const n = await runId(page);
    await page.click('#presets [data-k="fight_15s"]');
    await page.click('#d-mode [data-v="hero"]');
    await page.click("#run");
    await liveResult(page, n);
    const d = await page.evaluate(() => S.last.res.damage["15s"]);
    if (!(d > 0)) throw new Error(`15 s damage vs a hero is ${d}`);
    await page.click('#d-mode [data-v="plain"]');
  });
  await step(page, where, "item breakdown", async () => {
    await page.click("#res-build .build.tap .it");
    await page.waitForFunction(() => BD.data, null, { timeout: STEP_MS });
    const e = await page.evaluate(() => BD.data.error);
    if (e) throw new Error(`breakdown failed: ${e}`);
    await page.click("#sh-close");
  });
  return true;
}

async function makerTab(page, where) {
  await step(page, where, "build maker", async () => {
    await go(page, "maker");
    await page.waitForSelector("#mk-pop [data-b]", { timeout: STEP_MS });
    await page.click("#mk-pop [data-b]:not([data-b=clear])");
    await page.waitForSelector("#mk-sum .mk-tot", { timeout: STEP_MS });
    await page.waitForFunction(() => MK.sugTotal > 0 && MK.sugg.length >= Math.min(4, MK.sugTotal), null, { timeout: SIM_LOAD_MS });
    const n = await page.$$eval("#mk-sugg .mk-sug", (x) => x.length);
    if (!n) throw new Error("no suggestions shown");
  });
}

async function matchTab(page, where) {
  await step(page, where, "real match", async () => {
    await go(page, "match");
    await page.fill("#m-id", String(MATCH_ID));
    await page.click("#m-load");
    await page.waitForSelector("#m-pick:not([hidden])", { timeout: STEP_MS });
    await page.click("#m-go");
    await page.waitForFunction(() => /Best single swaps/.test($("#m-out").textContent) || $("#m-out .err"), null, { timeout: SIM_LOAD_MS });
  });
}

async function teamTab(page, where) {
  await step(page, where, "team fight", async () => {
    await go(page, "team");
    await page.waitForSelector("#tf-run:not([disabled])", { timeout: STEP_MS });
    await page.click("#tf-run");
    await page.waitForFunction(() => $("#tf-out table") || !$("#tf-err").hidden, null, { timeout: STEP_MS });
  });
}

const STATIC_TABS = [["overall", "#o-out"], ["path", "#p-out"], ["damage", "#g-out"], ["duel", "#u-out"], ["tank", "#t-out"], ["counter", "#k-out"], ["changes", "#c-out"]];
async function staticTabs(page, where, sim) {
  for (const [tab, out] of STATIC_TABS) {
    await step(page, where, `${tab} tab`, async () => {
      await go(page, tab);
      await page.waitForFunction((s) => $(s).children.length > 0, out, { timeout: 30000 });
      const btn = await page.$(`${out} [data-test]`);
      if (!sim) return;
      if (!btn) {
        // a fresh What changed log can have no rows; the Counter items tab is a table of items, not builds
        if (tab !== "changes" && tab !== "counter") throw new Error("no Test button in the tab");
        return;
      }
      const n = await runId(page);
      await btn.click();
      await liveResult(page, n);
    });
  }
}

async function run(browser, base, where, contextOpts, missing) {
  console.log(`\n== ${where} ==`);
  const context = await browser.newContext(contextOpts);
  const page = await watch(context, where, base, missing);
  await page.goto(base + "#test", { waitUntil: "load" });
  const sim = await testTab(page, where);
  if (sim) {
    await makerTab(page, where);
    await matchTab(page, where);
    await teamTab(page, where);
  } else console.log("  the sim did not load: skipping the build maker, real match, team fight and Test buttons");
  await staticTabs(page, where, sim);
  await context.close();
}

(async () => {
  if (!fs.existsSync(path.join(WEB, "py/sim.zip")) || !fs.existsSync(path.join(WEB, "vendor/pyodide/pyodide.js")))
    throw new Error("web/py/sim.zip or web/vendor/pyodide missing: run python3 web/build.py --pyodide DIR first");
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const missing = [];
  const server = await serve(missing);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    await run(browser, base, "desktop", { viewport: { width: 1280, height: 900 } }, missing);
    const { defaultBrowserType, ...phone } = devices["iPhone 13"];
    await run(browser, base, "phone", phone, missing);
  } finally {
    await browser.close();
    server.close();
  }
  for (const m of new Set(missing)) if (!failures.some((f) => f.includes(m))) failures.push(`[server] missing file ${m}`);
  if (failures.length) {
    console.log(`\n${failures.length} problem(s):\n` + failures.map((f) => "  " + f).join("\n"));
    process.exit(1);
  }
  console.log("\nAll tabs loaded and ran in the browser with no errors.");
})().catch((e) => { console.error(e); process.exit(1); });
