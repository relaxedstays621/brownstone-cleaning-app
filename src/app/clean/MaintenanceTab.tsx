"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { processPhotoResult, newId, getUploadConcurrency } from "@/lib/photoProcess";
import { reportClientEvent } from "@/lib/clientEvent";
import { uploadWithRetry, UploadHttpError } from "@/lib/uploadFetch";

interface Props {
  cleanId: string;
  property: string;
  active: boolean;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export interface MaintenanceTabHandle {
  submitAll: () => Promise<boolean>;
}

type PhotoStatus = "pending" | "uploading" | "success" | "failed";

interface PhotoItem {
  id: string;
  file: File;
  previewUrl: string;
  status: PhotoStatus;
  error?: string;
}

// Mirrors PhotosTab.uploadOne's telemetry (WS2 spot-checks throughput via the
// Upload Log's duration_ms / processed_size / attempts / fell_back), so a
// maintenance-photo speed regression is as diagnosable as a cleaning-photo one.
async function uploadOne(cleanId: string, property: string, photo: PhotoItem): Promise<void> {
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const photoSize = photo.file.size;
  let attempts = 0;
  let fellBack = false;
  let processedSize = 0;

  reportClientEvent({
    event: "maint-upload-attempt",
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
      event: "maint-upload-failed",
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
  fd.append("photo", blob, `maint_${photo.id.slice(0, 8)}.jpg`);

  const durationMs = () =>
    Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt);

  try {
    // uploadWithRetry transparently retries transient network/timeout/5xx
    // failures with backoff; only terminal errors reach here.
    await uploadWithRetry("/api/maintenance/upload-photo", fd, {
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
        event: "maint-upload-failed",
        cleanId,
        property,
        uploadId: photo.id,
        meta: { ...base, status: err.status, error: err.message },
      });
    } else {
      reportClientEvent({
        event: "maint-upload-network-error",
        cleanId,
        property,
        uploadId: photo.id,
        meta: { ...base, error: err instanceof Error ? err.message : String(err) },
      });
    }
    throw err;
  }

  reportClientEvent({
    event: "maint-upload-success",
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

const MaintenanceTab = forwardRef<MaintenanceTabHandle, Props>(function MaintenanceTab(
  { cleanId, property, active, onBusyChange, onDirtyChange },
  ref
) {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [textSuccess, setTextSuccess] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror photos into a ref so the background pump can see items added mid-flight
  // (auto-upload joins the running queue instead of spawning a second pool).
  const photosRef = useRef<PhotoItem[]>([]);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  const pumpingRef = useRef(false);
  const pumpPromiseRef = useRef<Promise<void> | null>(null);
  const pumpRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const failedCount = photos.filter((p) => p.status === "failed").length;
  const pendingCount = photos.filter((p) => p.status === "pending").length;
  const uploadingCount = photos.filter((p) => p.status === "uploading").length;
  const successCount = photos.filter((p) => p.status === "success").length;
  const allPhotosDone = photos.length > 0 && photos.every((p) => p.status === "success");

  const updatePhoto = useCallback((id: string, patch: Partial<PhotoItem>) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  // Background uploader. See PhotosTab — idempotent, re-fans for mid-flight
  // additions, shows ✓ as each upload returns; the sheet count is reconciled from
  // Drive at finish (WS3) rather than a per-batch recount.
  const pumpUploads = useCallback((): Promise<void> => {
    if (pumpingRef.current) return pumpPromiseRef.current ?? Promise.resolve();
    if (!photosRef.current.some((p) => p.status === "pending")) return Promise.resolve();

    pumpingRef.current = true;
    setUploading(true);

    const inFlight = new Set<string>();
    const nextPending = () =>
      photosRef.current.find((p) => p.status === "pending" && !inFlight.has(p.id));

    const worker = async (): Promise<void> => {
      for (;;) {
        const photo = nextPending();
        if (!photo) return;
        inFlight.add(photo.id);
        updatePhoto(photo.id, { status: "uploading", error: undefined });
        try {
          await uploadOne(cleanId, property, photo);
          updatePhoto(photo.id, { status: "success" });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Upload failed";
          updatePhoto(photo.id, { status: "failed", error: message });
        } finally {
          inFlight.delete(photo.id);
        }
      }
    };

    const run = (async () => {
      try {
        for (;;) {
          const lanes = getUploadConcurrency();
          await Promise.all(Array.from({ length: lanes }, () => worker()));
          if (!photosRef.current.some((p) => p.status === "pending")) break;
        }
      } finally {
        pumpingRef.current = false;
        setUploading(false);
      }
    })();
    pumpPromiseRef.current = run;

    run.finally(() => {
      if (photosRef.current.some((p) => p.status === "pending")) void pumpRef.current();
    });

    return run;
  }, [cleanId, property, updatePhoto]);

  useEffect(() => {
    pumpRef.current = pumpUploads;
  }, [pumpUploads]);

  // Auto-start uploads the instant photos are added — no button tap.
  useEffect(() => {
    if (photos.some((p) => p.status === "pending")) void pumpUploads();
  }, [photos, pumpUploads]);

  const drainUploads = useCallback(async (): Promise<void> => {
    for (;;) {
      await pumpUploads();
      if (
        !photosRef.current.some(
          (p) => p.status === "pending" || p.status === "uploading"
        )
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  }, [pumpUploads]);

  const retryFailed = useCallback(() => {
    photosRef.current
      .filter((p) => p.status === "failed")
      .forEach((p) => updatePhoto(p.id, { status: "pending", error: undefined }));
  }, [updatePhoto]);

  useEffect(() => {
    onBusyChange?.(uploading || submitting);
  }, [uploading, submitting, onBusyChange]);

  useEffect(() => {
    // Dirty = anything the cleaner has staged but not yet committed to the server.
    const dirty =
      text.trim().length > 0 ||
      pendingCount > 0 ||
      failedCount > 0 ||
      textError !== null;
    onDirtyChange?.(dirty);
  }, [text, pendingCount, failedCount, textError, onDirtyChange]);

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

    // New pending items start uploading automatically via the effect above.
    if (additions.length > 0) {
      setPhotos((prev) => [...prev, ...additions]);
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  function clearAll() {
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPhotos([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function submitText(): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return true;
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
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't submit";
      setTextError(message);
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  useImperativeHandle(ref, () => ({
    async submitAll() {
      const tasks: Promise<boolean>[] = [];
      if (text.trim().length > 0) tasks.push(submitText());
      // Re-queue any failed photos, then wait for the photo queue to drain.
      photosRef.current
        .filter((p) => p.status === "failed")
        .forEach((p) => updatePhoto(p.id, { status: "pending", error: undefined }));
      tasks.push(
        drainUploads().then(() =>
          photosRef.current.every((p) => p.status === "success")
        )
      );
      const results = await Promise.all(tasks);
      return results.every(Boolean);
    },
  }));

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

        <label className="block w-full cursor-pointer">
          <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 text-center hover:border-blue-400 transition-colors">
            <div className="text-3xl mb-2">🛠</div>
            <p className="text-gray-600 font-medium">
              {photos.length > 0 ? "Tap to add more photos" : "Tap to add maintenance photos"}
            </p>
            <p className="text-gray-400 text-sm mt-1">Uploads start automatically</p>
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
              {uploadingCount > 0 && ` · ${uploadingCount} uploading`}
              {pendingCount > 0 && ` · ${pendingCount} pending`}
              {failedCount > 0 && ` · ${failedCount} failed`}
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
              {!allPhotosDone && failedCount > 0 && !uploading && (
                <button
                  onClick={retryFailed}
                  className="flex-1 bg-blue-600 text-white py-3 rounded-xl text-base font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors"
                >
                  Retry {failedCount} Failed
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
});

export default MaintenanceTab;
