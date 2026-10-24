// Site check for LogistiX pull requests (run by .github/workflows/site-check.yml).
//
// Loads index.html in a real browser (Chromium) for BOTH this branch and the base branch,
// signed in as a fake admin with FAKE data: every request to Supabase is answered here and
// never reaches the live database. Then it opens every page in the sidebar and records
// browser errors. It fails if:
//   - the app code doesn't compile (Babel, like the browser does), or
//   - the app doesn't render, or
//   - this branch shows browser errors that the base branch doesn't, or
//   - the PR description has a "site-check" block with steps + target_error, and the
//     target error does NOT happen on the base branch or STILL happens on this branch
//     (that's how an automatic fix proves it really fixes the bug).
//
// Optional block in the PR description (hidden HTML comment):
//   <!-- site-check
//   {"steps": [{"nav": "Invoices"}, {"click": "text=New Invoice"}, {"fill": ["input[name=x]", "12"]}],
//    "target_error": "Cannot read properties of undefined", "mock_data": {"invoices": [{...}]}}
//   -->
// Steps: {"nav": "<sidebar label>"} {"click": "<selector>"} {"fill": ["<selector>", "text"]}
//        {"select": ["<selector>", "value"]} {"press": ["<selector>", "Enter"]} {"wait": 1000}
// (Selectors are Playwright selectors, e.g. "text=Save", "button:has-text('Add')", "#id".)
//
// Local use: node .github/site-check/check.mjs [repoDir] [baseDir]
// LOCAL_CDN_DIR=<dir> serves the CDN libraries from npm packages (for machines without CDN access).
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";
import Babel from "@babel/standalone";

const SUPABASE = "https://zonuxfqvyxhfkimdahkb.supabase.co";
const FAKE_USER = { id: "00000000-0000-4000-8000-000000000001", email: "site-check@example.com" };

// ---------------------------------------------------------------- inputs
const repoDir = resolve(process.argv[2] || ".");
let baseDir = process.argv[3] ? resolve(process.argv[3]) : null;
if (!baseDir && process.env.BASE_SHA) {
  baseDir = mkdtempSync(join(tmpdir(), "site-check-base-"));
  execFileSync("git", ["-C", repoDir, "worktree", "add", "--detach", baseDir, process.env.BASE_SHA], { stdio: "inherit" });
}

function parseSpec(body) {
  const m = /<!--\s*site-check\s*([\s\S]*?)-->/.exec(body || "");
  if (!m) return null;
  try {
    const spec = JSON.parse(m[1]);
    if (!Array.isArray(spec.steps) || spec.steps.length > 30) throw new Error("steps must be an array (max 30)");
    return spec;
  } catch (e) {
    return { invalid: String(e.message || e) };
  }
}
const spec = parseSpec(process.env.PR_BODY);

// ---------------------------------------------------------------- compile check
function appScript(html) {
  const open = /<script type="text\/babel"[^>]*>/.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  return html.slice(start, html.indexOf("</script>", start));
}
function compiles(dir) {
  const code = appScript(readFileSync(join(dir, "index.html"), "utf8"));
  if (code === null) return { ok: false, error: "no <script type=\"text/babel\"> block found" };
  try {
    Babel.transform(code, { presets: ["react"], compact: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).split("\n").slice(0, 6).join("\n") };
  }
}

// ---------------------------------------------------------------- static server
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
function serve(dir) {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
      const file = resolve(dir, path);
      if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

// ---------------------------------------------------------------- fake Supabase
function mockSupabase(route, mockData) {
  const url = new URL(route.request().url());
  const method = route.request().method();
  const json = (body, status = 200, headers = {}) =>
    route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", ...headers }, body: JSON.stringify(body) });
  if (method === "OPTIONS") {
    return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  }
  if (url.pathname.startsWith("/auth/v1/")) {
    if (url.pathname === "/auth/v1/user") return json(FAKE_USER);
    return json({ access_token: "site-check", refresh_token: "site-check", expires_in: 36000, user: FAKE_USER });
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    if (method !== "GET" && method !== "HEAD") return json([], 201); // writes are accepted and thrown away
    const table = url.pathname.slice("/rest/v1/".length);
    let rows = mockData[table];
    if (!rows && table === "profiles") rows = [{ id: FAKE_USER.id, name: "Site Check", role: "admin", customer_id: null }];
    rows = Array.isArray(rows) ? rows : [];
    return json(rows, 200, { "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" });
  }
  return json({}); // Edge Functions (research assistant, error catcher, ...)
}

const CDN_FILES = {
  "unpkg.com/react@18/umd/react.production.min.js": "react/umd/react.production.min.js",
  "unpkg.com/react-dom@18/umd/react-dom.production.min.js": "react-dom/umd/react-dom.production.min.js",
  "unpkg.com/prop-types@15/prop-types.min.js": "prop-types/prop-types.min.js",
  "unpkg.com/recharts@2/umd/Recharts.js": "recharts/umd/Recharts.js",
  "unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js": "xlsx/dist/xlsx.full.min.js",
  "unpkg.com/jszip@3.10.1/dist/jszip.min.js": "jszip/dist/jszip.min.js",
  "unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js": "jspdf/dist/jspdf.umd.min.js",
  "unpkg.com/@babel/standalone@7.23.10/babel.min.js": "@babel/standalone/babel.min.js",
};
async function localCdn(context) {
  const dir = process.env.LOCAL_CDN_DIR;
  if (!dir) return;
  await context.route(/^https:\/\/(unpkg\.com|cdn\.tailwindcss\.com)\//, (route) => {
    const u = new URL(route.request().url());
    const rel = CDN_FILES[u.host + u.pathname];
    if (u.host === "cdn.tailwindcss.com") return route.fulfill({ contentType: "text/javascript", body: "/* tailwind stub */" });
    if (!rel) return route.fulfill({ status: 404, body: "not mapped" });
    return route.fulfill({ contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: readFileSync(join(dir, rel)) });
  });
}

