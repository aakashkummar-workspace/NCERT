"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import GradingCanvas, { type CanvasPayload } from "@/components/GradingCanvas";

/**
 * /evaluate/{ticketId} — the grading canvas.
 *
 * This page opens a review as soon as it loads, because a canvas open on a
 * ticket with no review row is an evaluator whose time nobody is recording and
 * whose marks have nothing to hang off. The POST is idempotent in practice: it
 * reuses an unsubmitted pass under a row lock, so a second tab does not open a
 * second pass.
 *
 * The layout is the same for every evaluator type — see `GradingCanvas`. When
 * the lease is not this user's the same screen renders read-only rather than a
 * different screen rendering less.
 */
export default function EvaluateTicketPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = use(params);
  const router = useRouter();
  const [payload, setPayload] = useState<CanvasPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * `stillWanted` lets a caller inside an effect drop a response that arrived
   * after unmount rather than setting state into a component that has gone.
   */
  const load = useCallback(
    async (stillWanted: () => boolean = () => true) => {
      try {
        const res = await fetch(`/api/tickets/${ticketId}/`, { cache: "no-store" });
        const json = await res.json();
        if (!stillWanted()) return null;
        if (!res.ok) throw new Error(json?.error?.message ?? "Could not open this ticket.");
        setPayload(json as CanvasPayload);
        setError(null);
        return json as CanvasPayload;
      } catch (err) {
        if (!stillWanted()) return null;
        setError(err instanceof Error ? err.message : "Could not open this ticket.");
        return null;
      }
    },
    [ticketId],
  );

  useEffect(() => {
    // `live` is not ceremony. This page's audience is on a connection where a
    // fetch resolving after the evaluator has navigated away is routine, and a
    // claim landing in an unmounted canvas is how a ticket ends up leased to
    // somebody who is no longer looking at it.
    let live = true;
    void (async () => {
      const first = await load(() => live);
      if (!live || !first || first.review || !first.permissions.canGrade) return;
      const res = await fetch("/api/reviews/", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `review:${ticketId}` },
        body: JSON.stringify({ ticketId }),
      });
      if (live && res.ok) await load(() => live);
    })();
    return () => {
      live = false;
    };
  }, [load, ticketId]);

  async function finish(leaveUnresolved: boolean) {
    if (!payload?.review) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/reviews/${payload.review.id}/submit/`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `submit:${payload.review.id}` },
        body: JSON.stringify({ leaveUnresolved }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? "Could not submit.");
        return;
      }
      router.push("/evaluate/");
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    setBusy(true);
    try {
      await fetch(`/api/tickets/${ticketId}/release/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      router.push("/evaluate/");
    } finally {
      setBusy(false);
    }
  }

  if (error && !payload) return <main className="p-6 text-sm text-ink-soft">{error}</main>;
  if (!payload) return <main className="p-6 text-sm text-ink-soft">Opening the script…</main>;

  const unresolved = payload.answers.reduce((n, a) => n + a.checklist.unresolvedCount, 0);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <h1 className="text-sm font-semibold">
          {payload.submission.subject} · Class {payload.submission.classNum}
          {payload.submission.paperSlug ? ` · ${payload.submission.paperSlug}` : ""}
        </h1>
        <span className="text-xs text-ink-soft">
          {unresolved > 0
            ? `${unresolved} line(s) waiting on you`
            : "Nothing left unresolved"}
        </span>
        <div className="ml-auto flex gap-2">
          {payload.permissions.canRelease && (
            <button
              type="button"
              onClick={release}
              disabled={busy}
              className="min-h-11 rounded-md border border-border bg-surface px-3 text-sm disabled:opacity-40"
            >
              Give back
            </button>
          )}
          {payload.permissions.canGrade && (
            <button
              type="button"
              onClick={() => finish(unresolved > 0)}
              disabled={busy || !payload.review}
              className="min-h-11 rounded-md bg-accent px-3 text-sm font-semibold text-accent-ink disabled:opacity-40"
            >
              Finish
            </button>
          )}
        </div>
      </header>

      {error && <p className="border-b border-border px-4 py-2 text-sm text-ink-soft">{error}</p>}

      <GradingCanvas payload={payload} onSaved={() => void load()} />
    </main>
  );
}
