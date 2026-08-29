"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { recentlyRead, type Progress } from "@/lib/reading-state";
import { getBook, getChapter } from "@/lib/manifest";

/**
 * Resume card on the home screen. Renders nothing until IndexedDB has been
 * read, so a first-time visitor never sees an empty placeholder flash.
 */
export default function ContinueReading() {
  const [items, setItems] = useState<Progress[] | null>(null);

  useEffect(() => {
    recentlyRead(3)
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">
        Continue reading
      </h2>
      <ul className="space-y-2">
        {items.map((p) => {
          const book = getBook(p.code);
          const chapter = getChapter(p.code, p.chapter);
          if (!book || !chapter) return null;
          const pct = p.pageCount ? Math.round((p.page / p.pageCount) * 100) : 0;
          return (
            <li key={p.key}>
              <Link
                href={`/read/${p.code}/${p.chapter}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{chapter.title}</p>
                  <p className="truncate text-xs text-ink-faint">
                    Class {book.class} · {book.subject} · {book.title}
                  </p>
                  <div
                    className="mt-2 h-1 overflow-hidden rounded-full bg-surface-alt"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Reading progress"
                  >
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-ink-faint">{pct}%</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
