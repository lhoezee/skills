/**
 * `dashboard.mjs autostart on|off|status`: start this workspace's dashboard when you log in
 * to this computer, for this user only, no admin.
 *
 *   macOS    a LaunchAgent, ~/Library/LaunchAgents/com.natterjack.dashboard.<id>.plist
 *   Windows  a shortcut in the Startup folder (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup)
 *
 * Either runs `dashboard.mjs start` with the Node that ran `autostart on`, so it's what a
 * terminal start does: builds when the UI is out of date, does nothing when it's already
 * up, and leaves the server detached. Not `run` under launchd's KeepAlive: launchd would
 * bring it straight back after `dashboard.mjs stop` and race the page's restart.
 *
 * A login item gets launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) on macOS, where
 * neither claude nor nvm's node is, so the plist carries the PATH `autostart on` ran with.
 * Windows logins get the user's own environment, so the shortcut needs nothing extra.
 * Run `autostart on` again after moving the workspace or changing Node.
 *
 * Plain JavaScript, no packages, like dashboard.mjs. Kept apart from it so its pieces can
 * be tested; dashboard.mjs loads it only for `autostart`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const AUTOSTART_USAGE = `Usage: <dashboard.mjs> autostart <on|off|status> [--port N] [--skip-build] [--open]
  autostart on       start this workspace's dashboard when you log in (this user, no admin);
                     --port, --skip-build and --open are passed on to its start
  autostart off      stop doing that (a running dashboard keeps running)
  autostart status   whether it's on, and whether it still points at this Node and engine
macOS: a LaunchAgent. Windows: a shortcut in the Startup folder. Run on again after moving
the workspace or changing Node.`;

// What the login item's start needs from the environment `autostart on` ran in, on macOS
// where launchd gives it none of it. Kept in step with dashboard.mjs's own env reads.
const CARRIED_ENV = ["PATH", "WORKSPACE_ROOT", "DASHBOARD_LEDGER_DIR", "DASHBOARD_PORT"];

/** A short id for the workspace folder: its name, readable, plus a hash so two `app` folders differ. */
export function workspaceId(root) {
  const name = (root.split(/[\\/]/).filter(Boolean).pop() || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

/**
 * Where the login item goes and what it runs, for `platform` → { kind, file, label, args }
 * or { error } on a platform without one.
 */
export function autostartPlan({ platform, root, home, appData, node, script, flags = {} }) {
  const id = workspaceId(root);
  const args = [script, "start"];
  if (flags.port && flags.port !== true) args.push("--port", String(flags.port));
  if (flags["skip-build"]) args.push("--skip-build");
  if (flags.open) args.push("--open");
  if (platform === "darwin") {
    const label = `com.natterjack.dashboard.${id}`;
    return { kind: "launchagent", label, file: path.join(home, "Library", "LaunchAgents", `${label}.plist`), node, args };
  }
  if (platform === "win32") {
    const startup = path.win32.join(appData || path.win32.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    return { kind: "startup", label: id, file: path.win32.join(startup, `Natterjack dashboard (${id}).lnk`), node, args };
  }
  return { error: `Autostart isn't supported on ${platform} yet (macOS and Windows only).` };
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/**
 * The LaunchAgent: runs once at login (RunAtLoad, no KeepAlive), from the workspace, with
 * the carried environment, logging to the ledger. AbandonProcessGroup so launchd doesn't
 * take the detached server down with the start that exits.
 */
export function launchAgentPlist({ label, node, args, cwd, env, log }) {
  const strings = (list) => list.map((s) => `\t\t<string>${xml(s)}</string>`).join("\n");
  const envEntries = Object.entries(env).map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings([node, ...args])}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(cwd)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${envEntries}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>AbandonProcessGroup</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xml(log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** PowerShell that writes the Startup shortcut (WScript.Shell, as install-windows.ps1's desktop one), minimized. */
export function startupShortcutScript({ file, node, args, cwd }) {
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const argLine = args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ");
  return [
    `New-Item -ItemType Directory -Force -Path ${ps(path.win32.dirname(file))} | Out-Null`,
    `$l = (New-Object -ComObject WScript.Shell).CreateShortcut(${ps(file)})`,
    `$l.TargetPath = ${ps(node)}`,
    `$l.Arguments = ${ps(argLine)}`,
    `$l.WorkingDirectory = ${ps(cwd)}`,
    `$l.WindowStyle = 7`,
    `$l.Description = 'Start the workspace dashboard'`,
    `$l.Save()`,
  ].join("; ");
}

/** The environment a LaunchAgent carries: the CARRIED_ENV keys that are set. */
export function carriedEnv(env) {
  const out = {};
  for (const k of CARRIED_ENV) if (env[k]) out[k] = env[k];
  return out;
}

/**
 * Run `autostart <sub>`. Everything machine-specific comes in, so tests can point it at a
 * throwaway home and a fake run(). Returns the exit code.
 */
export function autostartMain({ argv, flags, platform, root, home, appData, node, script, ledger, env, run, log = console.log, error = console.error }) {
  const sub = argv[0] || "";
  if (!["on", "off", "status"].includes(sub)) { error(AUTOSTART_USAGE); return sub && sub !== "help" ? 2 : 0; }
  const plan = autostartPlan({ platform, root, home, appData, node, script, flags });
  if (plan.error) { error(plan.error); return 1; }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const exists = fs.existsSync(plan.file);

  if (sub === "status") {
    if (!exists) { log(`Autostart is off for ${root}.`); return 1; }
    log(`Autostart is on: ${plan.file}`);
    if (plan.kind === "launchagent") {
      const text = fs.readFileSync(plan.file, "utf-8");
      const nodeAt = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
      const stale = [];
      if (nodeAt && !fs.existsSync(unxml(nodeAt[1]))) stale.push(`its Node (${unxml(nodeAt[1])}) is gone`);
      if (!text.includes(xml(script))) stale.push("it starts a different copy of the engine");
      if (stale.length) { log(`But ${stale.join(" and ")}: run autostart on again.`); return 1; }
    }
    return 0;
  }

  if (sub === "off") {
    if (plan.kind === "launchagent") {
      // Loaded since the last login: unload it too. Not loaded is fine.
      try { run("launchctl", ["bootout", `gui/${uid}/${plan.label}`]); } catch {}
    }
    if (!exists) { log("Autostart was already off."); return 0; }
    fs.unlinkSync(plan.file);
    log(`Autostart is off (removed ${plan.file}). A running dashboard keeps running.`);
    return 0;
  }

  fs.mkdirSync(ledger, { recursive: true });
  if (plan.kind === "launchagent") {
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    fs.writeFileSync(plan.file, launchAgentPlist({ ...plan, cwd: root, env: carriedEnv(env), log: path.join(ledger, "autostart.log") }));
    try { run("plutil", ["-lint", plan.file]); } catch (e) {
      fs.unlinkSync(plan.file);
      error(`The LaunchAgent didn't validate, so it wasn't added: ${String((e && e.stdout) || e).trim()}`);
      return 1;
    }
  } else {
    try { run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", startupShortcutScript({ ...plan, cwd: root })]); } catch (e) {
      error(`Couldn't add the Startup shortcut: ${String((e && e.stderr) || e).trim()}`);
      return 1;
    }
  }
  log(`Autostart is ${exists ? "updated" : "on"}: the dashboard starts when you log in (${plan.file}).`);
  log(`It runs: ${[node, ...plan.args].join(" ")}`);
  if (plan.kind === "launchagent") log("macOS may show a \"Background Items Added\" notice; it's listed under System Settings > General > Login Items.");
  return 0;
}

/** The real run() for autostartMain. */
export function runCommand(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}
