import { safeExec } from '../utils/exec.js';
import { logger } from '../utils/logger.js';

interface ToolSpec {
  readonly name: string;
  readonly binary: string;
  readonly pypiPackage: string;
}

const TOOLS: readonly ToolSpec[] = [
  { name: 'gallery-dl', binary: 'gallery-dl', pypiPackage: 'gallery-dl' },
  { name: 'yt-dlp', binary: 'yt-dlp', pypiPackage: 'yt-dlp' },
];

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

async function getInstalledVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await safeExec(binary, ['--version'], { timeout: 10 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getLatestPypiVersion(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${packageName}/json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { info?: { version?: string } };
    return data.info?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Compares dot-separated CalVer/SemVer numerically, ignoring trailing
 * non-numeric segments (e.g. ".dev0"). Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Handles yt-dlp's mixed leading-zero / dev-snapshot quirks correctly:
 * "2026.04.10.235301" > "2026.3.17" because component 1 (04 vs 3) goes 4 > 3.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .split(/[.+-]/)
      .map((p) => Number.parseInt(p, 10))
      .filter((n) => Number.isFinite(n));
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

async function checkOnce(): Promise<void> {
  for (const tool of TOOLS) {
    const [installed, latest] = await Promise.all([
      getInstalledVersion(tool.binary),
      getLatestPypiVersion(tool.pypiPackage),
    ]);
    if (!installed || !latest) {
      logger.debug(
        `Version check skipped for ${tool.name} (installed=${installed ?? 'unknown'}, latest=${latest ?? 'unknown'})`,
      );
      continue;
    }
    const cmp = compareVersions(installed, latest);
    if (cmp >= 0) {
      // Installed is current or newer (e.g. dev snapshot ahead of latest stable).
      logger.info(`${tool.name} ${installed} is up to date (PyPI latest ${latest})`);
    } else {
      logger.warn(`${tool.name} ${installed} is outdated — latest is ${latest}`);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Async runtime check that compares installed gallery-dl / yt-dlp versions
 * against PyPI's latest. Runs once at startup, then every 24h. Failures
 * (network, missing binary) are logged at debug level and never crash the
 * bot — this is purely a freshness signal.
 */
export function startVersionCheck(): void {
  if (timer) return; // idempotent: a second call must not orphan the existing interval
  void checkOnce().catch((error) => logger.debug('Version check failed', { error }));
  timer = setInterval(() => {
    void checkOnce().catch((error) => logger.debug('Periodic version check failed', { error }));
  }, CHECK_INTERVAL_MS);
  timer.unref();
}

export function stopVersionCheck(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
