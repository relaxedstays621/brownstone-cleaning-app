"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

const IDLE_MS = 30 * 60 * 1000; // 30 min

// Client-side idle logout. The absolute 16h cap is enforced server-side in
// isAuthenticated(); this is the short idle timer. Active only on authed pages
// (the login page is "/"), and never logs out mid-upload.
export default function SessionTimeout() {
  const pathname = usePathname();
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pathname === "/") return; // login page → not authed, nothing to time out

    let done = false;

    const logout = async () => {
      if (done) return;
      // Never log out while an upload is in flight — defer one more cycle.
      if ((window as Window & { __cleanBusy?: boolean }).__cleanBusy) {
        schedule();
        return;
      }
      done = true;
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        /* ignore — redirect anyway */
      }
      router.replace("/");
    };

    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(logout, IDLE_MS);
    };

    const onActivity = () => schedule();
    const events = ["mousedown", "keydown", "touchstart", "pointerdown", "scroll", "visibilitychange"];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    schedule();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      events.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, [pathname, router]);

  return null;
}
