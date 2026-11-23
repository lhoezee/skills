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

/**
 * A person opening (or reloading) their dashboard: a browser's top-level page load. The app's
 * own requests don't count, so a tab left open in the background (it polls /api/runs) doesn't
 * keep "last opened" and active days going. Sec-Fetch-Dest says so in every current browser;
 * without it, a GET that asks for HTML is a page load.
 */
export function isPageOpen(req: Pick<http.IncomingMessage, "method" | "headers">): boolean {
  if (req.method !== "GET") return false;
  const dest = String(req.headers["sec-fetch-dest"] || "");
  if (dest) return dest === "document";
  return /text\/html/.test(String(req.headers.accept || ""));
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

// ------------------------------------------------------------------ what a dashboard sends

/** A real summary is a few KB (90 days at most); anything bigger isn't one. */
export const MAX_SUMMARY_BYTES = 256 * 1024;
const MAX_DAYS = 90, MAX_TOP = 10, MAX_TRIGGERS = 20;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const iso = (v: unknown) => (typeof v === "string" && v.length <= 40 && !isNaN(Date.parse(v)) ? v : null);
const label = (v: unknown) => (typeof v === "string" && /^[\w:.-]{1,80}$/.test(v) ? v : null);

/**
 * The summary as the router keeps it: only the fields the report shows, each checked, and
 * nothing else a dashboard put in. Every dashboard can run shell commands, so whatever it
 * sends is untrusted: extra fields (prompt text, say) are dropped, and a malformed summary
 * is refused, so the last good one stays. Throws on a shape it doesn't know.
 */
export function cleanSummary(s: any): any {
  if (!s || typeof s !== "object" || s.version !== 1) throw new Error("not a version 1 summary (an older or newer dashboard?)");
  if (!Array.isArray(s.days) || !s.totals || typeof s.totals !== "object") throw new Error("summary without days or totals");
  const t = s.totals;
  const totals: Record<string, number> = {};
  for (const k of ["runs", "succeeded", "failed", "turns", "toolCalls", "durationMs", "costUsd", "rated", "good", "tokens"]) {
    const v = num(t[k]);
    if (v === null) throw new Error(`summary totals.${k} isn't a number`);
    totals[k] = v;
  }
  const days = s.days.slice(-MAX_DAYS).map((d: any) => {
    const date = day(d?.date);
    if (!date) throw new Error("summary day without a date");
    const out: Record<string, unknown> = { date };
    for (const k of ["runs", "succeeded", "failed", "turns", "toolCalls", "durationMs", "costUsd", "tokens", "sessions"]) {
      const v = num(d[k]);
      if (v === null) throw new Error(`summary day ${date}: ${k} isn't a number`);
      out[k] = v;
    }
    return out;
  });
  const top = (list: unknown, key: "id" | "name") => (Array.isArray(list) ? list : []).slice(0, MAX_TOP)
    .map((x: any) => ({ [key]: label(x?.[key]), runs: num(x?.runs) }))
    .filter((x) => x[key] !== null && x.runs !== null);
  const triggers: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.triggers && typeof s.triggers === "object" ? s.triggers : {}).slice(0, MAX_TRIGGERS)) {
    if (label(k) && num(v) !== null) triggers[k] = v as number;
  }
  const pct = num(s.weeklyLimitPct);
  return {
    version: 1,
    generatedAt: iso(s.generatedAt),
    totals,
    firstRunAt: iso(s.firstRunAt),
    lastRunAt: iso(s.lastRunAt),
    days,
    presets: top(s.presets, "id"),
    skills: top(s.skills, "name"),
    triggers,
    weeklyLimitPct: pct === null ? null : Math.min(pct, 1000),
  };
}

/**
 * GET a dashboard's usage summary as its owner (the backend secret and their email), cleaned
 * (cleanSummary). A dashboard is untrusted, and the router is shared: a non-200 is refused
 * before reading its body, a body over MAX_SUMMARY_BYTES is cut off, and the whole fetch has
 * a deadline, so one dashboard can't hold the router's memory or its collection round.
 */
export function fetchSummary(url: URL, headers: http.OutgoingHttpHeaders, timeoutMs = 15000, maxBytes = MAX_SUMMARY_BYTES): Promise<any> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, value?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) { req.destroy(); reject(err); } else resolve(value);
    };
    const deadline = setTimeout(() => done(new Error("usage summary: took too long")), timeoutMs);
    const req = lib.request(url, { headers: { ...headers, accept: "application/json" }, timeout: timeoutMs }, (r) => {
      if ((r.statusCode || 0) !== 200) { r.resume(); return done(new Error(`usage summary: ${r.statusCode}`)); }
      const chunks: Buffer[] = [];
      let size = 0;
      r.on("data", (d: Buffer) => {
        size += d.length;
        if (size > maxBytes) return done(new Error(`usage summary: over ${maxBytes} bytes`));
        chunks.push(d);
      });
      r.on("error", (e) => done(e));
      r.on("end", () => {
        let s: any;
        try { s = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { return done(new Error("usage summary: not JSON")); }
        try { done(null, cleanSummary(s)); } catch (e) { done(new Error(`usage summary: ${e.message}`)); }
      });
    });
    req.on("timeout", () => done(new Error("usage summary: timed out")));
    req.on("error", (e) => done(e));
    req.end();
  });
}
