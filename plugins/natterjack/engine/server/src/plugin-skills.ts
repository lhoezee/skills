/**
 * Skills that come from Claude Code plugins enabled for this workspace (a `multirepo`
 * plugin's `/multirepo:implement`), next to the workspace's own .claude/skills.
 *
 * Enabled: `enabledPlugins` ("name@marketplace": true/false) in the user settings, then the
 * project's .claude/settings.json, then .claude/settings.local.json; a later file wins.
 * Where: the CLI's plugins/installed_plugins.json, the entry of user scope or of
 * project/local scope for this workspace. Never throws: anything missing or broken
 * just means no plugin skills.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PluginSkillDir { plugin: string; dir: string }

/** ~/.claude, or $CLAUDE_CONFIG_DIR. */
function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, "")); } catch { return null; }
}

const obj = (v: any): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function sources(root: string) {
  const dir = claudeDir();
  return {
    settings: [path.join(dir, "settings.json"), path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json")],
    installed: path.join(dir, "plugins", "installed_plugins.json"),
  };
}

/** Plugin keys ("name@marketplace") enabled for the workspace, in the order first seen. */
export function enabledPlugins(root: string): string[] {
  const on = new Map<string, boolean>();
  for (const file of sources(root).settings) {
    for (const [k, v] of Object.entries(obj(obj(readJson(file)).enabledPlugins))) {
      if (typeof v === "boolean") on.set(k, v);
    }
  }
  return [...on].filter(([, v]) => v).map(([k]) => k);
}

function uncachedDirs(root: string): PluginSkillDir[] {
  const installed = obj(obj(readJson(sources(root).installed)).plugins);
  const out: PluginSkillDir[] = [];
  for (const key of enabledPlugins(root)) {
    const entries = Array.isArray(installed[key]) ? installed[key].map(obj) : [];
    const hit = entries.find((e) => typeof e.installPath === "string" && (e.scope === "user"
      || ((e.scope === "project" || e.scope === "local") && typeof e.projectPath === "string" && samePath(e.projectPath, root))));
    if (!hit) continue;
    const plugin = key.split("@")[0];
    const skillsDir = path.join(hit.installPath, "skills");
    let dirs: fs.Dirent[] = [];
    try { dirs = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (d.isDirectory() && !d.name.startsWith("_")) out.push({ plugin, dir: path.join(skillsDir, d.name) });
    }
  }
  return out;
}

const cache = new Map<string, { sig: string; dirs: PluginSkillDir[] }>();

/** Every enabled plugin's skill folders, re-read when a settings or installed_plugins file changes. */
export function pluginSkillDirs(root: string): PluginSkillDir[] {
  try {
    const { settings, installed } = sources(root);
    const sig = [...settings, installed].map((f) => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return `${f}:-`; } }).join("|");
    const hit = cache.get(root);
    if (hit && hit.sig === sig) return hit.dirs;
    const dirs = uncachedDirs(root);
    cache.set(root, { sig, dirs });
    return dirs;
  } catch {
    return [];
  }
}
