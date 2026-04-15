"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PhotosTab from "./PhotosTab";
import InventoryTab from "./InventoryTab";

function CleanPageInner() {
  const [activeTab, setActiveTab] = useState<"photos" | "inventory">("photos");
  const [authChecked, setAuthChecked] = useState(false);
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

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
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
