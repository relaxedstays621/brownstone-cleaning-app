"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PROPERTIES } from "@/lib/properties";

export default function SelectPropertyPage() {
  const [property, setProperty] = useState("");
  const [loading, setLoading] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((data) => {
        if (!data.authenticated) router.replace("/");
        else setAuthChecked(true);
      });
  }, [router]);

  async function handleStart() {
    if (!property) return;
    setLoading(true);
    const res = await fetch("/api/start-clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ property }),
    });
    if (res.ok) {
      router.push(`/clean?property=${encodeURIComponent(property)}`);
    } else {
      setLoading(false);
      alert("Failed to start clean. Please try again.");
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
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-lg p-8">
          <h1 className="text-xl font-bold text-center mb-6">Select Property</h1>
          <select
            value={property}
            onChange={(e) => setProperty(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="">Choose a property...</option>
            {PROPERTIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            onClick={handleStart}
            disabled={!property || loading}
            className="w-full mt-4 bg-blue-600 text-white py-3 rounded-xl text-lg font-medium hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Starting..." : "Start Clean"}
          </button>
        </div>
      </div>
    </div>
  );
}
