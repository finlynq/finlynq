/**
 * Server health metrics sampler (admin-only, /admin/system).
 *
 * Reads OS + process CPU/memory and keeps a lightweight in-memory rolling
 * history so the operator can see the SHAPE of CPU load over time, not just an
 * instantaneous gauge — the Finlynq box is bursty (a net-worth snapshot rebuild
 * pegs ~1 core for minutes, then idles), so a current-only reading is
 * misleading. Same HMR-safe `globalThis` ring-buffer pattern as `marketFetch`
 * (in-memory, cheap, NO DB write, cleared on restart/deploy).
 *
 * CPU% is computed from deltas between `os.cpus()` readings (system-wide) and
 * `process.cpuUsage()` (this Node process, top-style % of one core). The sampler
 * runs every SAMPLE_MS via an `unref`'d interval started lazily on first read.
 *
 * Server-only: imports `node:os` / `node:fs` — import from API routes, never a
 * client component.
 */

import * as os from "node:os";
import { statfs } from "node:fs/promises";
import { sql } from "drizzle-orm";

export interface SysSample {
  at: number; // epoch ms
  load1: number; // 1-min load average
  cpuPct: number; // 0-100, whole-system CPU utilisation across all cores
  procCpuPct: number; // this Node process, % of ONE core (top-style; may exceed 100)
  memUsedMb: number;
  memTotalMb: number;
  rssMb: number; // this process resident set size
}

export interface DiskUsage {
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPct: number;
}

export interface SystemMetrics {
  at: number;
  hostname: string;
  platform: string;
  nodeVersion: string;
  cores: number;
  loadavg: [number, number, number];
  cpuPct: number;
  procCpuPct: number;
  memTotalMb: number;
  memUsedMb: number;
  memFreeMb: number;
  rssMb: number;
  osUptimeS: number;
  procUptimeS: number;
  disk: DiskUsage | null;
  /** Rolling history (oldest → newest) for the CPU/load sparkline. */
  history: SysSample[];
}

const SAMPLE_MS = 15_000;
const CAP = 480; // ~2h at 15s spacing
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

interface CpuAgg {
  idle: number;
  total: number;
}
interface Reading {
  cpu: CpuAgg;
  procUs: number; // cumulative process CPU (user+system) in microseconds
  at: number; // epoch ms
}
interface SamplerState {
  buf: SysSample[];
  started: boolean;
  prev: Reading | null;
  sincePersist: number; // ticks since the last DB persist (persist every 4th ≈ 60s)
  persistCount: number; // total DB persists (drives opportunistic retention trim)
}

const PERSIST_EVERY = 4; // persist one sample to the DB per this-many 15s ticks (~60s)
const SAMPLE_RETENTION_DAYS = 7;
const TRIM_EVERY_PERSISTS = 120;

const g = globalThis as typeof globalThis & { __pfSysMetrics?: SamplerState };
function state(): SamplerState {
  if (!g.__pfSysMetrics) {
    g.__pfSysMetrics = { buf: [], started: false, prev: null, sincePersist: 0, persistCount: 0 };
  }
  return g.__pfSysMetrics;
}

