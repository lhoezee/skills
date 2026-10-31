// `bin/dashboard.mjs autostart ...` (bin/autostart.mjs): where the login item goes and what
// it runs on each platform, the LaunchAgent and Startup-shortcut contents, and on/off/status
// against a throwaway home with the OS commands faked. Plus `plutil -lint` on a Mac.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const { workspaceId, autostartPlan, launchAgentPlist, startupShortcutScript, carriedEnv, autostartMain } = await import("../../bin/autostart.mjs");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-autostart-")));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test("workspaceId: readable name plus a hash, so same-named folders differ", () => {
  assert.match(workspaceId("/Users/a/My Workspace"), /^my-workspace-[0-9a-f]{8}$/);
  assert.notEqual(workspaceId("/a/app"), workspaceId("/b/app"));
  assert.match(workspaceId("/"), /^workspace-/);
});

test("autostartPlan: a LaunchAgent on macOS, a Startup shortcut on Windows, none elsewhere; start's flags passed on", () => {
  const mac = autostartPlan({ platform: "darwin", root: "/w/ws", home: "/Users/me", node: "/n/node", script: "/w/ws/natterjack/bin/dashboard.mjs", flags: { port: "4000", open: true } });
  assert.equal(mac.kind, "launchagent");
  assert.match(mac.label, /^com\.natterjack\.dashboard\.ws-[0-9a-f]{8}$/);
  // The host's path rules: the on/off tests below run the macOS flow against a real scratch home, on Windows too.
  assert.equal(mac.file, path.join("/Users/me", "Library", "LaunchAgents", `${mac.label}.plist`));
  assert.deepEqual(mac.args, ["/w/ws/natterjack/bin/dashboard.mjs", "start", "--port", "4000", "--open"]);

  const win = autostartPlan({ platform: "win32", root: "C:\\w\\ws", home: "C:\\Users\\me", appData: "C:\\Users\\me\\AppData\\Roaming", node: "C:\\n\\node.exe", script: "C:\\w\\ws\\natterjack\\bin\\dashboard.mjs", flags: { "skip-build": true } });
  assert.equal(win.kind, "startup");
  assert.match(win.file, /^C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Natterjack dashboard \(ws-[0-9a-f]{8}\)\.lnk$/);
  assert.deepEqual(win.args.slice(1), ["start", "--skip-build"]);

  assert.match(autostartPlan({ platform: "linux", root: "/w", home: "/h", node: "n", script: "s" }).error, /isn't supported on linux/);
});

test("launchAgentPlist: runs start once at login with the carried env, escaped", () => {
  const plist = launchAgentPlist({ label: "com.natterjack.dashboard.x", node: "/n/node", args: ["/a&b/dashboard.mjs", "start"], cwd: "/a&b", env: { PATH: "/opt/homebrew/bin:/usr/bin" }, log: "/a&b/.claude/ledger/autostart.log" });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /KeepAlive/, "a stop must stay stopped");
  assert.match(plist, /<string>\/n\/node<\/string>\s*<string>\/a&amp;b\/dashboard\.mjs<\/string>\s*<string>start<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.doesNotMatch(plist, /a&b/, "& escaped everywhere");
});

test("launchAgentPlist: plutil accepts it", { skip: process.platform !== "darwin" }, () => {
  const file = path.join(TMP, "lint.plist");
  fs.writeFileSync(file, launchAgentPlist({ label: "x", node: "/n", args: ["s", "start"], cwd: "/", env: { PATH: "/usr/bin" }, log: "/tmp/x.log" }));
  execFileSync("plutil", ["-lint", file]);
});

test("startupShortcutScript: quotes for PowerShell and the shortcut's own argument line", () => {
  const ps = startupShortcutScript({ file: "C:\\Startup\\Natterjack dashboard (it's).lnk", node: "C:\\n\\node.exe", args: ["C:\\My Work\\natterjack\\bin\\dashboard.mjs", "start"], cwd: "C:\\My Work" });
  assert.match(ps, /CreateShortcut\('C:\\Startup\\Natterjack dashboard \(it''s\)\.lnk'\)/);
  assert.match(ps, /\$l\.Arguments = '"C:\\My Work\\natterjack\\bin\\dashboard\.mjs" start'/);
  assert.match(ps, /\$l\.WindowStyle = 7/);
});

test("carriedEnv: only what the login item's start reads, and only when set", () => {
  assert.deepEqual(carriedEnv({ PATH: "/p", HOME: "/h", DASHBOARD_PORT: "4000", ANTHROPIC_API_KEY: "k", WORKSPACE_ROOT: "" }), { PATH: "/p", DASHBOARD_PORT: "4000" });
});

/** autostartMain against a throwaway home, OS commands recorded instead of run. */
function harness(platform: string, failRun = false) {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const root = path.join(home, "ws");
  const ledger = path.join(root, ".claude", "ledger");
  const script = path.join(root, "natterjack", "bin", "dashboard.mjs");
  const calls: string[][] = [];
  const out: string[] = [];
  const main = (sub: string, flags: Record<string, unknown> = {}) => autostartMain({
    argv: sub ? [sub] : [], flags, platform, root, home, appData: path.join(home, "AppData"), node: process.execPath, script, ledger,
    env: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: home },
    run: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); if (failRun) throw new Error("no"); return ""; },
    log: (s: string) => out.push(s), error: (s: string) => out.push(s),
  });
  return { home, root, ledger, calls, out, main };
}

