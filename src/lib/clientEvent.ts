interface ClientEventPayload {
  event: string;
  cleanId?: string;
  uploadId?: string;
  meta?: Record<string, unknown>;
}

const ENDPOINT = "/api/client-event";

export function reportClientEvent(payload: ClientEventPayload): void {
  if (typeof window === "undefined") return;

  const body = JSON.stringify(payload);

  try {
    // sendBeacon survives page unload and is the right fit for fire-and-forget telemetry.
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
      const queued = navigator.sendBeacon(ENDPOINT, blob);
      if (queued) return;
    }
  } catch {
    // Fall through to fetch.
  }

  try {
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Telemetry must never throw into UI code.
  }
}
