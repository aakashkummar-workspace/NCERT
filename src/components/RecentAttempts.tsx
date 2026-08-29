"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { recentAttempts, type Attempt } from "@/lib/attempts";

/**
 * The last few papers sat, at the top of /practice.
 *
 * Renders nothing at all until IndexedDB has been read and only if there is
 * something to show: a student who has never practised should see the paper
 * list, not an empty box telling them so.
 */

// Formatted on the client only — this component returns null on the server
// render, so there is no locale mismatch to hydrate.
const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

export default function RecentAttempts() {
  const [items, setItems] = useState<Attempt[] | null>(null);

  useEffect(() => {
    recentAttempts(5)
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">
        Recent attempts
      </h2>
      <ul className="space-y-2">
        {items.map((a) => {
          const total = a.status === "submitted" ? a.totalScore : undefined;
          const pct =
            total === undefined || !a.maxMarks ? 0 : Math.round((total / a.maxMarks) * 100);
          return (
            <li key={a.id}>
              <Link
                href={`/practice/${a.paperSlug}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.subject}</p>
                  <p className="text-xs text-ink-faint">{DATE.format(a.startedAt)}</p>
                </div>
                {total !== undefined ? (
                  <span className="shrink-0 text-right text-xs tabular-nums">
                    <span className="font-medium">
                      {total}/{a.maxMarks}
                    </span>
                    <span className="text-ink-faint"> · {pct}%</span>
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-accent">in progress — resume</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
