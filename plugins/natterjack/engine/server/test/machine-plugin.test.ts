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

const { Machine, pluginInstallCommand } = await import("../src/machine.ts");

const writeCfg = (checks: unknown[]) => {
  const file = path.join(CFG, "machine.json");
  fs.writeFileSync(file, JSON.stringify({ checks }));
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(file, t, t);
};
const installed = (plugins: Record<string, unknown[]>) => fs.writeFileSync(path.join(CLAUDE, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
const enabled = (on: Record<string, boolean>) => fs.writeFileSync(path.join(CLAUDE, "settings.json"), JSON.stringify({ enabledPlugins: on }));

const CHECK = { use: "claude-plugin", id: "multirepo-plugin", label: "multirepo plugin", plugin: "multirepo@lhoezee-skills", marketplace: "lhoezee/skills", optional: true };
const one = async (check: unknown = CHECK) => {
  writeCfg([check]);
  return (await new Machine(ROOT).get(true)).checks.find((c: any) => c.id === (check as any).id);
};

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
  installed({ "multirepo@lhoezee-skills": [{ scope: "project", projectPath: path.join(os.tmpdir(), "elsewhere"), installPath: "/x", version: "0.4.0" }] });
  enabled({ "multirepo@lhoezee-skills": true });
  assert.equal((await one()).status, "info");
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

test("claude-plugin: a plugin or marketplace that isn't a plain name never reaches a command", async () => {
  installed({});
  enabled({});
  const bad = await one({ ...CHECK, plugin: "x@y; rm -rf ~" });
  assert.equal(bad.status, "warn");
  assert.equal(bad.install, undefined);
  const market = await one({ ...CHECK, marketplace: "owner/repo && evil" });
  assert.equal(market.install.cmd, "claude plugin install multirepo@lhoezee-skills --scope user", "the bad marketplace is left out");
  const scope = await one({ ...CHECK, scope: "global" });
  assert.match(scope.install.cmd, /--scope user$/);
});
