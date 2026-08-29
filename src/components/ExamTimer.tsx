"use client";

import { useEffect, useRef, useState } from "react";
import { formatClock, remainingMs } from "@/lib/attempts";

/**
 * The exam clock.
 *
 * Every reading is recomputed from `Date.now()` against the attempt's
 * `startedAt`, never accumulated from ticks. A three-hour paper is three hours
 * of a phone locking, a tab going to the background and an interval being
 * throttled to once a minute or stopped outright — a counter that subtracts a
 * second per tick would end up wildly ahead of the wall clock. Deriving from
 * wall time means a dropped tick costs nothing but a stale reading, which the
 * visibility and focus listeners immediately correct.
 */

/** Fifteen minutes: the point where CBSE invigilators call the first warning. */
const WARN_MS = 15 * 60 * 1000;

export default function ExamTimer({
  startedAt,
  durationMs,
  onExpire,
}: {
  startedAt: number;
  durationMs: number;
  onExpire: () => void;
}) {
  const [ms, setMs] = useState(() => remainingMs({ startedAt, durationMs }));
  const expireRef = useRef(onExpire);
  const firedRef = useRef(false);

  useEffect(() => {
    expireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    firedRef.current = false;

    function sync() {
      const left = remainingMs({ startedAt, durationMs });
      setMs(left);
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true;
        expireRef.current();
      }
    }

    sync();
    const id = window.setInterval(sync, 1000);
    // A backgrounded tab's interval is throttled hard, so re-read the moment the
    // page comes back rather than waiting for the next tick to land.
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("pageshow", sync);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, [startedAt, durationMs]);

  const warning = ms > 0 && ms <= WARN_MS;
  const elapsed = durationMs > 0 ? Math.min(100, ((durationMs - ms) / durationMs) * 100) : 100;

  return (
    <div
      className={`border-b px-4 py-2.5 backdrop-blur ${
        warning ? "border-accent/40 bg-accent-soft/90" : "border-border bg-paper/90"
      }`}
    >
      <div className="mx-auto flex max-w-3xl items-baseline gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
          {ms > 0 ? "Time left" : "Time up"}
        </span>
        <span
          role="timer"
          aria-label={`${formatClock(ms)} remaining`}
          className={`text-lg font-semibold tabular-nums ${warning ? "text-accent" : "text-ink"}`}
        >
          {formatClock(ms)}
        </span>
        {warning && (
          <span className="text-xs text-accent">Last {Math.ceil(ms / 60000)} min</span>
        )}
      </div>
      <div className="mx-auto mt-2 h-1 max-w-3xl overflow-hidden rounded-full bg-surface-alt">
        <div
          className={`h-full rounded-full ${warning ? "bg-accent" : "bg-ink-faint"}`}
          style={{ width: `${elapsed}%` }}
        />
      </div>
    </div>
  );
}
