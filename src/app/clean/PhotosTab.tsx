"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useSearchParams } from "next/navigation";
import { processPhotoResult, newId, getUploadConcurrency } from "@/lib/photoProcess";
import { reportClientEvent } from "@/lib/clientEvent";
import { uploadWithRetry, UploadHttpError } from "@/lib/uploadFetch";

interface Props {
  cleanId: string;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export interface PhotosTabHandle {
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

const PhotosTab = forwardRef<PhotosTabHandle, Props>(function PhotosTab(
  { cleanId, onBusyChange, onDirtyChange },
  ref
) {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Sourced from the URL (same as the clean page) so telemetry can record which
  // property an upload belongs to without threading a new prop through page.tsx.
  const property = useSearchParams().get("property") || "";

  // Mirror photos into a ref so the background pump can see items added mid-flight
  // (auto-upload joins the running queue instead of spawning a second pool).
  const photosRef = useRef<PhotoItem[]>([]);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  const pumpingRef = useRef(false);
  const pumpPromiseRef = useRef<Promise<void> | null>(null);
  const pumpRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const updatePhoto = useCallback((id: string, patch: Partial<PhotoItem>) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  // Background uploader. Idempotent: if a pump is already draining, returns the
  // in-flight promise so callers can await the same run. New pending photos added
  // while it runs are picked up via photosRef; the adaptive lane count is re-read
  // each drain. A photo shows ✓ the moment its own upload returns (no whole-folder
  // recount) — WS3 reconciles the sheet count from Drive at finish instead.
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
        // Re-fan after each drain so photos added mid-flight (or a bumped lane
        // count) are picked up without a second entry point.
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

    // A photo could have arrived in the gap between the drain check and clearing
    // the flag — start another pump so nothing is orphaned.
    run.finally(() => {
      if (photosRef.current.some((p) => p.status === "pending")) void pumpRef.current();
    });

    return run;
  }, [cleanId, property, updatePhoto]);

  useEffect(() => {
    pumpRef.current = pumpUploads;
  }, [pumpUploads]);

  // Auto-start uploads the instant photos are added (the primary WS2 ask) — no
  // button tap. Every photos change re-checks; the pump self-guards re-entry.
  useEffect(() => {
    if (photos.some((p) => p.status === "pending")) void pumpUploads();
  }, [photos, pumpUploads]);

  // Wait until the queue is fully settled (nothing pending or in-flight). Used by
  // Finish/Submit All so it can block on the background uploads landing.
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
    // Flip failures back to pending; the auto-upload effect re-pumps them.
    photosRef.current
      .filter((p) => p.status === "failed")
      .forEach((p) => updatePhoto(p.id, { status: "pending", error: undefined }));
  }, [updatePhoto]);

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

    // Reset the input so picking the same file again still fires a change event
    if (inputRef.current) inputRef.current.value = "";
  }

  function clearAll() {
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPhotos([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  const successCount = photos.filter((p) => p.status === "success").length;
  const failedCount = photos.filter((p) => p.status === "failed").length;
  const pendingCount = photos.filter((p) => p.status === "pending").length;
  const uploadingCount = photos.filter((p) => p.status === "uploading").length;
  const allDone = photos.length > 0 && photos.every((p) => p.status === "success");

  // Surface in-flight and unsent photo state to the parent so Finish Clean can
  // guard on photos too — pending/failed photos block a silent finish, same as
  // inventory and maintenance. In-flight auto-uploads keep the tab busy.
  useEffect(() => {
    onBusyChange?.(uploading);
  }, [uploading, onBusyChange]);

  useEffect(() => {
    const dirty = pendingCount > 0 || failedCount > 0;
    onDirtyChange?.(dirty);
  }, [pendingCount, failedCount, onDirtyChange]);

  useImperativeHandle(
    ref,
    () => ({
      async submitAll() {
        // Re-queue any failures for one more attempt, then wait for the queue to
        // drain. Pending/uploading photos are already being pumped automatically.
        photosRef.current
          .filter((p) => p.status === "failed")
          .forEach((p) => updatePhoto(p.id, { status: "pending", error: undefined }));
        await drainUploads();
        return photosRef.current.every((p) => p.status === "success");
      },
    }),
    [drainUploads, updatePhoto]
  );

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

      <label className="block w-full cursor-pointer">
        <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-blue-400 transition-colors">
          <div className="text-4xl mb-2">📷</div>
          <p className="text-gray-600 font-medium">
            {photos.length > 0 ? "Tap to add more photos" : "Tap to select photos"}
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
            {!allDone && failedCount > 0 && !uploading && (
              <button
                onClick={retryFailed}
                className="flex-1 bg-blue-600 text-white py-3 rounded-xl text-lg font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors"
              >
                Retry {failedCount} Failed
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
});

export default PhotosTab;