function cpuAgg(): CpuAgg {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function readNow(): Reading {
  const proc = process.cpuUsage();
  return { cpu: cpuAgg(), procUs: proc.user + proc.system, at: Date.now() };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function computeSample(prev: Reading, cur: Reading): SysSample {
  const idleD = cur.cpu.idle - prev.cpu.idle;
  const totalD = cur.cpu.total - prev.cpu.total;
  const cpuPct = totalD > 0 ? clampPct(100 * (1 - idleD / totalD)) : 0;

  const wallMs = cur.at - prev.at;
  // (microseconds of CPU) / (1000 → ms) / wallMs → fraction of one core; ×100.
  const procCpuPct = wallMs > 0 ? Math.max(0, ((cur.procUs - prev.procUs) / 1000 / wallMs) * 100) : 0;

  const rss = process.memoryUsage().rss;
  const totalMem = os.totalmem();
  return {
    at: cur.at,
    load1: os.loadavg()[0],
    cpuPct: Math.round(cpuPct * 10) / 10,
    procCpuPct: Math.round(procCpuPct * 10) / 10,
    memUsedMb: Math.round((totalMem - os.freemem()) / MB),
    memTotalMb: Math.round(totalMem / MB),
    rssMb: Math.round(rss / MB),
  };
}

function pushSample(s: SamplerState, sample: SysSample): void {
  s.buf.push(sample);
  if (s.buf.length > CAP) s.buf.splice(0, s.buf.length - CAP);
}

function tick(s: SamplerState): void {
  const cur = readNow();
  if (s.prev) {
    const sample = computeSample(s.prev, cur);
    pushSample(s, sample);
    // Persist a durable sample roughly every minute so the 24h history survives
    // a deploy/restart (the in-memory `buf` only spans the current process).
    s.sincePersist += 1;
    if (s.sincePersist >= PERSIST_EVERY) {
      s.sincePersist = 0;
      void persistSample(s, sample);
    }
  }
  s.prev = cur;
}

async function persistSample(s: SamplerState, sample: SysSample): Promise<void> {
  try {
    const { db } = await import("@/db");
    await db.execute(sql`
      INSERT INTO system_metrics_sample (cpu_pct, load1, proc_cpu_pct, mem_used_mb, mem_total_mb)
      VALUES (${sample.cpuPct}, ${sample.load1}, ${sample.procCpuPct}, ${sample.memUsedMb}, ${sample.memTotalMb})
    `);
    s.persistCount += 1;
    if (s.persistCount % TRIM_EVERY_PERSISTS === 0) {
      await db.execute(
        sql`DELETE FROM system_metrics_sample WHERE at < now() - (${SAMPLE_RETENTION_DAYS} || ' days')::interval`,
      );
    }
  } catch {
    // best-effort; a dropped sample just leaves a small gap in the 24h chart
  }
}

function ensureSampler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  s.prev = readNow();
  const timer = setInterval(() => tick(s), SAMPLE_MS);
  // Don't keep the event loop alive for a diagnostic sampler.
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Start the background sampler at server boot (from instrumentation.ts) so the
 * durable 24h history accumulates continuously — not only after an admin first
 * opens /admin/system.
 */
export function startSystemMetricsSampler(): void {
  ensureSampler();
}

async function readDisk(path = "/"): Promise<DiskUsage | null> {
  try {
    const st = await statfs(path);
    const totalB = st.blocks * st.bsize;
    const bfreeB = st.bfree * st.bsize; // total free (incl. root-reserved)
    const bavailB = st.bavail * st.bsize; // free to non-root
    const usedB = totalB - bfreeB;
    // Match `df` capacity: used / (used + available).
    const denom = usedB + bavailB;
    return {
      totalGb: Math.round((totalB / GB) * 10) / 10,
      usedGb: Math.round((usedB / GB) * 10) / 10,
      freeGb: Math.round((bavailB / GB) * 10) / 10,
      usedPct: denom > 0 ? Math.round((usedB / denom) * 100) : 0,
    };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Current metrics + rolling history + disk. Lazily starts the background
 * sampler; on the very first call (empty buffer) takes a short inline spot
 * sample so the first page load shows a real CPU% instead of a blank.
 */
export async function getSystemMetrics(): Promise<SystemMetrics> {
  const s = state();
  ensureSampler();

  if (s.buf.length === 0) {
    const a = readNow();
    await delay(250);
    const b = readNow();
    pushSample(s, computeSample(a, b));
    s.prev = b;
  }

  const latest = s.buf[s.buf.length - 1];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();
  const disk = await readDisk();

  return {
    at: Date.now(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    cores: os.cpus().length,
    loadavg: [load[0], load[1], load[2]],
    cpuPct: latest?.cpuPct ?? 0,
    procCpuPct: latest?.procCpuPct ?? 0,
    memTotalMb: Math.round(totalMem / MB),
    memUsedMb: Math.round((totalMem - freeMem) / MB),
    memFreeMb: Math.round(freeMem / MB),
    rssMb: latest?.rssMb ?? Math.round(process.memoryUsage().rss / MB),
    osUptimeS: Math.round(os.uptime()),
    procUptimeS: Math.round(process.uptime()),
    disk,
    history: s.buf.slice(),
  };
}
