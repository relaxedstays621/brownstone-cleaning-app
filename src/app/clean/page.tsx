"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PhotosTab from "./PhotosTab";
import InventoryTab from "./InventoryTab";

function CleanPageInner() {
  const [activeTab, setActiveTab] = useState<"photos" | "inventory">("photos");
  const [authChecked, setAuthChecked] = useState(false);
  const [showFinishModal, setShowFinishModal] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const property = searchParams.get("property") || "";

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((data) => {
        if (!data.authenticated) router.replace("/");
        else if (!property) router.replace("/select-property");
        else setAuthChecked(true);
      });
  }, [router, property]);

  async function handleFinishClean() {
    setFinishing(true);
    try {
      const res = await fetch("/api/finish-clean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property }),
      });
      if (!res.ok) throw new Error("Failed");
      router.push("/select-property");
    } catch {
      alert("Failed to finish clean. Please try again.");
      setFinishing(false);
      setShowFinishModal(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

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

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-lg mx-auto flex">
          <button
            onClick={() => setActiveTab("photos")}
            className={`flex-1 py-3 text-center font-medium text-sm transition-colors ${
              activeTab === "photos"
                ? "text-blue-600 border-b-2 border-blue-600"
                : "text-gray-500"
            }`}
          >
            Submit Photos
          </button>
          <button
            onClick={() => setActiveTab("inventory")}
            className={`flex-1 py-3 text-center font-medium text-sm transition-colors ${
              activeTab === "inventory"
                ? "text-blue-600 border-b-2 border-blue-600"
                : "text-gray-500"
            }`}
          >
            Report Inventory
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-lg mx-auto p-4">
        {activeTab === "photos" ? (
          <PhotosTab property={property} />
        ) : (
          <InventoryTab property={property} />
        )}
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
            <p className="text-gray-600 mb-6">
              Have you submitted all photos and logged all inventory requests?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowFinishModal(false)}
                disabled={finishing}
                className="flex-1 bg-gray-200 text-gray-700 py-3 rounded-xl font-medium hover:bg-gray-300 transition-colors"
              >
                Go Back
              </button>
              <button
                onClick={handleFinishClean}
                disabled={finishing}
                className="flex-1 bg-green-600 text-white py-3 rounded-xl font-medium hover:bg-green-700 active:bg-green-800 transition-colors disabled:opacity-50"
              >
                {finishing ? "Finishing..." : "Yes, Finish Clean"}
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
