type GaxiosLike = { code?: number | string; status?: number; response?: { status?: number } };

const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED"]);

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as GaxiosLike;
  const status = e.status ?? e.response?.status;
  if (typeof status === "number" && TRANSIENT_HTTP.has(status)) return true;
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  if (typeof e.code === "number" && TRANSIENT_HTTP.has(e.code)) return true;
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  label?: string;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;
  const label = opts.label ?? "op";

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isTransient(err)) {
        throw err;
      }
      const delay = Math.min(maxMs, baseMs * Math.pow(4, i));
      const jitter = Math.floor(Math.random() * 250);
      console.warn(`[retry:${label}] attempt ${i + 1} failed, retrying in ${delay + jitter}ms`, err);
      await sleep(delay + jitter);
    }
  }
  throw lastErr;
}
