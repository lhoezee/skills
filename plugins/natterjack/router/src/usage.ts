/**
 * Usage across everyone's hosted dashboards, for the admins' Reports page.
 *
 * Each dashboard keeps its own usage on its own volume, and the router stops idle ones, so
 * nothing can ask everyone at report time. Instead the router keeps the latest summary
 * from each (engine usage-summary.ts: totals only, no prompts or results), fetched every
 * ROUTER_USAGE_MINUTES while the dashboard runs and once more just before an idle stop.
 * The summaries are running totals from the person's own records, so the newest replaces
 * the last and nothing is lost while a dashboard is stopped. The router adds what it sees
 * itself: when each person last opened their dashboard, and on which days.
 *
 * Kept as one JSON file per person in ROUTER_DATA_DIR (a small volume; the router runs one
 * replica). Without it, in memory only: the report starts empty after a restart.
 *
 * Who may read it: ROUTER_ADMINS, checked against the email the login proxy signed in.
 * A dashboard can't vouch for anyone (every one of them holds the backend secret, and Claude
 * runs shell commands in them), so only the router decides, and only on that email.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

/** What the router keeps per person. */
export interface PersonUsage {
  email: string;
  /** The dashboard's /api/usage/summary, as last fetched. */
  summary: any | null;
  collectedAt: string | null;
  /** The last request the router passed to their dashboard. */
  lastSeen: string | null;
  /** "YYYY-MM-DD" (UTC) → requests that day; the last DAYS_KEPT days. */
  requests: Record<string, number>;
}

const DAYS_KEPT = 90;
const FLUSH_MS = 60_000;
const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);

export class UsageStore {
  private dir: string | null;
  private people = new Map<string, PersonUsage>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string | null) {
    this.dir = dir;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (p && typeof p.email === "string") this.people.set(p.email, { summary: null, collectedAt: null, lastSeen: null, requests: {}, ...p });
      } catch (e) { console.error(`${f}: ${e.message}`); }
    }
  }

  private person(email: string): PersonUsage {
    let p = this.people.get(email);
    if (!p) this.people.set(email, (p = { email, summary: null, collectedAt: null, lastSeen: null, requests: {} }));
    return p;
  }

  /** A request passed through to their dashboard. Written out within a minute. */
  seen(email: string, now = Date.now()) {
    const p = this.person(email);
    p.lastSeen = new Date(now).toISOString();
    const day = utcDate(now);
    p.requests[day] = (p.requests[day] || 0) + 1;
    this.dirty.add(email);
    if (this.dir && !this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS).unref();
  }

  /** A fresh summary from their dashboard. Written out now. */
  collected(email: string, summary: any, now = Date.now()) {
    const p = this.person(email);
    p.summary = summary;
    p.collectedAt = new Date(now).toISOString();
    this.dirty.add(email);
    this.flush();
  }

  get(email: string): PersonUsage | null { return this.people.get(email) || null; }
  all(): PersonUsage[] { return [...this.people.values()]; }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const cutoff = utcDate(Date.now() - DAYS_KEPT * 86400000);
    for (const email of this.dirty) {
      const p = this.people.get(email);
      if (!p) continue;
      for (const d of Object.keys(p.requests)) if (d < cutoff) delete p.requests[d];
      if (!this.dir) continue;
      // The file name is a hash: an email is an address, not a safe path.
      const file = path.join(this.dir, `${crypto.createHash("sha256").update(email).digest("hex").slice(0, 32)}.json`);
      try {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(p));
        fs.renameSync(`${file}.tmp`, file);
      } catch (e) { console.error(`Saving ${email}'s usage: ${e.message}`); continue; }
    }
    this.dirty.clear();
  }
}

/** ROUTER_ADMINS: "a@x.com, b@x.com" → a set of lowercase emails. */
export function parseAdmins(value: string | undefined): Set<string> {
  return new Set(String(value || "").split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")));
}

/** Days with at least one request in the last `days` days (today included). */
export function activeDays(p: PersonUsage, days: number, now = Date.now()): number {
  const since = utcDate(now - (days - 1) * 86400000);
  return Object.entries(p.requests).filter(([d, n]) => d >= since && n > 0).length;
}

/** The admins' report: one row per person with a dashboard, plus anyone the router has figures for. */
export function usageReport(store: UsageStore, everyone: string[], running: Set<string> | null, now = Date.now()) {
  const emails = new Set([...everyone, ...store.all().map((p) => p.email)]);
  const people = [...emails].sort().map((email) => {
    const p = store.get(email);
    const s = p?.summary || null;
    return {
      email,
      hasDashboard: everyone.includes(email),
      running: running ? running.has(email) : null,
      lastSeen: p?.lastSeen || null,
      activeDays7: p ? activeDays(p, 7, now) : 0,
      activeDays30: p ? activeDays(p, 30, now) : 0,
      collectedAt: p?.collectedAt || null,
      summary: s,
    };
  });
  return { generatedAt: new Date(now).toISOString(), people };
}

/** GET a dashboard's usage summary as its owner (the backend secret and their email). */
export function fetchSummary(url: URL, headers: http.OutgoingHttpHeaders, timeoutMs = 15000): Promise<any> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { headers: { ...headers, accept: "application/json" }, timeout: timeoutMs }, (r) => {
      let text = "";
      r.on("data", (d) => (text += d));
      r.on("error", reject);
      r.on("end", () => {
        if ((r.statusCode || 0) !== 200) return reject(new Error(`usage summary: ${r.statusCode}`));
        try {
          const s = JSON.parse(text);
          if (!s || typeof s !== "object" || typeof s.version !== "number") return reject(new Error("usage summary: not a summary (an older dashboard?)"));
          resolve(s);
        } catch { reject(new Error("usage summary: not JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("usage summary: timed out")));
    req.on("error", reject);
    req.end();
  });
}
