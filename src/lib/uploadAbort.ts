// Shared abort-detection for the photo upload routes.
//
// When a request body is aborted or the connection resets mid-parse (e.g. a
// cleaner on flaky cellular drops the upload), `req.formData()` throws an abort
// error rather than a "malformed body" error. The two upload routes must treat
// that as a transient, RETRYABLE failure (HTTP 408) instead of a terminal 400 —
// the client's uploadWithRetry only retries 408/429/5xx. Single source of truth
// so the two endpoints can't drift on what counts as retryable.
export function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  const msg = (e.message || "").toLowerCase();
  const code = e.code || "";
  if (
    e.name === "AbortError" ||
    msg === "aborted" ||
    msg.includes("aborted") ||
    msg.includes("reset") ||
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "UND_ERR_ABORTED"
  ) {
    return true;
  }
  // undici commonly wraps the underlying socket error under `.cause`.
  return e.cause != null && e.cause !== err ? isAbortLike(e.cause) : false;
}
