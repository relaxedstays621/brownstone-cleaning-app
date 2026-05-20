const MAX_DIM = 1600;
const JPEG_QUALITY = 0.82;

function isCanvasSupported(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("2d");
  } catch {
    return false;
  }
}

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

export async function processPhoto(file: File): Promise<Blob> {
  if (!isCanvasSupported()) return file;

  const img = await loadImage(file);
  if (!img) return file;

  try {
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);

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

    const blob = await canvasToBlob(canvas, JPEG_QUALITY);
    return blob ?? file;
  } catch (err) {
    console.warn("[photoProcess] failed, falling back to original:", err);
    return file;
  }
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
