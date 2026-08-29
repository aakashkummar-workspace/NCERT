"use client";

import { useEffect } from "react";

/**
 * Registers the offline worker. Kept out of the service worker file itself so
 * that public/sw.js stays plain JS served straight from the origin root, which
 * is what gives it scope over the whole app.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration fails on unsupported browsers and in private windows;
        // the app still works, just without offline support.
      });
    };

    /*
     * Registration is deferred to the load event so it never competes with the
     * first paint — but effects usually run *after* load has already fired, in
     * which case the listener would never trigger. Check readyState first.
     */
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
