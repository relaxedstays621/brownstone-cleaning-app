"use client";

import { useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { processPhotoResult, newId, runWithConcurrency } from "@/lib/photoProcess";
import { reportClientEvent } from "@/lib/clientEvent";
import { uploadWithRetry, UploadHttpError } from "@/lib/uploadFetch";

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

// Cellular uplinks in the field are weak; 2 concurrent uploads leave headroom
// so a single photo's bytes aren't fighting two others for the same pipe.
const UPLOAD_CONCURRENCY = 2;

async function uploadOne(cleanId: string, property: string, photo: PhotoItem): Promise<void> {
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const photoSize = photo.file.size;
  let attempts = 0;
  let fellBack = false;
  let processedSize = 0;

  reportClientEvent({
    event: "upload-attempt",
    cleanId,
    property,
    uploadId: photo.id,
    meta: { photo_size: photoSize, type: photo.file.type },
  });

  let blob: Blob;
  try {
    const result = await processPhotoResult(photo.file);
    blob = result.blob;
    fellBack = result.fellBack;
    processedSize = blob.size;
  } catch (err) {
    // Decode failed and the original is too large to send — surface "retake".
    reportClientEvent({
      event: "upload-failed",
      cleanId,
      property,
      uploadId: photo.id,
      meta: {
        stage: "process",
        error: err instanceof Error ? err.message : String(err),
        photo_size: photoSize,
      },
    });
    throw err;
  }

  const fd = new FormData();
  fd.append("cleanId", cleanId);
  fd.append("uploadId", photo.id);
  fd.append("photo", blob, `photo_${photo.id.slice(0, 8)}.jpg`);

  const durationMs = () =>
    Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt);

  try {
    // uploadWithRetry transparently retries transient network/timeout/5xx
    // failures with backoff; only terminal errors reach here.
    await uploadWithRetry("/api/upload-photos", fd, {
      onAttempt: () => {
        attempts += 1;
      },
    });
  } catch (err) {
    const base = {
      photo_size: photoSize,
      processed_size: processedSize,
      attempts,
      duration_ms: durationMs(),
      fell_back: fellBack,
    };
    if (err instanceof UploadHttpError) {
      reportClientEvent({
        event: "upload-failed",
        cleanId,
        property,
        uploadId: photo.id,
        meta: { ...base, status: err.status, error: err.message },
      });
    } else {
      reportClientEvent({
        event: "upload-network-error",
        cleanId,
        property,
        uploadId: photo.id,
        meta: { ...base, error: err instanceof Error ? err.message : String(err) },
      });
    }
    throw err;
  }

  reportClientEvent({
    event: "upload-success",
    cleanId,
    property,
    uploadId: photo.id,
    meta: {
      photo_size: photoSize,
      processed_size: processedSize,
      attempts,
      duration_ms: durationMs(),
      fell_back: fellBack,
    },
  });
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
  // Sourced from the URL (same as the clean page) so telemetry can record which
  // property an upload belongs to without threading a new prop through page.tsx.
  const property = useSearchParams().get("property") || "";

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    if (selected.length === 0) return;

    const existingKeys = new Set(
      photos.map((p) => `${p.file.name}|${p.file.size}|${p.file.lastModified}`)
    );
    const additions: PhotoItem[] = selected
      .filter((file) => !existingKeys.has(`${file.name}|${file.size}|${file.lastModified}`))
      .map((file) => ({
        id: newId(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: "pending",
      }));

    if (additions.length > 0) {
      setPhotos((prev) => [...prev, ...additions]);
      // Only clear an outstanding finalize error when there's new work to do;
      // duplicate-only re-selection must not hide a still-stale sheet count.
      setFinalizeError(null);
    }

    // Reset the input so picking the same file again still fires a change event
    if (inputRef.current) inputRef.current.value = "";
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
        await uploadOne(cleanId, property, photo);
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
          <p className="text-gray-600 font-medium">
            {photos.length > 0 ? "Tap to add more photos" : "Tap to select photos"}
          </p>
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
