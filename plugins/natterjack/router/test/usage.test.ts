// Usage collection and the admins' report: the store on its own, then a router (static backend)
// in front of a real hosted dashboard and a fake one, collecting every 0.6 s.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UsageStore, activeDays, parseAdmins, usageReport } from "../src/usage.ts";
import { routerConfig } from "../src/config.ts";
import { LinkTokens } from "../../engine/server/src/link-tokens.ts";
import { freePort } from "../../engine/server/test/ports.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_MAIN = path.join(HERE, "..", "src", "main.ts");
const ENGINE_MAIN = path.join(HERE, "..", "..", "engine", "server", "src", "main.ts");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-usage-")));
const HOST = "dash.example.com";
const FRONT = "f".repeat(40), BACK = "b".repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kids: ChildProcess[] = [];
const servers: http.Server[] = [];
const P = { dash: 0, fake: 0, router: 0 };
let fakeHits: { path: string; secret: unknown; email: unknown }[] = [];

test("parseAdmins: commas or spaces, lowercase, emails only", () => {
  assert.deepEqual([...parseAdmins(" Ana@X.com, bo@x.com  cy@x.com,,nobody ")], ["ana@x.com", "bo@x.com", "cy@x.com"]);
  assert.equal(parseAdmins(undefined).size, 0);
});

test("routerConfig: usage settings and their defaults", () => {
  const ok = { ROUTER_PUBLIC_URL: `https://${HOST}`, ROUTER_PROXY_SECRET: FRONT, ROUTER_BACKEND_SECRET: BACK, ROUTER_BACKEND: "static", ROUTER_STATIC_FILE: "x.json" };
  const d = routerConfig(ok);
  assert.equal(d.usageMinutes, 15);
  assert.equal(d.dataDir, null);
  assert.equal(d.admins.size, 0);
  const c = routerConfig({ ...ok, ROUTER_USAGE_MINUTES: "0", ROUTER_DATA_DIR: "/data", ROUTER_ADMINS: "a@x.com" });
  assert.deepEqual([c.usageMinutes, c.dataDir, [...c.admins]], [0, "/data", ["a@x.com"]]);
  assert.throws(() => routerConfig({ ...ok, ROUTER_USAGE_MINUTES: "soon" }), /ROUTER_USAGE_MINUTES/);
});

test("UsageStore: keeps each person's latest summary and active days on disk, and reads them back", () => {
  const dir = path.join(TMP, "store");
  const now = Date.parse("2026-11-19T12:00:00Z");
  const a = new UsageStore(dir);
  a.seen("ana@x.com", now - 86400000 * 40); // outside 30 days
  a.seen("ana@x.com", now - 86400000 * 3);
  a.seen("ana@x.com", now);
  a.seen("ana@x.com", now);
  a.collected("ana@x.com", { version: 1, totals: { runs: 4 } }, now);
  a.collected("ana@x.com", { version: 1, totals: { runs: 5 } }, now); // the newest replaces the last
  a.flush();
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{32}\.json$/, "named by a hash, not the email");

  const b = new UsageStore(dir);
  const ana = b.get("ana@x.com")!;
  assert.equal(ana.summary.totals.runs, 5);
  assert.equal(ana.lastSeen, new Date(now).toISOString());
  assert.equal(ana.requests["2026-11-19"], 2);
  assert.equal(activeDays(ana, 7, now), 2);
  assert.equal(activeDays(ana, 30, now), 2);

  const r = usageReport(b, ["bo@x.com", "ana@x.com"], new Set(["bo@x.com"]), now);
  assert.deepEqual(r.people.map((p) => [p.email, p.hasDashboard, p.running, p.activeDays7]), [["ana@x.com", true, false, 2], ["bo@x.com", true, true, 0]]);
  assert.equal(r.people[1].summary, null, "someone never collected still has a row");
});

// ------------------------------------------------------------------ end to end

function request(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode || 0, text }));
    });
    req.on("error", reject);
    req.end();
  });
}
const as = (email: string) => ({ host: HOST, "x-dashboard-proxy-secret": FRONT, "x-forwarded-email": email, accept: "application/json" });
async function up(port: number) {
  for (let i = 0; i < 120; i++) {
    try { if ((await request(port, "/healthz")).status === 200) return; } catch {}
    await sleep(250);
  }
  throw new Error(`nothing on :${port}`);
}
const listen = (s: net.Server) => new Promise<number>((resolve, reject) => {
  s.once("error", reject).listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port));
});
function node(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], { env: { ...process.env, ...env }, stdio: "ignore" });
  kids.push(c);
  return c;
}

const ws = path.join(TMP, "ws");
const ledger = path.join(ws, ".claude", "ledger");

