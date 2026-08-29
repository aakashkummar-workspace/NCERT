"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * One page of the document.
 *
 * Chapters run to ~17 MB and 40+ pages, so a page only rasterises once it is
 * near the viewport and releases its canvas when it scrolls far away. The
 * placeholder keeps its height either way, so the scrollbar never jumps.
 */
export default function PdfPage({
  pdf,
  pageNumber,
  scale,
  aspect,
  night,
  onVisible,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** height / width of page 1, used to size the placeholder before render */
  aspect: number;
  /** invert the sheet for night reading; see `.night-page` in globals.css */
  night: boolean;
  onVisible: (pageNumber: number) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  // Track whether this page is close enough to bother rendering.
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setNear(true);
            // Report the page that occupies most of the screen.
            if (e.intersectionRatio > 0.5) onVisible(pageNumber);
          } else if (e.boundingClientRect.top > window.innerHeight * 3) {
            setNear(false);
          }
        }
      },
      { rootMargin: "150% 0px", threshold: [0, 0.5] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pageNumber, onVisible]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void } | undefined;

    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Render at device pixel ratio so text stays crisp on phone screens,
      // but cap it — a 3x canvas of an A4 page at high zoom exhausts memory.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

      task = page.render({ canvasContext: ctx, viewport });
      try {
        await (task as unknown as { promise: Promise<void> }).promise;
      } catch {
        // Cancelled by a zoom change or unmount; nothing to report.
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, pdf, pageNumber, scale]);

  return (
    <div
      ref={holderRef}
      data-page={pageNumber}
      className={`mx-auto mb-3 bg-white shadow-sm${night ? " night-page" : ""}`}
      style={{ width: "100%", maxWidth: `${scale * 612}px`, aspectRatio: near ? undefined : `1 / ${aspect}` }}
    >
      {near ? (
        <canvas ref={canvasRef} className="block h-auto w-full" aria-label={`Page ${pageNumber}`} />
      ) : (
        <div className="grid h-full w-full place-items-center text-xs text-ink-faint" style={{ aspectRatio: `1 / ${aspect}` }}>
          {pageNumber}
        </div>
      )}
    </div>
  );
}
