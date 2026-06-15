"use client";

import { useState, useRef, useEffect } from "react";
import { processPhoto, newId, runWithConcurrency } from "@/lib/photoProcess";
import { reportClientEvent } from "@/lib/clientEvent";
import { uploadWithRetry, UploadHttpError } from "@/lib/uploadFetch";

interface Props {
  cleanId: string;
  property: string;
  active: boolean;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

type PhotoStatus = "pending" | "uploading" | "success" | "failed";

interface PhotoItem {
  id: string;
  file: File;
  previewUrl: string;
  status: PhotoStatus;
  error?: string;
}

// See PhotosTab: 2 keeps field-cellular uploads from contending for the pipe.
const UPLOAD_CONCURRENCY = 2;

async function uploadOne(cleanId: string, photo: PhotoItem): Promise<void> {
  reportClientEvent({
    event: "maint-upload-attempt",
    cleanId,
    uploadId: photo.id,
    meta: { size: photo.file.size, type: photo.file.type },
  });

  const blob = await processPhoto(photo.file);
  const fd = new FormData();
  fd.append("cleanId", cleanId);
  fd.append("uploadId", photo.id);
  fd.append("photo", blob, `maint_${photo.id.slice(0, 8)}.jpg`);

  try {
    // uploadWithRetry transparently retries transient network/timeout/5xx
    // failures with backoff; only terminal errors reach here.
    await uploadWithRetry("/api/maintenance/upload-photo", fd);
  } catch (err) {
    if (err instanceof UploadHttpError) {
      reportClientEvent({
        event: "maint-upload-failed",
        cleanId,
        uploadId: photo.id,
        meta: { status: err.status, error: err.message },
      });
    } else {
      reportClientEvent({
        event: "maint-upload-network-error",
        cleanId,
        uploadId: photo.id,
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    throw err;
  }

  reportClientEvent({
    event: "maint-upload-success",
    cleanId,
    uploadId: photo.id,
  });
}

async function finalizeCount(cleanId: string): Promise<void> {
  const res = await fetch("/api/maintenance/upload-photo/finalize", {
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

export default function MaintenanceTab({
  cleanId,
  property,
  active,
  onBusyChange,
  onDirtyChange,
}: Props) {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [textSuccess, setTextSuccess] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const failedCount = photos.filter((p) => p.status === "failed").length;
  const pendingCount = photos.filter((p) => p.status === "pending").length;
  const successCount = photos.filter((p) => p.status === "success").length;
  const allPhotosDone = photos.length > 0 && photos.every((p) => p.status === "success");

  useEffect(() => {
    onBusyChange?.(uploading || submitting);
  }, [uploading, submitting, onBusyChange]);

  useEffect(() => {
    // Dirty = anything the cleaner has staged but not yet committed to the server.
    const dirty =
      text.trim().length > 0 ||
      pendingCount > 0 ||
      failedCount > 0 ||
      textError !== null ||
      finalizeError !== null;
    onDirtyChange?.(dirty);
  }, [text, pendingCount, failedCount, textError, finalizeError, onDirtyChange]);

  // Hide visible-when-active feedback when the cleaner navigates away.
  useEffect(() => {
    if (!active) {
      setTextSuccess(false);
    }
  }, [active]);

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
      setFinalizeError(null);
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  function updatePhoto(id: string, patch: Partial<PhotoItem>) {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  async function upload(mode: "pending" | "failed") {
    const queue = photos.filter((p) => p.status === mode);
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
      console.error("[MaintenanceTab] finalize failed:", err);
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

  async function submitText() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setTextSuccess(false);
    setTextError(null);
    try {
      const res = await fetch("/api/maintenance/submit-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cleanId, property, text: trimmed }),
      });
      if (!res.ok) {
        let msg = `Failed (${res.status})`;
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {}
        throw new Error(msg);
      }
      setText("");
      setTextSuccess(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't submit";
      setTextError(message);
    } finally {
      setSubmitting(false);
    }
  }

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
      <p className="text-sm text-gray-500 mb-3">
        Report any maintenance issue at this property — photos go to the maintenance
        Drive folder and the text goes to the maintenance log.
      </p>

      {/* Text section */}
      {textSuccess && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-center">
          <div className="text-3xl mb-2">✅</div>
          <p className="text-green-800 font-medium">Maintenance report submitted</p>
        </div>
      )}

      {textError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <p className="text-red-800 font-medium">Couldn&apos;t submit: {textError}</p>
          <p className="text-red-700 text-sm mt-1">
            Your text is still here — tap Submit Report again to retry.
          </p>
        </div>
      )}

      <label className="block text-sm font-medium text-gray-700 mb-1">
        Describe the issue
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. 'The kitchen faucet is leaking and there's a stain on the living room carpet'"
        className="w-full h-28 px-4 py-3 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none bg-white"
      />
      <button
        onClick={submitText}
        disabled={!text.trim() || submitting}
        className="w-full mt-3 bg-blue-600 text-white py-3 rounded-xl text-base font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? "Submitting..." : "Submit Report"}
      </button>

      {/* Photo section */}
      <div className="border-t border-gray-200 mt-6 pt-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Maintenance photos (optional)
        </label>

        {allPhotosDone && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-center">
            <p className="text-green-800 font-medium text-lg">
              &#10003; All {successCount} maintenance photo{successCount !== 1 ? "s" : ""} uploaded
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
          </div>
        )}

        <label className="block w-full cursor-pointer">
          <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 text-center hover:border-blue-400 transition-colors">
            <div className="text-3xl mb-2">🛠</div>
            <p className="text-gray-600 font-medium">
              {photos.length > 0 ? "Tap to add more photos" : "Tap to add maintenance photos"}
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
              {!allPhotosDone && pendingCount > 0 && (
                <button
                  onClick={() => upload("pending")}
                  disabled={uploading}
                  className="flex-1 bg-blue-600 text-white py-3 rounded-xl text-base font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {uploading
                    ? "Uploading..."
                    : `Upload ${pendingCount} Photo${pendingCount !== 1 ? "s" : ""}`}
                </button>
              )}
              {!allPhotosDone && pendingCount === 0 && failedCount > 0 && (
                <button
                  onClick={() => upload("failed")}
                  disabled={uploading}
                  className="flex-1 bg-blue-600 text-white py-3 rounded-xl text-base font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {uploading ? "Uploading..." : `Retry ${failedCount} Failed`}
                </button>
              )}
              {allPhotosDone && (
                <button
                  onClick={clearAll}
                  className="flex-1 bg-gray-200 text-gray-700 py-3 rounded-xl text-base font-medium hover:bg-gray-300"
                >
                  Done
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
