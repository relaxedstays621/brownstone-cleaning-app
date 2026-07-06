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
  // True when a confirmed mismatch can't auto-reload because clean work is BUSY
  // (uploads/writes in flight) — which, for a client stuck retrying failed
  // uploads, may never clear. Drives the assertive "tap to update" banner so the
  // cleaner has a manual escape instead of being trapped on old code.
  const [busyDeferred, setBusyDeferred] = useState(false);
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
      const w = window as Window & { __cleanGuardReload?: boolean; __cleanBusy?: boolean };
      const guarded = !!w.__cleanGuardReload;
      // Surface the manual escape when auto-reload is deferred specifically by
      // busy (in-flight/possibly-stuck uploads), not merely by unsaved-but-idle work.
      setBusyDeferred(guarded && !!w.__cleanBusy);
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
      {busyDeferred
        ? "A new version is available — tap to update."
        : "Update available — we’ll refresh automatically when your current work is saved."}{" "}
      <button
        onClick={() => {
          // Respect the same guard as the auto path: warn before discarding
          // unsaved/uploading work if the cleaner taps Refresh mid-clean.
          const guarded = !!(window as Window & { __cleanGuardReload?: boolean }).__cleanGuardReload;
          if (
            guarded &&
            !window.confirm("You have unsaved or uploading work that may be lost. Refresh anyway?")
          ) {
            return;
          }
          hardReload();
        }}
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
        {busyDeferred ? "Update now" : "Refresh now"}
      </button>
    </div>
  );
}
