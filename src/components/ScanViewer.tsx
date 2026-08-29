"use client";

import { useEffect, useRef, useState } from "react";
import { pageUrl, type PyqPage } from "@/lib/pyqs";

/**
 * Viewer for a question paper that exists only as page-image scans.
 *
 * Deliberately not built on pdf.js: these papers have no text layer at all, so
 * there is nothing to render from — just WebP images. The virtualisation idea is
 * borrowed from PdfPage.tsx though, because the problem is the same. A paper can
 * run to 19 pages at ~90 KB each, and a student on metered mobile data must not
 * pay for pages they never scroll to.
 */

const NIGHT_KEY = "ncert-quick:night";

/** Matches PdfReader's guarded read; localStorage throws in some private windows. */
async function readNightMode(): Promise<boolean> {
  try {
    return window.localStorage.getItem(NIGHT_KEY) === "1";
  } catch {
    return false;
  }
}

const MIN_SCALE = 0.6;
const MAX_SCALE = 2;

/** A4 at the aspect these scans use; holds the box before an image loads. */
const PLACEHOLDER_ASPECT = 1.414;

function Page({
  page,
  index,
  label,
  scale,
  night,
  onVisible,
}: {
  page: PyqPage;
  index: number;
  label: string;
  scale: number;
  night: boolean;
  onVisible: (n: number) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(index === 0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setNear(true);
            if (e.intersectionRatio > 0.5) onVisible(index + 1);
          }
        }
      },
      { rootMargin: "600px 0px", threshold: [0, 0.51] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [index, onVisible]);

  return (
    <div
      ref={holderRef}
      data-page={index + 1}
      className="mx-auto mb-3 w-full"
      style={{ maxWidth: `${scale * 800}px` }}
    >
      {near && !failed ? (
        <img
          src={pageUrl(page)}
          alt={`${label} — page ${index + 1}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className={`block w-full bg-white shadow-sm${night ? " night-page" : ""}`}
        />
      ) : (
        <div
          className="flex w-full items-center justify-center rounded-lg border border-dashed border-border bg-surface-alt text-xs text-ink-faint"
          style={{ aspectRatio: `1 / ${PLACEHOLDER_ASPECT}` }}
        >
          {failed ? `Page ${index + 1} did not download` : `Page ${index + 1}`}
        </div>
      )}
    </div>
  );
}

export default function ScanViewer({
  pages,
  label,
  className = "",
}: {
  pages: PyqPage[];
  label: string;
  className?: string;
}) {
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [night, setNight] = useState(false);

  useEffect(() => {
    let live = true;
    readNightMode().then((on) => {
      if (live) setNight(on);
    });
    return () => {
      live = false;
    };
  }, []);

  if (pages.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-ink-soft">
        This paper has no pages on disk yet.
      </div>
    );
  }

  return (
    // `min-w-0` is what lets this shrink inside a flex or grid column instead of
    // forcing its content width; the caller sizes the frame through className.
    <div className={`flex min-w-0 flex-col overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-paper/90 px-3 py-2 backdrop-blur">
        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{label}</span>
        <span className="text-xs tabular-nums text-ink-soft" aria-live="polite">
          {page} / {pages.length}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(MIN_SCALE, Math.round((s - 0.2) * 10) / 10))}
            disabled={scale <= MIN_SCALE}
            aria-label="Zoom out"
            className="grid size-11 place-items-center rounded-lg border border-border text-ink-soft transition-colors hover:text-ink disabled:opacity-40"
          >
            −
          </button>
          <span className="w-11 text-center text-xs tabular-nums text-ink-faint">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(MAX_SCALE, Math.round((s + 0.2) * 10) / 10))}
            disabled={scale >= MAX_SCALE}
            aria-label="Zoom in"
            className="grid size-11 place-items-center rounded-lg border border-border text-ink-soft transition-colors hover:text-ink disabled:opacity-40"
          >
            +
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface-alt p-3">
        {pages.map((p, i) => (
          <Page
            key={p.file}
            page={p}
            index={i}
            label={label}
            scale={scale}
            night={night}
            onVisible={setPage}
          />
        ))}
      </div>
    </div>
  );
}
