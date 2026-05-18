"use client";

import { useState, useRef } from "react";

interface Props {
  cleanId: string;
}

type PhotoStatus = "pending" | "uploading" | "success" | "failed";

interface PhotoItem {
  id: string;
  file: File;
  previewUrl: string;
  status: PhotoStatus;
  error?: string;
}

const MAX_DIM = 1600;
const JPEG_QUALITY = 0.82;
const UPLOAD_CONCURRENCY = 3;

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

async function processPhoto(file: File): Promise<Blob> {
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
    console.warn("[PhotosTab] processPhoto failed, falling back to original:", err);
    return file;
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function uploadOne(cleanId: string, photo: PhotoItem): Promise<void> {
  const blob = await processPhoto(photo.file);
  const fd = new FormData();
  fd.append("cleanId", cleanId);
  fd.append("uploadId", photo.id);
  fd.append("photo", blob, `photo_${photo.id.slice(0, 8)}.jpg`);

  const res = await fetch("/api/upload-photos", { method: "POST", body: fd });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
}

async function runWithConcurrency<T>(
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

async function finalizeCount(cleanId: string): Promise<void> {
  const res = await fetch("/api/upload-photos/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cleanId }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
}

export default function PhotosTab({ cleanId }: Props) {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    setPhotos((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      return selected.map((file) => ({
        id: newId(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: "pending",
      }));
    });
    setFinalizeError(null);
  }

  function updatePhoto(id: string, patch: Partial<PhotoItem>) {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  async function upload(mode: "pending" | "failed") {
    const targetStatus: PhotoStatus = mode;
    const queue = photos.filter((p) => p.status === targetStatus);
    if (queue.length === 0) return;

    setUploading(true);
    setFinalizeError(null);
    queue.forEach((p) => updatePhoto(p.id, { status: "uploading", error: undefined }));

    await runWithConcurrency(queue, UPLOAD_CONCURRENCY, async (photo) => {
      try {
        await uploadOne(cleanId, photo);
        updatePhoto(photo.id, { status: "success" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        updatePhoto(photo.id, { status: "failed", error: message });
      }
    });

    try {
      await finalizeCount(cleanId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sheet update failed";
      console.error("[PhotosTab] finalize failed:", err);
      setFinalizeError(message);
    }

    setUploading(false);
  }

  function clearAll() {
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPhotos([]);
    setFinalizeError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function retryFinalize() {
    setFinalizeError(null);
    try {
      await finalizeCount(cleanId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sheet update failed";
      setFinalizeError(message);
    }
  }

  const successCount = photos.filter((p) => p.status === "success").length;
  const failedCount = photos.filter((p) => p.status === "failed").length;
  const pendingCount = photos.filter((p) => p.status === "pending").length;
  const allDone = photos.length > 0 && photos.every((p) => p.status === "success");

  const statusBadge = (status: PhotoStatus): { label: string; cls: string } => {
    switch (status) {
      case "success":
        return { label: "✓", cls: "bg-green-600 text-white" };
      case "failed":
        return { label: "!", cls: "bg-red-600 text-white" };
      case "uploading":
        return { label: "…", cls: "bg-blue-600 text-white animate-pulse" };
      default:
        return { label: "•", cls: "bg-gray-300 text-gray-700" };
    }
  };

  return (
    <div>
      {allDone && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-center">
          <p className="text-green-800 font-medium text-lg">
            &#10003; All {successCount} photo{successCount !== 1 ? "s" : ""} uploaded
          </p>
        </div>
      )}

      {failedCount > 0 && !uploading && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <p className="text-red-800 font-medium">
            {failedCount} photo{failedCount !== 1 ? "s" : ""} failed.{" "}
            {successCount > 0
              ? `${successCount} succeeded and won't be re-uploaded.`
              : ""}
          </p>
        </div>
      )}

      {finalizeError && !uploading && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-4">
          <p className="text-yellow-900 font-medium">
            Photos are in Drive but the sheet count didn&apos;t update: {finalizeError}
          </p>
          <button
            onClick={retryFinalize}
            className="mt-2 bg-yellow-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-yellow-700"
          >
            Retry sheet update
          </button>
        </div>
      )}

      <label className="block w-full cursor-pointer">
        <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-blue-400 transition-colors">
          <div className="text-4xl mb-2">📷</div>
          <p className="text-gray-600 font-medium">Tap to select photos</p>
          <p className="text-gray-400 text-sm mt-1">Select multiple from camera roll</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
      </label>

      {photos.length > 0 && (
        <>
          <p className="text-sm text-gray-500 mt-4 mb-2">
            {photos.length} selected
            {successCount > 0 && ` · ${successCount} uploaded`}
            {failedCount > 0 && ` · ${failedCount} failed`}
            {pendingCount > 0 && ` · ${pendingCount} pending`}
          </p>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {photos.map((p) => {
              const badge = statusBadge(p.status);
              return (
                <div
                  key={p.id}
                  className="relative aspect-square rounded-lg overflow-hidden bg-gray-100"
                  title={p.error}
                >
                  <img src={p.previewUrl} alt="" className="w-full h-full object-cover" />
                  <span
                    className={`absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="flex gap-3">
            {!allDone && pendingCount > 0 && (
              <button
                onClick={() => upload("pending")}
                disabled={uploading}
                className="flex-1 bg-blue-600 text-white py-3 rounded-xl text-lg font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading
                  ? "Uploading..."
                  : `Upload ${pendingCount} Photo${pendingCount !== 1 ? "s" : ""}`}
              </button>
            )}
            {!allDone && pendingCount === 0 && failedCount > 0 && (
              <button
                onClick={() => upload("failed")}
                disabled={uploading}
                className="flex-1 bg-blue-600 text-white py-3 rounded-xl text-lg font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading ? "Uploading..." : `Retry ${failedCount} Failed`}
              </button>
            )}
            {allDone && (
              <button
                onClick={clearAll}
                className="flex-1 bg-gray-200 text-gray-700 py-3 rounded-xl text-lg font-medium hover:bg-gray-300"
              >
                Done
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
