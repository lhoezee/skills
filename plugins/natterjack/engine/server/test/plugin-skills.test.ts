// Plugin skills in the skill list, the Implement terminal prompt, and terminal quoting.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-plugin-skills-"));
const ROOT = path.join(TMP, "workspace");
const CONFIG = path.join(TMP, "claude-config");
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = path.join(ROOT, ".claude", "ledger");

const { Deck } = await import("../src/deck.ts");
const { terminalArg } = await import("../src/machine.ts");
const { Search } = await import("../src/search.ts");

const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  // Cached by mtime: make sure a rewrite within the same tick is seen.
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(file, t, t);
};
const skill = (dir: string, name: string, extra = "") =>
  write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nBody`);

const LOCAL_SKILLS = path.join(ROOT, ".claude", "skills");
skill(LOCAL_SKILLS, "implement");
skill(LOCAL_SKILLS, "helper", "user-invocable: false\n");

const install = (name: string) => path.join(CONFIG, "plugins", "cache", "market", name, "1.0.0");
skill(path.join(install("flow"), "skills"), "implement", "argument-hint: <ticket>\n");
skill(path.join(install("flow"), "skills"), "tdd", "user-invocable: false\n");
skill(path.join(install("other"), "skills"), "thing");
skill(path.join(install("global"), "skills"), "everywhere");

const INSTALLED = path.join(CONFIG, "plugins", "installed_plugins.json");
const installed = (otherProject: string) => ({
  version: 2,
  plugins: {
    "flow@market": [{ scope: "project", installPath: install("flow"), version: "1.0.0", projectPath: process.platform === "win32" ? ROOT.toUpperCase() : ROOT }], // Windows paths compare case-insensitively
    "other@market": [{ scope: "project", installPath: install("other"), version: "1.0.0", projectPath: otherProject }],
    "global@market": [{ scope: "user", installPath: install("global"), version: "1.0.0" }],
  },
});
write(INSTALLED, installed(path.join(TMP, "elsewhere")));
write(path.join(CONFIG, "settings.json"), { enabledPlugins: { "global@market": true, "flow@market": false } });
write(path.join(ROOT, ".claude", "settings.json"), { enabledPlugins: { "flow@market": true, "other@market": true } });

const deck = () => new Deck(ROOT, path.join(ROOT, ".claude", "ledger", "settings.json"));
const names = () => deck().skills().map((s) => s.name);

test("enabled plugins' skills follow the workspace's, namespaced; agent-only ones are left out", () => {
  assert.deepEqual(names(), ["implement", "flow:implement", "global:everywhere"]);
  const s = deck().skills().find((x) => x.name === "flow:implement")!;
  assert.deepEqual(s, { name: "flow:implement", description: "Does implement", argumentHint: "<ticket>", plugin: "flow" });
  assert.equal(deck().skills()[0].plugin, undefined, "a workspace skill has no plugin marker");
});

test("search offers the same skills, plugin ones by their namespaced name", () => {
  const search = new Search({ root: ROOT, memory: { list: () => ({ memories: [] }) }, issues: () => [], runs: () => [] });
  const docs = search._skills().filter(Boolean);
  assert.deepEqual(docs.map((d) => d.title).sort(), ["/flow:implement", "/global:everywhere", "/implement"]);
  const flow = docs.find((d) => d.extra.skill === "flow:implement");
  assert.equal(flow.rel, "flow/skills/implement/SKILL.md");
});

test("settings.local.json can turn a plugin off", () => {
  const local = path.join(ROOT, ".claude", "settings.local.json");
  write(local, { enabledPlugins: { "flow@market": false } });
  assert.deepEqual(names(), ["implement", "global:everywhere"]);
  fs.rmSync(local);
  assert.ok(names().includes("flow:implement"));
});

test("a plugin installed for another project is not listed; for this one it is", () => {
  assert.ok(!names().includes("other:thing"));
  write(INSTALLED, installed(ROOT + path.sep));
  assert.ok(names().includes("other:thing"));
  write(INSTALLED, installed(path.join(TMP, "elsewhere")));
});

test("broken or missing plugin files leave just the workspace's skills", () => {
  write(INSTALLED, "{ not json");
  assert.deepEqual(names(), ["implement"]);
  fs.rmSync(INSTALLED);
  assert.deepEqual(names(), ["implement"]);
  write(path.join(ROOT, ".claude", "settings.json"), "nope");
  write(INSTALLED, installed(path.join(TMP, "elsewhere")));
  assert.deepEqual(names(), ["implement", "global:everywhere"]);
  write(path.join(ROOT, ".claude", "settings.json"), { enabledPlugins: { "flow@market": true } });
});

test("implementPrompt renders the Implement preset with every option off, else /implement", () => {
  const cfg = path.join(ROOT, ".claude", "dashboard", "deck.json");
  assert.equal(deck().implementPrompt("ENG-1"), "/implement ENG-1", "no deck.json");
  write(cfg, { presets: [{ id: "implement", label: "Implement", prompt: "/flow:implement {ticket}", args: [{ name: "ticket", pattern: "^[A-Z]+-\\d+$" }],
    options: [{ name: "auto", append: " --auto", default: true }] }] });
  assert.equal(deck().implementPrompt("ENG-2"), "/flow:implement ENG-2", "a default-on option stays off in a terminal");
  assert.throws(() => deck().implementPrompt("bad id"), /doesn't look right/);
  write(cfg, { issues: { implementPreset: "build" }, presets: [] });
  assert.equal(deck().implementPrompt("ENG-3"), "/implement ENG-3", "the configured preset is missing");
});

test("terminalArg quotes one literal argument for PowerShell or sh", () => {
  assert.equal(terminalArg(`/x:implement it's "q"`, true), `'/x:implement it''s "q"'`);
  assert.equal(terminalArg(`/x:implement it's`, false), `'/x:implement it'\\''s'`);
});
