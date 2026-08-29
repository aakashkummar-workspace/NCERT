"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import PdfPage from "@/components/PdfPage";

type Status = "loading" | "ready" | "error";

const NIGHT_KEY = "ncert-quick:night";

const MIN_SCALE = 0.6;
const MAX_SCALE = 2;
const STEP = 0.2;

/*
 * Same key and same guarded read as PdfReader: a paper should look like the
 * rest of the app, so it follows the reader's night preference. There is no
 * toggle here — the reader owns that setting.
 */
async function readNightMode(): Promise<boolean> {
  try {
    return window.localStorage.getItem(NIGHT_KEY) === "1";
  } catch {
    return false;
  }
}

interface Props {
  url: string;
  /** what this document is, for the toolbar and the error message */
  label: string;
  onPageCount?: (n: number) => void;
  /** the caller sets the box: height, width, rounding of the outer frame */
  className?: string;
}

/**
 * A scrolling PDF surface for exam papers.
 *
 * Deliberately not PdfReader: that component carries reading progress,
 * bookmarks, in-chapter search, chapter navigation and the offline download,
 * none of which belong to a timed paper. What is left is pages, zoom and a
 * position readout, reusing PdfPage so page virtualisation and device-pixel
 * handling stay in one place.
 *
 * It renders at two very different widths — full bleed while the paper is
 * being attempted, and half a column beside the scoring grid afterwards — so
 * it carries no width of its own. PdfPage already caps a page at `scale * 612`
 * CSS pixels while letting it shrink to 100% of whatever holds it, and the
 * scroll lives on the inner div, so a short frame scrolls internally instead
 * of pushing the page layout out.
 */
export default function PaperViewer({ url, label, onPageCount, className }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [aspect, setAspect] = useState(1.414); // A4 until page 1 reports otherwise
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [night, setNight] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Held in a ref so an inline callback from the caller cannot re-trigger the load.
  const pageCountRef = useRef(onPageCount);
  useEffect(() => {
    pageCountRef.current = onPageCount;
  }, [onPageCount]);

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
        pageCountRef.current?.(doc.numPages);
      } catch (err) {
        if (cancelled) return;
        const offline = typeof navigator !== "undefined" && !navigator.onLine;
        setError(
          offline
            ? `You are offline and the ${label} has not been downloaded yet.`
            : `Could not open the ${label}. ${(err as Error).message}`,
        );
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [url, label]);

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

  const onVisible = useCallback((n: number) => setPage(n), []);

  /*
   * PdfPage reports a page once it covers half the *viewport*. In a short
   * frame a tall page may never manage that, so when this box is the scroller
   * the position comes from the topmost page still on screen instead.
   */
  const onScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    for (const el of box.querySelectorAll<HTMLElement>("[data-page]")) {
      if (el.getBoundingClientRect().bottom > top + 8) {
        setPage(Number(el.dataset.page));
        return;
      }
    }
  }, []);

  const zoom = (by: number) =>
    setScale((s) => +Math.min(MAX_SCALE, Math.max(MIN_SCALE, s + by)).toFixed(2));

  return (
    <div
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface ${className ?? ""}`}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-paper px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-soft">{label}</span>

        <button
          type="button"
          onClick={() => zoom(-STEP)}
          disabled={status !== "ready" || scale <= MIN_SCALE}
          aria-label={`Zoom out of the ${label}`}
          className="rounded-lg border border-border px-2 py-1 text-sm leading-none disabled:opacity-40"
        >
          −
        </button>
        <span className="text-xs tabular-nums text-ink-faint">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          onClick={() => zoom(STEP)}
          disabled={status !== "ready" || scale >= MAX_SCALE}
          aria-label={`Zoom into the ${label}`}
          className="rounded-lg border border-border px-2 py-1 text-sm leading-none disabled:opacity-40"
        >
          +
        </button>

        <span className="text-xs tabular-nums text-ink-faint" aria-live="polite">
          {pageCount ? `${page} / ${pageCount}` : "—"}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface-alt px-2 py-3"
      >
        {status === "loading" && (
          <p className="py-16 text-center text-sm text-ink-faint">Loading {label}…</p>
        )}

        {status === "error" && (
          <div className="mx-auto max-w-xs px-2 py-16 text-center">
            <p className="text-sm text-ink-soft">{error}</p>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-sm text-accent underline underline-offset-4"
            >
              Open the PDF directly
            </a>
          </div>
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
    </div>
  );
}
