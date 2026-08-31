"use client";

/**
 * Loads one script and hands it to the matcher.
 *
 * It also owns the one button that starts marking, because there is no cron in
 * this repository: the submission's status is the queue, and something has to
 * drain it. When no marker is configured the button's response says so and no
 * mark appears — which is the whole point of the honest degradation path.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import RubricMatcher, { type SubmissionDetail } from "@/components/RubricMatcher";

export default function ScriptView() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : params.id?.[0];

  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/submissions/${id}/`);
    const body = (await res.json()) as {
      submission?: SubmissionDetail;
      error?: { message: string };
    };
    if (!res.ok) throw new Error(body?.error?.message ?? "Could not load this script.");
    setSubmission(body.submission ?? null);
  }, [id]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await load();
      } catch (err) {
        // A script that navigated away mid-fetch must not set state on an
        // unmounted view; the guard is cheaper than an AbortController here.
        if (live) setError(err instanceof Error ? err.message : "Could not load this script.");
      }
    })();
    return () => {
      live = false;
    };
  }, [load]);

  async function mark() {
    if (!id) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/grading/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // One key per logical action, reused on every retry.
          "idempotency-key": `grade:${id}`,
        },
        body: JSON.stringify({ submissionId: id }),
      });
      const body = (await res.json()) as {
        configured?: boolean;
        reason?: string;
        error?: { message: string };
      };
      if (!res.ok) throw new Error(body?.error?.message ?? "Marking failed.");
      if (body.configured === false && body.reason) setNotice(body.reason);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Marking failed.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <p role="alert" className="rounded-md bg-accent-soft p-3 text-sm">
        {error}
      </p>
    );
  }
  if (!submission) return <p className="text-sm text-ink-faint">Loading…</p>;

  const canMark = ["QUEUED", "FAILED", "AI_GRADING"].includes(submission.status);

  return (
    <div className="flex flex-col gap-4">
      {notice && <p className="rounded-md bg-surface-alt p-3 text-xs text-ink-soft">{notice}</p>}
      {canMark && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void mark()}
          className="min-h-12 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink disabled:opacity-50"
        >
          {busy ? "Marking…" : "Mark this script now"}
        </button>
      )}
      <RubricMatcher submission={submission} />
    </div>
  );
}
