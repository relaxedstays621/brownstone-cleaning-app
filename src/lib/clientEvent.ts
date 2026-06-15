interface ClientEventPayload {
  event: string;
  cleanId?: string;
  property?: string;
  uploadId?: string;
  meta?: Record<string, unknown>;
}

const ENDPOINT = "/api/client-event";

// Network class, for diagnosing failures by connection quality. navigator.connection
// is non-standard and absent on iOS Safari, so it's read defensively.
function connectionLabel(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (navigator as any).connection;
  if (!c) return undefined;
  const parts: string[] = [];
  if (c.effectiveType) parts.push(String(c.effectiveType));
  if (typeof c.downlink === "number") parts.push(`${c.downlink}Mbps`);
  return parts.length ? parts.join(" ") : undefined;
}

export function reportClientEvent(payload: ClientEventPayload): void {
  if (typeof window === "undefined") return;

  // Attach device/connection context once, here, so every caller's telemetry
  // carries it without repeating the boilerplate.
  const enriched: ClientEventPayload = {
    ...payload,
    meta: {
      ...(payload.meta ?? {}),
      ua: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      conn: connectionLabel(),
    },
  };

  const body = JSON.stringify(enriched);

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
