// Browser-side resilient upload helper.
//
// Deliberately NOT lib/retry.ts (that one classifies Gaxios/Node errors for the
// server→Google path). This helper understands the failure modes a phone on
// field cellular actually hits when POSTing a photo to our own API:
//
//   - network TypeError ("Failed to fetch") .... retryable (connection dropped)
//   - AbortError from the timeout ............... retryable (request hung)
//   - 408 / 429 / 5xx responses ................. retryable (transient server/proxy)
//   - any other 4xx ............................. NOT retryable (auth/validation — won't fix itself)
//
// Retries are safe because the upload routes dedup by uploadId, so a re-sent
// request never creates a duplicate Drive file.

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_BASE_MS = 600;
const DEFAULT_MAX_MS = 8_000;

// Thrown when the server returned a non-OK HTTP status that we've stopped
// retrying (either a non-retryable 4xx, or a retryable status on the last
// attempt). Carries the status so callers can branch telemetry on it.
export class UploadHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadHttpError";
    this.status = status;
  }
}

export interface UploadFetchOptions {
  attempts?: number;
  timeoutMs?: number;
  baseMs?: number;
  maxMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return delay + Math.floor(Math.random() * 250);
}

async function toHttpError(res: Response): Promise<UploadHttpError> {
  let msg = `HTTP ${res.status}`;
  try {
    const data = await res.json();
    if (data?.error) msg = data.error;
  } catch {
    // Non-JSON body — keep the status-code message.
  }
  return new UploadHttpError(res.status, msg);
}

// POSTs `body` to `url` with a per-attempt timeout and exponential backoff.
// Resolves with the successful Response (body unread — caller may read it).
// Rejects with UploadHttpError for terminal HTTP failures, or the underlying
// network/abort error when all retries are exhausted.
export async function uploadWithRetry(
  url: string,
  body: BodyInit,
  opts: UploadFetchOptions = {}
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const isLast = attempt === attempts - 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", body, signal: controller.signal });
    } catch (err) {
      // Network TypeError ("Failed to fetch") or AbortError (hit the timeout).
      // Both are transient from the client's point of view → retry.
      clearTimeout(timer);
      lastErr = err;
      if (isLast) throw err;
      await sleep(backoffMs(attempt, baseMs, maxMs));
      continue;
    }
    clearTimeout(timer);

    if (res.ok) return res;

    // Non-retryable status (any 4xx except 408/429): fail immediately — a retry
    // would just reproduce the same auth/validation rejection.
    if (!RETRYABLE_STATUS.has(res.status)) {
      throw await toHttpError(res);
    }

    // Retryable status (408/429/5xx): back off and try again unless exhausted.
    lastErr = await toHttpError(res);
    if (isLast) throw lastErr;
    await sleep(backoffMs(attempt, baseMs, maxMs));
  }

  throw lastErr;
}
