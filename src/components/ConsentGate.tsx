"use client";

import { useEffect, useState } from "react";

/**
 * The student's screen. Who has asked to see their work, exactly what they
 * would see, and one tap to stop it.
 *
 * This component is the reason the parent dashboard is allowed to exist. A
 * parent link created without a screen like this — visible to the student, in
 * their own app, showing the full history and offering a revoke that bites
 * immediately — is the "Punitive Parental Telemetry" the PRD names as a cause
 * of study paralysis. The dashboard is the feature; this is the condition.
 *
 * Three things it does deliberately:
 *
 *  1. **States the limits before the buttons.** A consent screen that says
 *     "share my progress?" and nothing else is not consent, because the student
 *     cannot know what they are agreeing to. The two lists below are the
 *     product promise in the student's own words, and they are exactly what
 *     `src/lib/parent.ts` enforces in SQL.
 *  2. **Makes declining as easy as accepting.** Same size, same weight, no
 *     colour pushing one way. A default-styled "Allow" beside a grey "Not now"
 *     is a nudge, and nudging a fourteen-year-old into surveillance is the
 *     thing we are trying not to do.
 *  3. **Shows the whole history.** A parent who asks again after being turned
 *     down is visible to the person turning them down.
 */

interface LinkRequest {
  parentUserId: string;
  displayName: string | null;
  phoneHint: string | null;
  status: "PENDING" | "ACTIVE" | "DECLINED" | "REVOKED";
  requestedAt: string;
  decidedAt: string | null;
  history: Array<{ at: string; type: string }>;
}

const SEES = [
  "How often you sit down, and for how long",
  "Whether a subject is moving up or down over time",
  "Which chapters are taking you the most goes",
];

const NEVER_SEES = [
  "Anything you wrote — your answers, in your words",
  "Photos of your answer sheets",
  "What a teacher wrote or recorded back to you",
  "Any single question, right or wrong",
];

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function who(r: LinkRequest): string {
  if (r.displayName && r.phoneHint) return `${r.displayName} (${r.phoneHint})`;
  if (r.displayName) return r.displayName;
  if (r.phoneHint) return `The account ending ${r.phoneHint.slice(-4)}`;
  return "A parent account";
}

/** Fetches, and returns — it sets no state, so it is safe to call from an effect. */
async function fetchRequests(): Promise<LinkRequest[]> {
  const res = await fetch("/api/parent/links/", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as { requests?: LinkRequest[] };
  return data.requests ?? [];
}

export default function ConsentGate() {
  const [requests, setRequests] = useState<LinkRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchRequests()
      .then((rs) => live && setRequests(rs))
      .catch(() => {
        if (!live) return;
        setError("Could not load this just now. Try again in a moment.");
        setRequests([]);
      });
    return () => {
      live = false;
    };
  }, []);

  async function decide(parentUserId: string, decision: "GRANT" | "DECLINE" | "REVOKE") {
    setBusy(parentUserId);
    setError(null);
    try {
      const res = await fetch("/api/parent/consent/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // One key per logical action, reused on retry — docs/PLATFORM.md §5.
          "idempotency-key": `consent:${parentUserId}:${decision}`,
        },
        body: JSON.stringify({ parentUserId, decision }),
      });
      if (!res.ok) throw new Error();
      setRequests(await fetchRequests());
    } catch {
      setError("That did not go through. Nothing has changed.");
    } finally {
      setBusy(null);
    }
  }

  if (requests === null) {
    return <p className="text-sm text-ink-faint">Loading…</p>;
  }

  const pending = requests.filter((r) => r.status === "PENDING");
  const active = requests.filter((r) => r.status === "ACTIVE");
  const closed = requests.filter((r) => r.status === "DECLINED" || r.status === "REVOKED");

  return (
    <>
      {error && (
        <p className="mb-4 rounded-xl bg-accent-soft px-3 py-2 text-sm text-accent">{error}</p>
      )}

      {requests.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border p-5">
          <p className="text-sm text-ink-soft">
            Nobody has asked to follow your progress. If a parent does, it will appear here first,
            and nothing is shared until you say so.
          </p>
        </div>
      )}

      {pending.map((r) => (
        <section key={r.parentUserId} className="mb-6 rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-base font-semibold leading-tight">
            {who(r)} has asked to follow how your studying is going.
          </h2>
          <p className="mt-1 text-xs text-ink-faint">Asked on {when(r.requestedAt)}</p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                They would see
              </p>
              <ul className="mt-2 space-y-1.5 text-sm text-ink-soft">
                {SEES.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                They would never see
              </p>
              <ul className="mt-2 space-y-1.5 text-sm text-ink-soft">
                {NEVER_SEES.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          </div>

          <p className="mt-4 text-sm text-ink-soft">
            You can stop this at any time, from this screen, and it stops straight away.
          </p>

          {/* Same size, same weight, no colour pushing either way. */}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy === r.parentUserId}
              onClick={() => decide(r.parentUserId, "GRANT")}
              className="min-h-11 flex-1 rounded-lg border border-border px-4 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              Allow
            </button>
            <button
              type="button"
              disabled={busy === r.parentUserId}
              onClick={() => decide(r.parentUserId, "DECLINE")}
              className="min-h-11 flex-1 rounded-lg border border-border px-4 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </section>
      ))}

      {active.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 font-semibold">Following your progress</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {active.map((r) => (
              <li key={r.parentUserId} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{who(r)}</p>
                  <p className="text-xs text-ink-faint">
                    Since {r.decidedAt ? when(r.decidedAt) : when(r.requestedAt)}
                    {r.history.filter((h) => h.type === "REQUESTED").length > 1 &&
                      ` · asked ${r.history.filter((h) => h.type === "REQUESTED").length} times`}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy === r.parentUserId}
                  onClick={() => decide(r.parentUserId, "REVOKE")}
                  className="min-h-11 shrink-0 rounded-lg border border-border px-4 text-sm transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  Stop sharing
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {closed.length > 0 && (
        <section>
          <h2 className="mb-3 font-semibold">Not sharing</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {closed.map((r) => (
              <li key={r.parentUserId} className="p-4">
                <p className="text-sm">{who(r)}</p>
                <p className="text-xs text-ink-faint">
                  {r.status === "REVOKED" ? "You stopped sharing" : "You said not now"}
                  {r.decidedAt ? ` on ${when(r.decidedAt)}` : ""} · asked{" "}
                  {r.history.filter((h) => h.type === "REQUESTED").length}{" "}
                  {r.history.filter((h) => h.type === "REQUESTED").length === 1 ? "time" : "times"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