test("macOS: on writes and lints the LaunchAgent, status checks it, off unloads and removes it", () => {
  const h = harness("darwin");
  assert.equal(h.main("status"), 1, "off to begin with");
  assert.equal(h.main("on"), 0);
  const [file] = fs.readdirSync(path.join(h.home, "Library", "LaunchAgents")).map((f) => path.join(h.home, "Library", "LaunchAgents", f));
  const plist = fs.readFileSync(file, "utf-8");
  assert.ok(plist.includes(process.execPath) && plist.includes("/opt/homebrew/bin:/usr/bin"), "this Node, the PATH it ran with");
  assert.ok(!plist.includes(h.home + "<"), "HOME isn't carried");
  assert.deepEqual(h.calls[0], ["plutil", "-lint", file]);
  assert.ok(fs.existsSync(h.ledger), "the log's folder exists");

  h.out.length = 0;
  assert.equal(h.main("status"), 0);
  assert.match(h.out.join("\n"), /Autostart is on/);

  fs.writeFileSync(file, plist.replace(process.execPath, "/gone/node"));
  h.out.length = 0;
  assert.equal(h.main("status"), 1);
  assert.match(h.out.join("\n"), /Node \(\/gone\/node\) is gone/);

  assert.equal(h.main("off"), 0);
  assert.equal(fs.existsSync(file), false);
  assert.match(h.calls.at(-1)!.join(" "), /^launchctl bootout gui\/\d+\/com\.natterjack\.dashboard\.ws-/);
  h.out.length = 0;
  assert.equal(h.main("off"), 0);
  assert.match(h.out.join("\n"), /already off/);
});

test("macOS: a LaunchAgent plutil rejects isn't left behind", () => {
  const h = harness("darwin", true);
  assert.equal(h.main("on"), 1);
  assert.deepEqual(fs.readdirSync(path.join(h.home, "Library", "LaunchAgents")), []);
});

test("Windows: on hands PowerShell the shortcut; off removes it", () => {
  const h = harness("win32");
  assert.equal(h.main("on", { "skip-build": true }), 0);
  const [cmd, , , , script] = h.calls[0];
  assert.equal(cmd, "powershell.exe");
  assert.match(script, /Startup\\Natterjack dashboard \(ws-[0-9a-f]{8}\)\.lnk'/);
  assert.match(script, / start --skip-build'/);

  // What PowerShell would have made. (On a POSIX test machine the win32 path is one file
  // with backslashes in its name, in the throwaway home; on Windows it's the real layout.)
  const lnk = /CreateShortcut\('([^']+)'\)/.exec(script)![1];
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  fs.writeFileSync(lnk, "");
  assert.equal(h.main("status"), 0);
  assert.equal(h.main("off"), 0);
  assert.equal(fs.existsSync(lnk), false);
});

test("usage: no subcommand prints it, an unknown one exits 2, an unsupported platform 1", () => {
  assert.equal(harness("darwin").main(""), 0);
  assert.equal(harness("darwin").main("enable"), 2);
  assert.equal(harness("linux").main("on"), 1);
});
