"use client";

/**
 * Offline chapter storage on top of the Cache Storage API.
 *
 * Cache Storage (not IndexedDB) because these are large binary responses that
 * the service worker can serve straight back on a cache-first fetch, with no
 * copy through JS. Nothing here is precached: a ~600 MB corpus has to be
 * opt-in per chapter, so the student only ever downloads what they open.
 */
export const PDF_CACHE = "ncert-pdfs-v1";

export interface DownloadProgress {
  received: number;
  total: number;
}

/**
 * Ask the browser to make storage persistent so the OS doesn't silently evict
 * downloaded chapters under pressure. Best-effort: many browsers decide on
 * their own and simply return false.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isDownloaded(url: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(PDF_CACHE);
  return (await cache.match(url)) !== undefined;
}

/**
 * Download a chapter into the cache, reporting progress as bytes arrive.
 * Streams the body so a 17 MB chapter shows a moving bar rather than a hang.
 */
export async function downloadChapter(
  url: string,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const cache = await caches.open(PDF_CACHE);
  if (await cache.match(url)) return;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);

  const total = Number(res.headers.get("content-length") ?? 0);

  // Without a readable body or a known length there is nothing to report on;
  // fall back to storing the response as-is.
  if (!res.body || !total || !onProgress) {
    await cache.put(url, res);
    return;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress({ received, total });
  }

  const blob = new Blob(chunks as BlobPart[], { type: "application/pdf" });
  await cache.put(
    url,
    new Response(blob, {
      headers: { "content-type": "application/pdf", "content-length": String(received) },
    }),
  );
}

export async function deleteChapter(url: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(PDF_CACHE);
  return cache.delete(url);
}

/** Remove every cached chapter whose path sits under a book's directory. */
export async function deleteBook(code: string): Promise<number> {
  if (typeof caches === "undefined") return 0;
  const cache = await caches.open(PDF_CACHE);
  const keys = await cache.keys();
  let n = 0;
  for (const req of keys) {
    if (new URL(req.url).pathname.startsWith(`/ncert/${code}/`)) {
      if (await cache.delete(req)) n++;
    }
  }
  return n;
}

export interface CachedChapter {
  url: string;
  code: string;
  file: string;
  bytes: number;
}

/** Everything currently held offline, for the downloads manager. */
export async function listCached(): Promise<CachedChapter[]> {
  if (typeof caches === "undefined") return [];
  const cache = await caches.open(PDF_CACHE);
  const out: CachedChapter[] = [];
  for (const req of await cache.keys()) {
    const { pathname } = new URL(req.url);
    const m = /^\/ncert\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (!m) continue;
    const res = await cache.match(req);
    const len = Number(res?.headers.get("content-length") ?? 0);
    out.push({ url: req.url, code: m[1], file: m[2], bytes: len });
  }
  return out;
}

/** Browser-reported storage usage/quota, shown on the downloads screen. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
