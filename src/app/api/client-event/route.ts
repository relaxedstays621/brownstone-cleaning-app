import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { appendUploadLog } from "@/lib/google";

interface ClientEventBody {
  event?: string;
  cleanId?: string;
  property?: string;
  uploadId?: string;
  meta?: Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nowPstString(): string {
  return new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
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
    return NextResponse.json({ ok: true });
  }

  const meta = (body.meta && typeof body.meta === "object" ? body.meta : {}) as Record<
    string,
    unknown
  >;

  // Persist to the Upload Log sheet so failures are diagnosable by device and
  // connection long after the ephemeral docker logs roll over. Best-effort —
  // appendUploadLog never throws, but guard anyway so telemetry can't 500.
  try {
    await appendUploadLog({
      timestamp: nowPstString(),
      event: str(body.event) ?? "unknown",
      cleanId: str(body.cleanId),
      property: str(body.property),
      uploadId: str(body.uploadId),
      status: str(meta.status) ?? num(meta.status),
      error: str(meta.error),
      photoSize: num(meta.photo_size) ?? num(meta.size),
      processedSize: num(meta.processed_size),
      attempts: num(meta.attempts),
      durationMs: num(meta.duration_ms),
      fellBack: bool(meta.fell_back),
      userAgent: str(meta.ua),
      connection: str(meta.conn),
    });
  } catch {
    // Never surface telemetry failures.
  }

  return NextResponse.json({ ok: true });
}
