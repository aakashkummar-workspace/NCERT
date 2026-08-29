"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import PdfPage from "@/components/PdfPage";
import { bookmarksFor, getProgress, saveProgress, toggleBookmark } from "@/lib/reading-state";
import { isDownloaded, downloadChapter, requestPersistence } from "@/lib/offline";

type Status = "loading" | "ready" | "error";
/** Which secondary panel, if any, is expanded above the toolbar. */
type Panel = null | "search" | "tools";

const NIGHT_KEY = "ncert-quick:night";

/*
 * Night mode lives in localStorage rather than IndexedDB: it is one boolean that
 * must be known before the first page paints, and `localStorage` throws outright
 * in some private-window configurations, so every access is guarded.
 *
 * Both helpers are async and module-level on purpose. The preference can only be
 * read on the client (the export is prerendered), and reading it from a promise
 * callback keeps state out of the effect body itself.
 */
async function readNightMode(): Promise<boolean> {
  try {
    return window.localStorage.getItem(NIGHT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeNightMode(on: boolean): void {
  try {
    window.localStorage.setItem(NIGHT_KEY, on ? "1" : "0");
  } catch {
    // Storage denied or full; the toggle still works for this session.
  }
}

/*
 * One size for every tap target. 44px (size-11) is the smallest comfortable
 * thumb target, and this screen is used one-handed on cheap phones, so nothing
 * here is allowed to be smaller: the icon inside may be 18px, the hit area
 * never is.
 */
const CTL = "grid size-11 shrink-0 place-items-center rounded-xl border transition-colors";
const CTL_IDLE = `${CTL} border-border text-ink-soft`;
const CTL_ON = `${CTL} border-accent bg-accent-soft text-accent`;

interface Props {
  url: string;
  code: string;
  chapter: number;
  officialUrl: string;
  prevHref?: string;
  nextHref?: string;
}

export default function PdfReader({ url, code, chapter, officialUrl, prevHref, nextHref }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string>("");
  const [pageCount, setPageCount] = useState(0);
  const [aspect, setAspect] = useState(1.414); // A4 until page 1 reports otherwise
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [cached, setCached] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState("");
  const [night, setNight] = useState(false);
  const [bookmarkedPages, setBookmarkedPages] = useState<ReadonlySet<number>>(new Set());
  // Bumped after a toggle to re-read this chapter's bookmarks.
  const [bookmarkToken, setBookmarkToken] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [chromeHidden, setChromeHidden] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoredRef = useRef(false);
  // Read by the scroll listener, which is registered once and so must not read
  // state directly.
  const panelRef = useRef<Panel>(null);
  const lastYRef = useRef(0);
  // Programmatic scrolls (resume, search hit) must not be mistaken for the
  // reader scrolling down, or the toolbar would vanish the moment we jump.
  const ignoreScrollUntilRef = useRef(0);

  const revealChrome = useCallback(() => setChromeHidden(false), []);

  const openPanel = useCallback((next: Panel) => {
    panelRef.current = next;
    setPanel(next);
    setChromeHidden(false);
  }, []);

  const scrollToPage = useCallback((n: number) => {
    const el = containerRef.current?.querySelector(`[data-page="${n}"]`);
    if (!el) return;
    ignoreScrollUntilRef.current = Date.now() + 900;
    el.scrollIntoView({ block: "start" });
    setChromeHidden(false);
  }, []);

  /*
   * Auto-hiding chrome. Scrolling down gives the page back to the page; almost
   * anything else brings the toolbar straight back — scrolling up by a few
   * pixels, tapping the sheet, reaching the end of the chapter, opening a
   * panel, or the document finishing its load. There is deliberately no state
   * in which the controls cannot be recovered.
   */
  useEffect(() => {
    lastYRef.current = window.scrollY;

    function onScroll() {
      const y = window.scrollY;
      if (Date.now() < ignoreScrollUntilRef.current) {
        lastYRef.current = y;
        return;
      }
      const dy = y - lastYRef.current;
      if (Math.abs(dy) < 6) return; // ignore jitter and rubber-banding
      lastYRef.current = y;
      if (panelRef.current) return; // never pull a panel out from under a tap
      /*
       * "Near the end" is measured a whole viewport early on purpose. Pages
       * rasterise as they approach, so `scrollHeight` grows underneath the
       * reader and an exact bottom test would keep missing; a viewport of slack
       * both absorbs that and puts the next-chapter arrow back on screen just
       * as it is wanted.
       */
      const nearEnd = y + window.innerHeight * 2 >= document.documentElement.scrollHeight;
      if (dy < 0 || y <= 96 || nearEnd) {
        setChromeHidden(false);
        return;
      }
      // Only a deliberate downward scroll hides the bar. Small positive deltas
      // are usually a page settling into its real height, not a gesture.
      if (dy > 12) setChromeHidden(true);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Load the document. pdf.js is imported lazily so it never runs during SSR.
  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | undefined;

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        doc = await pdfjs.getDocument({ url }).promise;
        if (cancelled) return;

        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (cancelled) return;

        setAspect(vp.height / vp.width);
        setPageCount(doc.numPages);
        setPdf(doc);
        setStatus("ready");
        // A finished load always shows the controls, whatever the reader did
        // while waiting.
        setChromeHidden(false);
      } catch (err) {
        if (cancelled) return;
        // Offline with nothing cached is the common case here, so say so plainly.
        const offline = typeof navigator !== "undefined" && !navigator.onLine;
        setError(
          offline
            ? "You are offline and this chapter has not been downloaded yet."
            : `Could not open this chapter. ${(err as Error).message}`,
        );
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [url]);

  useEffect(() => {
    isDownloaded(url)
      .then(setCached)
      .catch(() => setCached(false));
  }, [url]);

  useEffect(() => {
    let live = true;
    readNightMode()
      .then((on) => {
        if (live) setNight(on);
      })
      .catch(() => {
        if (live) setNight(false);
      });
    return () => {
      live = false;
    };
  }, []);

  // Which pages of this chapter are bookmarked, so the toolbar can show the
  // state of whichever page is currently on screen.
  useEffect(() => {
    let live = true;
    bookmarksFor(code, chapter)
      .then((list) => {
        if (live) setBookmarkedPages(new Set(list.map((b) => b.page)));
      })
      .catch(() => {
        if (live) setBookmarkedPages(new Set());
      });
    return () => {
      live = false;
    };
  }, [code, chapter, bookmarkToken]);

  // Restore the last read page once the document is ready.
  useEffect(() => {
    if (status !== "ready" || restoredRef.current) return;
    restoredRef.current = true;
    void getProgress(code, chapter).then((p) => {
      if (p && p.page > 1) scrollToPage(p.page);
    });
  }, [status, code, chapter, scrollToPage]);

  // Persist progress, debounced so scrolling does not hammer IndexedDB.
  useEffect(() => {
    if (status !== "ready" || !pageCount) return;
    const t = setTimeout(() => {
      void saveProgress(code, chapter, page, pageCount);
    }, 700);
    return () => clearTimeout(t);
  }, [page, pageCount, code, chapter, status]);

  const onVisible = useCallback((n: number) => setPage(n), []);

  function onToggleSearch() {
    if (panel === "search") {
      openPanel(null);
      setSearchMsg("");
      return;
    }
    openPanel("search");
    // The input only exists once the panel has rendered.
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!pdf || !query.trim()) return;
    setSearching(true);
    setSearchMsg("");
    const needle = query.trim().toLowerCase();
    try {
      // Page-level search: find the first page containing the term and jump to it.
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await pdf.getPage(i).then((p) => p.getTextContent());
        const text = content.items
          .map((it) => ("str" in it ? it.str : ""))
          .join(" ")
          .toLowerCase();
        if (text.includes(needle)) {
          scrollToPage(i);
          setSearchMsg(`Found on page ${i}`);
          return;
        }
      }
      setSearchMsg("Not found in this chapter");
    } finally {
      setSearching(false);
    }
  }

  async function onToggleBookmark() {
    await toggleBookmark(code, chapter, page);
    setBookmarkToken((t) => t + 1);
  }

  function onToggleNight() {
    const next = !night;
    setNight(next);
    writeNightMode(next);
  }

  async function onDownload() {
    if (cached) return;
    await requestPersistence();
    await downloadChapter(url);
    setCached(true);
  }

  const bookmarked = bookmarkedPages.has(page);
  const searchOpen = panel === "search";
  const toolsOpen = panel === "tools";

  if (status === "error") {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="text-sm text-ink-soft">{error}</p>
        <a
          href={officialUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block text-sm text-accent underline underline-offset-4"
        >
          Open the official NCERT PDF
        </a>
      </div>
    );
  }

  return (
    <>
      {/* Tapping the sheet is the other half of the auto-hide contract: it is a
          gesture the reader already makes, and it always brings the bar back. */}
      <div
        ref={containerRef}
        onClick={revealChrome}
        className="flex-1 bg-surface-alt px-2 py-3 pb-16"
      >
        {status === "loading" && (
          <p className="py-16 text-center text-sm text-ink-faint">Loading chapter…</p>
        )}
        {pdf &&
          Array.from({ length: pageCount }, (_, i) => (
            <PdfPage
              key={i + 1}
              pdf={pdf}
              pageNumber={i + 1}
              scale={scale}
              aspect={aspect}
              night={night}
              onVisible={onVisible}
            />
          ))}
      </div>

      {/* One row of chrome instead of two, and none at all while the reader is
          moving down the chapter. Search and the view settings are the rarely
          used half, so they collapse to icons and expand over the page only
          while they are actually in use. */}
      <div
        className={`fixed inset-x-0 bottom-0 z-30 border-t border-border bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur transition-transform duration-200 ${
          chromeHidden ? "translate-y-full" : "translate-y-0"
        }`}
      >
        <div className="mx-auto max-w-3xl px-2">
          {searchOpen && (
            <form onSubmit={onSearch} className="flex items-center gap-2 pt-2">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search in this chapter"
                aria-label="Search in this chapter"
                className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={searching || !pdf}
                className="h-11 shrink-0 rounded-xl border border-border px-4 text-sm text-ink-soft disabled:opacity-50"
              >
                {searching ? "…" : "Find"}
              </button>
            </form>
          )}
          {searchOpen && searchMsg && <p className="pt-1 text-xs text-ink-faint">{searchMsg}</p>}

          {toolsOpen && (
            <div className="flex items-center gap-1 pt-2">
              <span className="px-1 text-xs text-ink-faint">Zoom</span>
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(0.5, +(s - 0.25).toFixed(2)))}
                aria-label="Zoom out"
                className={`${CTL_IDLE} text-lg leading-none`}
              >
                &minus;
              </button>
              <button
                type="button"
                onClick={() => setScale(1)}
                aria-label="Reset zoom to 100 percent"
                className="h-11 min-w-[3.5rem] shrink-0 rounded-xl border border-border px-2 text-xs tabular-nums text-ink-soft"
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(3, +(s + 0.25).toFixed(2)))}
                aria-label="Zoom in"
                className={`${CTL_IDLE} text-lg leading-none`}
              >
                +
              </button>

              <span className="flex-1" />

              <button
                type="button"
                onClick={onToggleNight}
                aria-pressed={night}
                aria-label={night ? "Turn off night reading mode" : "Turn on night reading mode"}
                className={night ? CTL_ON : CTL_IDLE}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"
                    fill={night ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          )}

          <div className="flex items-center gap-1 py-1">
            {prevHref ? (
              <Link href={prevHref} aria-label="Previous chapter" className={CTL_IDLE}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M15 18l-6-6 6-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            ) : (
              <span className={`${CTL_IDLE} opacity-30`} aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M15 18l-6-6 6-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            )}

            <button
              type="button"
              onClick={onToggleSearch}
              aria-expanded={searchOpen}
              aria-label={searchOpen ? "Close search" : "Open search"}
              className={searchOpen ? CTL_ON : CTL_IDLE}
            >
              {searchOpen ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="2" />
                  <path
                    d="M19.5 19.5L15.6 15.6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>

            <button
              type="button"
              onClick={onToggleBookmark}
              aria-pressed={bookmarked}
              aria-label={bookmarked ? `Remove bookmark on page ${page}` : `Bookmark page ${page}`}
              className={bookmarked ? CTL_ON : CTL_IDLE}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M6 4h12v16l-6-4-6 4V4z"
                  fill={bookmarked ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {/* The place-marker students navigate by, so it never collapses
                into a menu. */}
            <span className="min-w-0 flex-1 truncate text-center text-xs tabular-nums text-ink-faint">
              {pageCount ? `${page} / ${pageCount}` : "—"}
            </span>

            <button
              type="button"
              onClick={() => openPanel(toolsOpen ? null : "tools")}
              aria-expanded={toolsOpen}
              aria-label={toolsOpen ? "Hide zoom and night mode" : "Show zoom and night mode"}
              className={toolsOpen ? CTL_ON : CTL_IDLE}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 8h6M16 8h4M4 16h4M14 16h6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle cx="13" cy="8" r="2.5" stroke="currentColor" strokeWidth="2" />
                <circle cx="11" cy="16" r="2.5" stroke="currentColor" strokeWidth="2" />
              </svg>
            </button>

            <button
              type="button"
              onClick={onDownload}
              className="h-11 shrink-0 rounded-xl border border-border px-3 text-xs text-ink-soft"
              aria-label={cached ? "Saved for offline reading" : "Save for offline reading"}
            >
              {cached ? "Saved" : "Save"}
            </button>

            {nextHref ? (
              <Link href={nextHref} aria-label="Next chapter" className={CTL_IDLE}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M9 18l6-6-6-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            ) : (
              <span className={`${CTL_IDLE} opacity-30`} aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M9 18l6-6-6-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
