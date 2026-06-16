"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PhotosTab, { type PhotosTabHandle } from "./PhotosTab";
import InventoryTab, { type InventoryTabHandle } from "./InventoryTab";
import MaintenanceTab, { type MaintenanceTabHandle } from "./MaintenanceTab";

type TabKey = "photos" | "inventory" | "maintenance";

function useUnsupportedBrowser() {
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent;
    const isDuckDuckGo = /DuckDuckGo/i.test(ua);
    const hasCanvas = (() => {
      try {
        const c = document.createElement("canvas");
        return !!c.getContext("2d");
      } catch {
        return false;
      }
    })();
    setUnsupported(isDuckDuckGo || !hasCanvas);
  }, []);
  return unsupported;
}

function CleanPageInner() {
  const [activeTab, setActiveTab] = useState<TabKey>("photos");
  const [authChecked, setAuthChecked] = useState(false);
  const [showFinishModal, setShowFinishModal] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [submittingAll, setSubmittingAll] = useState(false);
  const [submitAllError, setSubmitAllError] = useState<string | null>(null);
  const [photosBusy, setPhotosBusy] = useState(false);
  const [photosDirty, setPhotosDirty] = useState(false);
  const [photosCount, setPhotosCount] = useState(0);
  const [maintenancePhotosCount, setMaintenancePhotosCount] = useState(0);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [inventoryDirty, setInventoryDirty] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceDirty, setMaintenanceDirty] = useState(false);
  const photosRef = useRef<PhotosTabHandle>(null);
  const inventoryRef = useRef<InventoryTabHandle>(null);
  const maintenanceRef = useRef<MaintenanceTabHandle>(null);
  const unsupportedBrowser = useUnsupportedBrowser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const property = searchParams.get("property") || "";
  const cleanId = searchParams.get("cleanId") || "";

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((data) => {
        if (!data.authenticated) router.replace("/");
        else if (!property || !cleanId) router.replace("/select-property");
        else setAuthChecked(true);
      });
  }, [router, property, cleanId]);

  // Publish dirty/in-flight state to the global version gate + idle-logout so
  // neither reloads nor logs out over unsaved or uploading work.
  useEffect(() => {
    const w = window as Window & { __cleanGuardReload?: boolean; __cleanBusy?: boolean };
    // "busy" also covers the finish/submit-all network writes, so neither the
    // version reload nor the idle logout can fire mid-write (e.g. over the
    // in-flight /api/finish-clean POST after Submit All clears dirty/busy).
    const busy =
      photosBusy || inventoryBusy || maintenanceBusy || finishing || submittingAll;
    w.__cleanBusy = busy;
    w.__cleanGuardReload = busy || photosDirty || inventoryDirty || maintenanceDirty;
  }, [
    photosBusy,
    inventoryBusy,
    maintenanceBusy,
    photosDirty,
    inventoryDirty,
    maintenanceDirty,
    finishing,
    submittingAll,
  ]);

  useEffect(() => {
    return () => {
      const w = window as Window & { __cleanGuardReload?: boolean; __cleanBusy?: boolean };
      w.__cleanGuardReload = false;
      w.__cleanBusy = false;
    };
  }, []);

  async function handleFinishClean() {
    setFinishing(true);
    try {
      const res = await fetch("/api/finish-clean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property, cleanId }),
      });
      if (!res.ok) throw new Error("Failed");
      router.push("/select-property");
    } catch {
      alert("Failed to finish clean. Please try again.");
      setFinishing(false);
      setShowFinishModal(false);
    }
  }

  async function handleSubmitAll() {
    setSubmittingAll(true);
    setSubmitAllError(null);
    try {
      const results = await Promise.all([
        photosRef.current?.submitAll() ?? Promise.resolve(true),
        inventoryRef.current?.submitAll() ?? Promise.resolve(true),
        maintenanceRef.current?.submitAll() ?? Promise.resolve(true),
      ]);
      const allOk = results.every(Boolean);
      if (allOk) {
        await handleFinishClean();
      } else {
        setSubmitAllError("Some items didn't submit — see the warnings above and try again.");
      }
    } catch (err) {
      setSubmitAllError(err instanceof Error ? err.message : "Submit All failed");
    } finally {
      setSubmittingAll(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: "photos", label: "Submit Photos" },
    { key: "inventory", label: "Report Inventory" },
    { key: "maintenance", label: "Report Maintenance" },
  ];

  const anyBusy = photosBusy || inventoryBusy || maintenanceBusy;
  const anyDirty = photosDirty || inventoryDirty || maintenanceDirty;

  // "photos and inventory", "photos, inventory, and maintenance", etc.
  function humanList(items: string[]): string {
    if (items.length <= 1) return items[0] ?? "";
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }
  const busyLabels = [
    photosBusy && "photos",
    inventoryBusy && "inventory",
    maintenanceBusy && "maintenance",
  ].filter(Boolean) as string[];
  const dirtyLabels = [
    photosDirty && "photos",
    inventoryDirty && "inventory",
    maintenanceDirty && "maintenance",
  ].filter(Boolean) as string[];

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500">Cleaning</p>
            <h1 className="text-lg font-bold leading-tight">{property}</h1>
          </div>
          <button
            onClick={() => router.push("/select-property")}
            className="text-sm text-blue-600 font-medium"
          >
            Switch
          </button>
        </div>
      </div>

      {/* Browser warning */}
      {unsupportedBrowser && (
        <div className="bg-yellow-50 border-b border-yellow-200 px-4 py-2">
          <p className="max-w-lg mx-auto text-yellow-800 text-sm text-center font-medium">
            For best results, please use Chrome or Safari
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-lg mx-auto flex">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex-1 py-3 text-center font-medium text-xs sm:text-sm transition-colors ${
                activeTab === t.key
                  ? "text-blue-600 border-b-2 border-blue-600"
                  : "text-gray-500"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content — all tabs stay mounted so state and in-flight requests survive a tab switch */}
      <div className="max-w-lg mx-auto p-4">
        <div className={activeTab === "photos" ? "" : "hidden"}>
          <PhotosTab
            ref={photosRef}
            cleanId={cleanId}
            onBusyChange={setPhotosBusy}
            onDirtyChange={setPhotosDirty}
            onCountChange={setPhotosCount}
          />
        </div>
        <div className={activeTab === "inventory" ? "" : "hidden"}>
          <InventoryTab
            ref={inventoryRef}
            property={property}
            cleanId={cleanId}
            active={activeTab === "inventory"}
            onBusyChange={setInventoryBusy}
            onDirtyChange={setInventoryDirty}
          />
        </div>
        <div className={activeTab === "maintenance" ? "" : "hidden"}>
          <MaintenanceTab
            ref={maintenanceRef}
            cleanId={cleanId}
            property={property}
            active={activeTab === "maintenance"}
            onBusyChange={setMaintenanceBusy}
            onDirtyChange={setMaintenanceDirty}
            onCountChange={setMaintenancePhotosCount}
          />
        </div>
      </div>

      {/* Finish Clean Button — fixed at bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4">
        <div className="max-w-lg mx-auto">
          <button
            onClick={() => setShowFinishModal(true)}
            className="w-full bg-green-600 text-white py-3 rounded-xl text-lg font-medium hover:bg-green-700 active:bg-green-800 transition-colors"
          >
            Finish Clean
          </button>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showFinishModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <h2 className="text-lg font-bold mb-2">Finish Clean?</h2>
            <p className="text-gray-600 mb-4">
              Have you submitted all photos and logged all inventory and maintenance reports?
            </p>

            {/* Upload tripwire: show how many photos actually made it, so a clean
                about to finish with 0 photos is obvious before it's too late. */}
            <div
              className={`rounded-lg p-3 mb-4 border ${
                photosCount === 0 ? "bg-amber-50 border-amber-200" : "bg-gray-50 border-gray-200"
              }`}
            >
              <p
                className={`text-sm font-semibold ${
                  photosCount === 0 ? "text-amber-900" : "text-gray-800"
                }`}
              >
                📸 {photosCount} photo{photosCount === 1 ? "" : "s"} uploaded for this clean
                {maintenancePhotosCount > 0
                  ? ` · 🛠 ${maintenancePhotosCount} maintenance`
                  : ""}
              </p>
              {photosCount === 0 && (
                <p className="text-amber-800 text-xs mt-1">
                  No photos uploaded yet. If you took photos, go to the Submit Photos tab and
                  upload them before finishing.
                </p>
              )}
            </div>

            {anyBusy && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
                <p className="text-yellow-900 text-sm font-medium">
                  {humanList(busyLabels)} {busyLabels.length > 1 ? "are" : "is"} still
                  saving — wait a moment before finishing.
                </p>
              </div>
            )}

            {!anyBusy && anyDirty && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                <p className="text-red-900 text-sm font-medium">
                  You have unsent {humanList(dirtyLabels)} work.
                </p>
                <p className="text-red-800 text-sm mt-1">
                  Tap <span className="font-semibold">Go Back</span> to review, or{" "}
                  <span className="font-semibold">Submit All</span> to send it now and finish.
                </p>
              </div>
            )}

            {submitAllError && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
                <p className="text-yellow-900 text-sm font-medium">{submitAllError}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setSubmitAllError(null);
                  setShowFinishModal(false);
                }}
                disabled={finishing || submittingAll}
                className="flex-1 bg-gray-200 text-gray-700 py-3 rounded-xl font-medium hover:bg-gray-300 transition-colors disabled:opacity-50"
              >
                Go Back
              </button>
              <button
                onClick={anyDirty ? handleSubmitAll : handleFinishClean}
                disabled={finishing || submittingAll || anyBusy}
                className={`flex-1 text-white py-3 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  anyDirty
                    ? "bg-blue-600 hover:bg-blue-700 active:bg-blue-800"
                    : "bg-green-600 hover:bg-green-700 active:bg-green-800"
                }`}
              >
                {submittingAll
                  ? "Submitting all..."
                  : finishing
                  ? "Finishing..."
                  : anyBusy
                  ? "Waiting on submissions..."
                  : anyDirty
                  ? "Submit All"
                  : "Yes, Finish Clean"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CleanPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
        </div>
      }
    >
      <CleanPageInner />
    </Suspense>
  );
}
