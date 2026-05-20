import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";

const MAX_META_CHARS = 2_000;

interface ClientEventBody {
  event?: string;
  cleanId?: string;
  uploadId?: string;
  meta?: Record<string, unknown>;
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return "";
    return json.length > MAX_META_CHARS ? `${json.slice(0, MAX_META_CHARS)}…` : json;
  } catch {
    return "<unserializable>";
  }
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    // Beacons fire from authenticated pages only; refusing without leaking detail.
    return NextResponse.json({ ok: true });
  }

  // navigator.sendBeacon sends a Blob with type "text/plain;charset=UTF-8" by default,
  // so don't rely on req.json() (it inspects Content-Type). Parse the body text manually.
  let body: ClientEventBody = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as ClientEventBody;
  } catch {
    // Swallow — telemetry must never become a client-side failure.
  }

  const event = typeof body.event === "string" ? body.event : "unknown";
  const cleanId = typeof body.cleanId === "string" ? body.cleanId : "";
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  const meta = body.meta && typeof body.meta === "object" ? safeStringify(body.meta) : "";

  console.log(
    `[client-event] event=${event} cleanId=${cleanId} uploadId=${uploadId} meta=${meta}`
  );

  return NextResponse.json({ ok: true });
}