before(async () => {
  P.dash = await freePort();
  P.router = await freePort();
  // ana's real hosted dashboard, with one run in its ledger whose prompt must never leave it.
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "workspace.json"), JSON.stringify({ name: "Shop", codeHost: { kind: "none" } }));
  fs.mkdirSync(path.join(ledger, "runs"), { recursive: true });
  fs.writeFileSync(path.join(ledger, "runs", "20261119100000-aaaaaa.json"), JSON.stringify({
    id: "20261119100000-aaaaaa", sessionId: "s1", presetId: null, label: "x", prompt: "/implement ENG-1 secret-words-here",
    cwd: ws, workspace: "main", model: null, effort: null, permissionMode: "default", planMode: false, budgetUsd: null,
    trigger: "manual", status: "succeeded", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    turns: 1, turnStartedAt: null, costUsd: 0.42, numTurns: 3, durationMs: 1000, toolCalls: 2, lastActivity: null,
    resultText: "more secret-words-here", error: null, verdict: "good", flagged: false, question: null, warning: null,
  }));
  node(ENGINE_MAIN, {
    WORKSPACE_ROOT: ws, DASHBOARD_LEDGER_DIR: ledger, DASHBOARD_PORT: "", CLAUDE_CONFIG_DIR: path.join(TMP, "claude-config"),
    DASHBOARD_HOSTED: "1", DASHBOARD_PUBLIC_URL: `https://${HOST}`, DASHBOARD_PROXY_SECRET: BACK,
    DASHBOARD_OWNER: "ana@example.com", DASHBOARD_BIND: "127.0.0.1", DASHBOARD_CLAUDE_BIN: path.join(TMP, "no-claude"),
  }, ["--port", String(P.dash)]);

  // bo's dashboard: an older engine with no summary endpoint.
  const fake = http.createServer((req, res) => {
    fakeHits.push({ path: req.url!, secret: req.headers["x-dashboard-proxy-secret"], email: req.headers["x-forwarded-email"] });
    if (req.url === "/healthz") return res.end("ok");
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  P.fake = await listen(fake);
  servers.push(fake);

  const staticFile = path.join(TMP, "dashboards.json");
  fs.writeFileSync(staticFile, JSON.stringify({ "ana@example.com": `http://127.0.0.1:${P.dash}`, "bo@example.com": `http://127.0.0.1:${P.fake}` }));
  await up(P.dash);
  node(ROUTER_MAIN, {
    ROUTER_PUBLIC_URL: `https://${HOST}`, ROUTER_PROXY_SECRET: FRONT, ROUTER_BACKEND_SECRET: BACK, ROUTER_BIND: "127.0.0.1",
    ROUTER_PORT: String(P.router), ROUTER_BACKEND: "static", ROUTER_STATIC_FILE: staticFile,
    ROUTER_ADMINS: "boss@example.com", ROUTER_DATA_DIR: path.join(TMP, "router-data"), ROUTER_USAGE_MINUTES: "0.01",
  });
  await up(P.router);
});

after(() => {
  for (const k of kids) k.kill();
  for (const s of servers) s.close();
});

test("router: /_router/me says who's an admin; the report is admins' only", async () => {
  assert.deepEqual(JSON.parse((await request(P.router, "/_router/me", as("boss@example.com"))).text), { email: "boss@example.com", admin: true });
  assert.deepEqual(JSON.parse((await request(P.router, "/_router/me", as("ana@example.com"))).text), { email: "ana@example.com", admin: false });
  assert.equal((await request(P.router, "/_router/admin/usage", as("ana@example.com"))).status, 403);
  assert.equal((await request(P.router, "/api/x/../../_router/admin/usage", as("ana@example.com"))).status, 403, "a path that resolves there is checked too");
  assert.equal((await request(P.router, "/_router/admin/usage", { host: HOST, "x-forwarded-email": "boss@example.com" })).status, 401, "not through the login proxy");
  assert.equal((await request(P.router, "/_router/nothing", as("boss@example.com"))).status, 404);
});

test("router: a link token never opens the router's own paths", async () => {
  const links = new LinkTokens(path.join(TMP, "links"));
  const token = links.create("ana@example.com", "test").token;
  // Off /api/remote/ a token isn't read at all, so it's the login check that refuses it.
  const r = await request(P.router, "/_router/admin/usage", { host: HOST, authorization: `Bearer ${token}` });
  assert.equal(r.status, 401);
  const viaRemote = await request(P.router, "/api/remote/../../_router/admin/usage", { host: HOST, authorization: `Bearer ${token}` });
  assert.ok([401, 403].includes(viaRemote.status), `refused (${viaRemote.status})`);
});

test("router: collects each running dashboard's summary, with no prompts or results, and records visits", async () => {
  await request(P.router, "/api/boot", as("ana@example.com")); // ana opens her dashboard
  let report: any = null;
  for (let i = 0; i < 80; i++) {
    report = JSON.parse((await request(P.router, "/_router/admin/usage", as("boss@example.com"))).text);
    if (report.people?.find((p: any) => p.email === "ana@example.com")?.summary) break;
    await sleep(250);
  }
  const ana = report.people.find((p: any) => p.email === "ana@example.com");
  const bo = report.people.find((p: any) => p.email === "bo@example.com");
  assert.ok(ana?.summary, "ana's summary collected");
  assert.equal(ana.summary.totals.runs, 1);
  assert.equal(ana.summary.totals.costUsd, 0.42);
  assert.deepEqual(ana.summary.skills, [{ name: "implement", runs: 1 }]);
  assert.ok(ana.lastSeen, "her visit is recorded");
  assert.equal(ana.activeDays7, 1);
  assert.ok(!JSON.stringify(report).includes("secret-words-here"), "no prompt or result text in the report");
  assert.equal(bo.summary, null, "an older dashboard without the endpoint just has no figures");
  assert.equal(bo.lastSeen, null, "collecting isn't a visit");
  assert.ok(fakeHits.some((h) => h.path.startsWith("/api/usage/summary") && h.secret === BACK && h.email === "bo@example.com"), "asked as its owner, with the backend secret");
  assert.equal(report.kept, "disk");
  assert.ok(fs.readdirSync(path.join(TMP, "router-data")).length >= 1, "kept on disk");
});