// ---------------------------------------------------------------- one browser run
// Harmless messages every load produces (e.g. Babel's note about the big inline script).
const BENIGN = [/^\[BABEL\] Note:/];
const norm = (s) => String(s).replace(/https?:\/\/127\.0\.0\.1:\d+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);

async function runSite(dir, steps, mockData) {
  const { server, url } = await serve(dir);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await localCdn(context);
  await context.route(`${SUPABASE}/**`, (route) => mockSupabase(route, mockData || {}));
  await context.addInitScript(([user]) => {
    try {
      localStorage.setItem("sb-lite-session", JSON.stringify({ access_token: "site-check", refresh_token: "site-check", user, expires_at: Date.now() / 1000 + 36000 }));
    } catch (e) { /* ignore */ }
  }, [FAKE_USER]);
  const page = await context.newPage();
  const errors = [];
  let phase = "load";
  const record = (text) => { if (!BENIGN.some((re) => re.test(text))) errors.push({ phase, text }); };
  page.on("pageerror", (e) => record(norm(e.message)));
  page.on("console", (m) => { if (m.type() === "error") record(norm(m.text())); });

  const result = { rendered: false, pages: [], steps: [], errors };
  try {
    await page.goto(url + "index.html", { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll("nav button").length > 0, null, { timeout: 45_000 });
    result.rendered = true;
    await page.waitForTimeout(1500);
    const labels = await page.$$eval("nav button", (bs) => bs.map((b) => b.innerText.trim()).filter(Boolean));
    for (const label of labels) {
      phase = `page: ${label}`;
      await page.locator("nav button", { hasText: label }).first().click({ timeout: 5000 }).catch((e) => errors.push({ phase, text: `could not open: ${norm(e.message)}` }));
      await page.waitForTimeout(700);
      result.pages.push(label);
    }
    for (const [i, step] of (steps || []).entries()) {
      phase = `step ${i + 1}`;
      try {
        if (step.nav) await page.locator("nav button", { hasText: String(step.nav) }).first().click({ timeout: 5000 });
        else if (step.click) await page.locator(String(step.click)).first().click({ timeout: 5000 });
        else if (step.fill) await page.locator(String(step.fill[0])).first().fill(String(step.fill[1]), { timeout: 5000 });
        else if (step.select) await page.locator(String(step.select[0])).first().selectOption(String(step.select[1]), { timeout: 5000 });
        else if (step.press) await page.locator(String(step.press[0])).first().press(String(step.press[1]), { timeout: 5000 });
        else if (step.wait) await page.waitForTimeout(Math.min(Number(step.wait) || 0, 5000));
        await page.waitForTimeout(500);
        result.steps.push({ step, ok: true });
      } catch (e) {
        result.steps.push({ step, ok: false, error: norm(e.message).slice(0, 200) });
      }
    }
  } catch (e) {
    errors.push({ phase, text: `site did not load: ${norm(e.message)}` });
  } finally {
    await browser.close();
    server.close();
  }
  return result;
}

// ---------------------------------------------------------------- main
const report = [];
const say = (s) => { report.push(s); console.log(s); };
let failed = false;
const fail = (s) => { failed = true; say(`❌ ${s}`); };

say("## Site check (fake data, never touches the live database)");
if (spec?.invalid) fail(`The site-check block in the PR description is not valid JSON: ${spec.invalid}`);

const comp = compiles(repoDir);
if (!comp.ok) fail(`The app code does not compile:\n\`\`\`\n${comp.error}\n\`\`\``);
else say("✅ App code compiles (Babel 7.23.10, preset react)");

const steps = spec && !spec.invalid ? spec.steps : [];
const mockData = spec && !spec.invalid ? spec.mock_data || {} : {};
const head = comp.ok ? await runSite(repoDir, steps, mockData) : null;
const base = baseDir && existsSync(join(baseDir, "index.html")) ? await runSite(baseDir, steps, mockData) : null;

if (head) {
  if (!head.rendered) fail("The app did not render (no sidebar after 45s).");
  else say(`✅ App renders; opened ${head.pages.length} pages: ${head.pages.join(", ")}`);
  const baseTexts = new Set((base?.errors || []).map((e) => e.text));
  const fresh = head.errors.filter((e) => !baseTexts.has(e.text));
  if (fresh.length) fail(`New browser errors on this branch:\n${fresh.slice(0, 15).map((e) => `- [${e.phase}] ${e.text}`).join("\n")}`);
  else say(`✅ No new browser errors${base ? " compared with the base branch" : ""} (${head.errors.length} total, all also on base)`);
  const badSteps = head.steps.filter((s) => !s.ok);
  if (badSteps.length) say(`⚠️ Steps that could not run on this branch: ${badSteps.map((s) => `${JSON.stringify(s.step)} (${s.error})`).join("; ")}`);

  if (spec && !spec.invalid && spec.target_error) {
    const t = String(spec.target_error).toLowerCase();
    const hit = (r) => r.errors.some((e) => e.text.toLowerCase().includes(t));
    const before = base ? hit(base) : false;
    const after = hit(head);
    if (!base) fail("Can't prove the fix: no base branch to compare with.");
    else if (!before) fail(`Can't prove the fix: the target error "${spec.target_error}" did not happen on the base branch with these steps.`);
    else if (after) fail(`The fix does not work: "${spec.target_error}" still happens on this branch.`);
    else say(`✅ Fix verified: "${spec.target_error}" happens on the base branch and no longer on this branch.`);
  }
}

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.join("\n\n") + "\n");
say(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
