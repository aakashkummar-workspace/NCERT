/*
 * Service worker for NCERT Quick.
 *
 * Written by hand rather than generated, because the caching rules here are
 * unusual: the app shell is small and should stay fresh, while the textbook
 * PDFs are ~509 MB in total and must NEVER be precached. Chapters enter
 * PDF_CACHE only when a student explicitly downloads one (see src/lib/offline.ts),
 * and this worker just serves whatever is already there.
 */

const SHELL_CACHE = "ncert-shell-v1";
// Must match PDF_CACHE in src/lib/offline.ts.
const PDF_CACHE = "ncert-pdfs-v1";
const KEEP = new Set([SHELL_CACHE, PDF_CACHE]);

self.addEventListener("install", (event) => {
  // The offline fallback is the only thing worth precaching up front.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Trailing slashes are load-bearing: `next start` with `trailingSlash`
      // answers "/offline" with a 308. `addAll` follows it and caches a
      // *redirected* response, which can never satisfy a navigation request —
      // the fallback below then throws instead of rendering. Cache the
      // canonical form.
      .then((cache) => cache.addAll(["/", "/offline/"]))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Chapter PDFs: cache-only-ish. Never added here implicitly. */
async function handlePdf(request) {
  const cached = await caches.match(request, { cacheName: PDF_CACHE });
  if (cached) return cached;
  try {
    // Not downloaded: stream it from the network without caching, so a student
    // who only wants to read once does not silently fill their storage.
    return await fetch(request);
  } catch {
    return new Response("Chapter not available offline.", {
      status: 504,
      headers: { "content-type": "text/plain" },
    });
  }
}

/** Navigations: network first, falling back to the cached shell when offline. */
async function handleNavigation(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return (
      (await caches.match(request, { cacheName: SHELL_CACHE })) ??
      (await caches.match("/offline/", { cacheName: SHELL_CACHE })) ??
      (await caches.match("/", { cacheName: SHELL_CACHE })) ??
      new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })
    );
  }
}

/** Build output and the pdf.js worker: stale-while-revalidate. */
async function handleAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? new Response("", { status: 504 });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/ncert/")) {
    event.respondWith(handlePdf(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (
    url.pathname.startsWith("/_next/") ||
    url.pathname === "/pdf.worker.min.mjs" ||
    /\.(css|js|mjs|svg|png|ico|webmanifest|woff2?)$/.test(url.pathname)
  ) {
    event.respondWith(handleAsset(request));
  }
});
