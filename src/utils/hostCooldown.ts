import { logger } from './logger.js';

// Default backoff when we see a 429 but can't parse a specific wait target.
// 90s is empirically what Instagram's first 429 asks for; longer values risk
// alienating users, shorter values risk extending the punitive window.
const DEFAULT_COOLDOWN_MS = 90 * 1000;
// Hard cap so a malformed parse can't lock a host out for hours.
const MAX_COOLDOWN_MS = 30 * 60 * 1000;
// Small buffer past the suggested time — just enough to clear the window.
const POST_TARGET_BUFFER_MS = 5_000;

const cooldowns = new Map<string, number>(); // host → epoch ms when allowed

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /Too Many Requests/i,
  /HTTP Error 429/i,
  /Waiting until \d{2}:\d{2}:\d{2}/i,
];

/**
 * Returns ms remaining on a host's cooldown, or 0 if free.
 * Self-prunes the entry once expired so the map doesn't accumulate stale keys.
 */
export function getCooldownRemainingMs(host: string): number {
  const until = cooldowns.get(host);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(host);
    return 0;
  }
  return remaining;
}

/**
 * True if any of the known 429 patterns appear in the error message.
 * Used by callers to decide whether to call applyRateLimitFromError.
 */
export function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

/**
 * Parse gallery-dl's "Waiting until HH:MM:SS" hint to an absolute epoch ms.
 * Falls back to DEFAULT_COOLDOWN_MS from now if no timestamp is present.
 * Capped at MAX_COOLDOWN_MS to bound damage from a misread or stale clock.
 */
export function computeCooldownTarget(errorMessage: string, now: number = Date.now()): number {
  const match = errorMessage.match(/Waiting until (\d{2}):(\d{2}):(\d{2})/i);
  if (!match) return now + DEFAULT_COOLDOWN_MS;

  const [, hh, mm, ss] = match;
  const today = new Date(now);
  today.setUTCHours(Number(hh), Number(mm), Number(ss), 0);
  let target = today.getTime() + POST_TARGET_BUFFER_MS;

  // Roll forward if HH:MM:SS already passed today (gallery-dl logs UTC).
  if (target <= now) target += 24 * 60 * 60 * 1000;

  const cappedDelta = Math.min(target - now, MAX_COOLDOWN_MS);
  return now + cappedDelta;
}

/**
 * Records a cooldown for a host based on a rate-limit error message.
 * Returns the wait remaining in seconds (rounded up) so callers can echo it.
 */
export function applyRateLimitFromError(host: string, errorMessage: string): number {
  const target = computeCooldownTarget(errorMessage);
  cooldowns.set(host, target);
  const seconds = Math.ceil((target - Date.now()) / 1000);
  logger.warn(`Host ${host} entered cooldown for ${seconds}s after rate-limit signal`);
  return seconds;
}
