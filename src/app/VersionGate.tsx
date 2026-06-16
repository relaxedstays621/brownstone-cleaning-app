"use client";

import { useEffect, useRef, useState } from "react";

// Baked into the client bundle at build (NEXT_PUBLIC_APP_VERSION = git short SHA).
// Empty when the build-arg wasn't passed → the gate is a no-op.
const CLIENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

// Don't loop-reload if a stubborn cache keeps serving old code: throttle to one
// reload per window across reloads.
function recentlyReloaded(): boolean {
  try {
    return Date.now() - Number(sessionStorage.getItem("vg_reload") || 0) < 20_000;
  } catch {
    return false;
  }
}
function markReloaded() {
  try {
    sessionStorage.setItem("vg_reload", String(Date.now()));
  } catch {
    /* ignore */
  }
}

function hardReload() {
  // Best-effort cache clear + SW unregister so a future PWA/SW can't pin old code.
  try {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((rs) => rs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
    if (typeof caches !== "undefined") {
      caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  markReloaded();
  window.location.reload();
}

export default function VersionGate() {
  const [mismatch, setMismatch] = useState(false);
  const reloadedRef = useRef(false);

  async function check() {
    if (!CLIENT_VERSION) return; // gate off when not built with a version
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return; // failed fetch (weak signal) must never act
      const data = await res.json();
      const server = data?.version;
      if (!server) return; // server has no version → no-op
      if (server !== CLIENT_VERSION) setMismatch(true);
    } catch {
      /* network blip → never act, only a confirmed mismatch acts */
    }
  }

  // Poll: on mount, on tab becoming visible, on window focus, and every ~60s.
  useEffect(() => {
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const iv = setInterval(check, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);

  // Once a mismatch is confirmed, reload as soon as it's safe (no dirty/in-flight
  // clean work — the clean page sets window.__cleanGuardReload). Until then, show
  // the banner and keep retrying.
  useEffect(() => {
    if (!mismatch) return;
    const tryReload = () => {
      if (reloadedRef.current) return;
      const guarded = !!(window as Window & { __cleanGuardReload?: boolean }).__cleanGuardReload;
      if (!guarded && !recentlyReloaded()) {
        reloadedRef.current = true;
        hardReload();
      }
    };
    tryReload();
    const iv = setInterval(tryReload, 3_000);
    return () => clearInterval(iv);
  }, [mismatch]);

  if (!mismatch) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: "#2563eb",
        color: "#fff",
        padding: "8px 12px",
        textAlign: "center",
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      Update available — we&apos;ll refresh automatically when your current work is saved.{" "}
      <button
        onClick={() => hardReload()}
        style={{
          marginLeft: 8,
          textDecoration: "underline",
          background: "none",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          font: "inherit",
        }}
      >
        Refresh now
      </button>
    </div>
  );
}
