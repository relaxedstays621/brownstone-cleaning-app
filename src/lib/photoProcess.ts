const MAX_DIM = 1600;
const JPEG_QUALITY = 0.82;
// If every decode path fails we'd otherwise send the camera original (often
// 5–12 MB) — exactly what blows the upload timeout on field cellular. Above
// this size we refuse and ask for a retake instead of silently uploading it.
const MAX_FALLBACK_BYTES = 8 * 1024 * 1024;

// Thrown when a photo can't be processed AND the original is too large to send
// safely. Surfaced to the cleaner as a per-photo "retake" error.
export class PhotoProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoProcessError";
  }
}

export interface ProcessResult {
  blob: Blob;
  fellBack: boolean; // true = couldn't resize, sending the (small enough) original
}

function isCanvasSupported(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("2d");
  } catch {
    return false;
  }
}

// Preferred decode: createImageBitmap is lower-memory, supports more source
// formats, respects EXIF orientation, and is faster on mobile than <img>.
async function decodeBitmap(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
}

// Fallback decode for browsers without/with a failing createImageBitmap.
function loadImage(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// Scale a decoded source to MAX_DIM, stamp the timestamp, and encode to JPEG.
// Both ImageBitmap and HTMLImageElement are valid CanvasImageSource.
async function renderToBlob(
  source: CanvasImageSource,
  srcW: number,
  srcH: number
): Promise<Blob | null> {
  if (srcW <= 0 || srcH <= 0) return null;
  const scale = Math.min(1, MAX_DIM / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);

  const timestamp = new Date().toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const fontSize = Math.max(16, Math.floor(w / 30));
  ctx.font = `bold ${fontSize}px sans-serif`;
  const textWidth = ctx.measureText(timestamp).width;
  const padding = fontSize * 0.5;
  const x = padding;
  const y = h - padding;

  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(
    x - padding * 0.5,
    y - fontSize - padding * 0.3,
    textWidth + padding,
    fontSize + padding * 0.8
  );
  ctx.fillStyle = "#ffffff";
  ctx.fillText(timestamp, x, y);

  return canvasToBlob(canvas, JPEG_QUALITY);
}

// Resize + watermark a photo for upload. Returns the processed blob, or — when
// decoding isn't possible — the original IF it's small enough to send. Throws
// PhotoProcessError when processing fails and the original is too large.
export async function processPhotoResult(file: File): Promise<ProcessResult> {
  if (isCanvasSupported()) {
    const bitmap = await decodeBitmap(file);
    if (bitmap) {
      try {
        const blob = await renderToBlob(bitmap, bitmap.width, bitmap.height);
        if (blob) return { blob, fellBack: false };
      } catch (err) {
        console.warn("[photoProcess] bitmap path failed:", err);
      } finally {
        bitmap.close();
      }
    }

    const img = await loadImage(file);
    if (img) {
      try {
        const blob = await renderToBlob(img, img.width, img.height);
        if (blob) return { blob, fellBack: false };
      } catch (err) {
        console.warn("[photoProcess] canvas path failed:", err);
      }
    }
  }

  // Both decode paths failed (or canvas unsupported). Guard the original size.
  if (file.size > MAX_FALLBACK_BYTES) {
    throw new PhotoProcessError("Couldn't process this photo — please retake it");
  }
  return { blob: file, fellBack: true };
}

// Backwards-compatible wrapper for callers that only need the blob.
export async function processPhoto(file: File): Promise<Blob> {
  const { blob } = await processPhotoResult(file);
  return blob;
}

// Adaptive upload parallelism. A field phone on weak cellular chokes if we open
// too many sockets, but a healthy 4g/wifi link is under-fed at the old fixed 2.
// Read the Network Information API where present; default to a modest 3 (a safe
// bump over 2) when it's absent — Safari/iOS, the common field browser, doesn't
// expose it. effectiveType is a cellular-equivalent rating, so wifi/ethernet are
// only distinguishable via `type`.
export function getUploadConcurrency(): number {
  if (typeof navigator === "undefined") return 3;
  const conn = (
    navigator as Navigator & {
      connection?: { effectiveType?: string; type?: string };
    }
  ).connection;
  const effective = conn?.effectiveType;
  const type = conn?.type;
  if (effective === "slow-2g" || effective === "2g" || effective === "3g") return 2;
  if (effective === "4g" || type === "wifi" || type === "ethernet") return 4;
  return 3;
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}
