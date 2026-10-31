// The Machine page's claude-plugin check: a Claude Code plugin installed and enabled for this
// workspace, against a scratch workspace and a fake CLAUDE_CONFIG_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-plugin-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), "dash-plugin-claude-"));
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(path.join(CLAUDE, "plugins"), { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = path.join(ROOT, ".claude", "ledger");
process.env.CLAUDE_CONFIG_DIR = CLAUDE;

const { Machine, pluginInstallCommand, PLUGIN_KEY_RE, MARKETPLACE_RE } = await import("../src/machine.ts");

const installed = (plugins: Record<string, unknown[]>) => fs.writeFileSync(path.join(CLAUDE, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
const enabled = (on: Record<string, boolean>) => fs.writeFileSync(path.join(CLAUDE, "settings.json"), JSON.stringify({ enabledPlugins: on }));

const CHECK = { use: "claude-plugin", id: "multirepo-plugin", label: "multirepo plugin", plugin: "multirepo@lhoezee-skills", marketplace: "lhoezee/skills", optional: true };
// One check on its own (Machine._one): the plugin check runs no probes, so none are given.
const one = (check: Record<string, unknown> = CHECK, opts: { hosted?: boolean } = {}) => (new Machine(ROOT, opts) as any)._one({ kind: "claude-plugin", ...check }, {});

test("pluginInstallCommand: adds the marketplace, then installs, chained so either shell carries on", () => {
  assert.equal(pluginInstallCommand("multirepo@lhoezee-skills", "lhoezee/skills", "user"), "claude plugin marketplace add lhoezee/skills; claude plugin install multirepo@lhoezee-skills --scope user");
  assert.equal(pluginInstallCommand("x@y", null, "project"), "claude plugin install x@y --scope project");
});

test("claude-plugin: not installed shows Install with the exact commands", async () => {
  installed({});
  enabled({});
  const c = await one();
  assert.equal(c.status, "info", "optional: not a blocker");
  assert.equal(c.install.label, "Install");
  assert.equal(c.install.cmd, "claude plugin marketplace add lhoezee/skills; claude plugin install multirepo@lhoezee-skills --scope user");
  assert.match(c.detail, /Not installed for this workspace: claude plugin marketplace add/);
});

test("claude-plugin: installed for another folder only counts as not installed here", async () => {
  const other = path.join(os.tmpdir(), "elsewhere");
  installed({ "multirepo@lhoezee-skills": [
    { scope: "project", projectPath: other, installPath: "/x", version: "0.4.0" },
    { scope: "local", projectPath: other, installPath: "/x", version: "0.4.0" },
    { scope: "project", projectPath: path.join(os.tmpdir(), "stale") },
  ] });
  enabled({ "multirepo@lhoezee-skills": true });
  const c = await one();
  assert.equal(c.status, "info");
  assert.equal(c.detail.startsWith(`Installed only for ${other}, not this workspace. claude plugin marketplace add`), true, c.detail);
});

test("claude-plugin: installed for the user and enabled is ok, with its version", async () => {
  installed({ "multirepo@lhoezee-skills": [{ scope: "user", installPath: "/x", version: "0.5.0" }] });
  enabled({ "multirepo@lhoezee-skills": true });
  const c = await one();
  assert.equal(c.status, "ok");
  assert.equal(c.version, "0.5.0");
  assert.equal(c.install, undefined);
});

test("claude-plugin: installed but turned off offers Turn on", async () => {
  installed({ "multirepo@lhoezee-skills": [{ scope: "user", installPath: "/x", version: "0.5.0" }] });
  enabled({ "multirepo@lhoezee-skills": false });
  const c = await one();
  assert.equal(c.status, "warn");
  assert.equal(c.install.label, "Turn on");
  assert.equal(c.install.cmd, "claude plugin enable multirepo@lhoezee-skills --scope user");
});

test("claude-plugin: hosted, no Install button (nothing opens a terminal there)", async () => {
  installed({});
  enabled({});
  const c = await one(CHECK, { hosted: true });
  assert.equal(c.install, undefined);
  assert.match(c.detail, /hosted image/);
});

test("claude-plugin: turned off by the project's settings is turned on there, where the false wins", async () => {
  installed({ "multirepo@lhoezee-skills": [{ scope: "user", installPath: "/x", version: "0.5.0" }] });
  enabled({ "multirepo@lhoezee-skills": true });
  fs.mkdirSync(path.join(ROOT, ".claude"), { recursive: true });
  const project = path.join(ROOT, ".claude", "settings.json");
  fs.writeFileSync(project, JSON.stringify({ enabledPlugins: { "multirepo@lhoezee-skills": false } }));
  try {
    const c = await one();
    assert.equal(c.status, "warn");
    assert.equal(c.install.cmd, "claude plugin enable multirepo@lhoezee-skills --scope local", "local overrides the project's false without editing the committed file");
  } finally { fs.rmSync(project, { force: true }); }
});

test("claude-plugin: a plugin or marketplace that isn't a plain name never reaches a command", async () => {
  installed({});
  enabled({});
  const bad = await one({ ...CHECK, plugin: "x@y; rm -rf ~" });
  assert.equal(bad.status, "warn");
  assert.equal(bad.install, undefined);
  const market = await one({ ...CHECK, marketplace: "owner/repo && evil" });
  assert.equal(market.status, "warn", "said, not quietly dropped (the install would fail without it)");
  assert.equal(market.install, undefined);
  assert.equal((await one({ ...CHECK, marketplace: 42 })).status, "warn");
  for (const flagLike of ["--help", "-h", "@args"]) {
    assert.equal((await one({ ...CHECK, marketplace: flagLike })).status, "warn", flagLike);
    assert.equal((await one({ ...CHECK, plugin: `${flagLike}@x` })).status, "warn", `${flagLike}@x`);
  }
  const scope = await one({ ...CHECK, scope: "Project" });
  assert.equal(scope.status, "warn", "a scope typo is said, not quietly taken as user");
  assert.equal(scope.install, undefined);
});

test("validate.mjs checks plugin and marketplace with the engine's own patterns", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "scripts", "validate.mjs"), "utf-8");
  assert.ok(src.includes(PLUGIN_KEY_RE.toString() + ".test("), "PLUGIN_KEY_RE");
  assert.ok(src.includes(MARKETPLACE_RE.toString() + ".test("), "MARKETPLACE_RE");
});
