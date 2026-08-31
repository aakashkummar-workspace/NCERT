"use client";

import { useEffect, useState } from "react";

/**
 * The parent's screen.
 *
 * The order on this page is the argument. **Recommendations first, numbers
 * underneath.** A dashboard that opens on a score has already told the parent
 * what to feel before it tells them what to do, and the PRD's problem statement
 * is about exactly that reflex. Everything above the fold here is a sentence
 * containing a verb.
 *
 * There is also a short, permanent note saying what this screen cannot show and
 * why. It is not a disclaimer — it is there so the parent knows the student was
 * not overruled, which is what makes the student willing to leave the link on.
 */

type Band = "not-marked" | "landing" | "coming-along" | "not-yet";

interface Recommendation {
  id: string;
  kind: string;
  action: string;
  because: string;
  minutes: number;
}

interface Overview {
  child: { id: string; displayName: string | null; classNum: number | null; schoolName: string | null };
  consent: { grantedAt: string };
  effort: {
    weeks: Array<{ weekStartMs: number; sessions: number; minutes: number; papers: number }>;
    lastActiveMs: number | null;
    lateNightSessions: number;
  };
  subjects: Array<{ subject: string; recent: number | null; earlier: number | null; papers: number }>;
  chapters: Array<{
    bookCode: string;
    chapter: number;
    subject: string;
    label: string;
    band: Band;
    revisits: number;
    answersGraded: number;
  }>;
  pendingHumanReview: number;
  recommendations: Recommendation[];
}

interface ChildLink {
  studentUserId: string;
  status: string;
  displayName: string | null;
  classNum: number | null;
}

const BAND_LABEL: Record<Band, string> = {
  "not-marked": "not marked yet",
  landing: "landing",
  "coming-along": "coming along",
  "not-yet": "not yet",
};

/** Direction, in words. A parent needs to know which way, not by how much. */
function direction(recent: number | null, earlier: number | null): string {
  if (recent === null) return "nothing marked yet";
  if (earlier === null) return "first papers in";
  const delta = recent - earlier;
  if (delta > 0.05) return "moving up";
  if (delta < -0.05) return "dipped";
  return "holding steady";
}

function minutesLabel(m: number): string {
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** Fetches, and returns — it sets no state, so it is safe to call from an effect. */
async function fetchLinks(): Promise<ChildLink[]> {
  const res = await fetch("/api/parent/links/", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as { children?: ChildLink[] };
  return data.children ?? [];
}

export default function ParentDashboard() {
  const [children, setChildren] = useState<ChildLink[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let live = true;
    fetchLinks()
      .then((list) => {
        if (!live) return;
        setChildren(list);
        const active = list.filter((c) => c.status === "ACTIVE");
        setSelected((prev) => prev ?? active[0]?.studentUserId ?? null);
      })
      .catch(() => live && setChildren([]));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    fetch(`/api/parent/overview/?studentId=${encodeURIComponent(selected)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Overview | null) => live && setOverview(d))
      .catch(() => live && setOverview(null));
    return () => {
      live = false;
    };
  }, [selected]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/parent/links/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `link:${phone}`,
        },
        body: JSON.stringify({ studentPhone: phone }),
      });
      const data = (await res.json()) as { message?: string; error?: { message: string } };
      setMessage(data.message ?? data.error?.message ?? "Sent.");
      setPhone("");
      setChildren(await fetchLinks());
    } catch {
      setMessage("That did not send. Try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  const active = (children ?? []).filter((c) => c.status === "ACTIVE");
  const waiting = (children ?? []).filter((c) => c.status === "PENDING");

  return (
    <>
      {active.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {active.map((c) => (
            <button
              key={c.studentUserId}
              type="button"
              onClick={() => setSelected(c.studentUserId)}
              aria-pressed={selected === c.studentUserId}
              className={`min-h-11 rounded-lg border px-4 text-sm ${
                selected === c.studentUserId
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-ink-soft"
              }`}
            >
              {c.displayName ?? "Your child"}
            </button>
          ))}
        </div>
      )}

      {selected && overview && (
        <>
          {/* The whole point of the screen, first. */}
          <section className="mb-8">
            <h2 className="mb-3 font-semibold">This week, at home</h2>
            <ul className="space-y-3">
              {overview.recommendations.map((r) => (
                <li key={r.id} className="rounded-2xl border border-border bg-surface p-4">
                  <p className="text-sm font-medium leading-snug">{r.action}</p>
                  <p className="mt-1.5 text-sm text-ink-soft">{r.because}</p>
                  {r.minutes > 0 && (
                    <p className="mt-2 text-xs text-ink-faint">About {r.minutes} minutes</p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="mb-3 font-semibold">Turning up</h2>
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
              {overview.effort.weeks
                .slice(-6)
                .reverse()
                .map((w) => (
                  <li key={w.weekStartMs} className="flex items-baseline gap-3 p-3">
                    <span className="min-w-0 flex-1 text-sm">
                      Week of{" "}
                      {new Date(w.weekStartMs).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-soft">
                      {w.sessions} {w.sessions === 1 ? "sitting" : "sittings"} ·{" "}
                      {minutesLabel(w.minutes)}
                    </span>
                  </li>
                ))}
              {overview.effort.weeks.length === 0 && (
                <li className="p-4 text-sm text-ink-faint">No sittings recorded yet.</li>
              )}
            </ul>
          </section>

          {overview.subjects.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-semibold">Which way each subject is going</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                {overview.subjects.map((s) => (
                  <li key={s.subject} className="flex items-baseline gap-3 p-3">
                    <span className="min-w-0 flex-1 text-sm font-medium">{s.subject}</span>
                    <span className="shrink-0 text-xs text-ink-soft">
                      {direction(s.recent, s.earlier)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {overview.chapters.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-1 font-semibold">Chapters taking the most goes</h2>
              <p className="mb-3 text-xs text-ink-faint">
                Chapter level, not question level — on purpose.
              </p>
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                {[...overview.chapters]
                  .sort((a, b) => b.revisits - a.revisits)
                  .slice(0, 6)
                  .map((c) => (
                    <li key={`${c.bookCode}:${c.chapter}`} className="p-3">
                      <div className="flex items-baseline gap-3">
                        <span className="min-w-0 flex-1 text-sm font-medium">{c.label}</span>
                        <span className="shrink-0 text-xs text-ink-soft">{BAND_LABEL[c.band]}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {c.subject} · {c.revisits} {c.revisits === 1 ? "go" : "goes"}
                      </p>
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {overview.pendingHumanReview > 0 && (
            <p className="mb-8 rounded-xl bg-accent-soft px-3 py-2 text-sm text-accent">
              {overview.pendingHumanReview}{" "}
              {overview.pendingHumanReview === 1 ? "answer is" : "answers are"} with a teacher for
              marking.
            </p>
          )}

          <section className="mb-8 rounded-2xl border border-dashed border-border p-4">
            <p className="text-sm text-ink-soft">
              This screen shows effort, direction and which chapters are hard. It does not show
              anything {overview.child.displayName?.split(" ")[0] ?? "your child"} wrote, the photos
              of their answer sheets, or what a teacher said back to them. That is deliberate, they
              know it, and they can stop sharing at any time.
            </p>
          </section>
        </>
      )}

      {active.length === 0 && (
        <div className="mb-8 rounded-2xl border border-dashed border-border p-5">
          <p className="text-sm text-ink-soft">
            {waiting.length > 0
              ? "Your request is waiting. Nothing is shared until they agree — you will see this fill in when they do."
              : "Add your child's number below. They decide whether to share, and can stop whenever they like."}
          </p>
        </div>
      )}

      <section>
        <h2 className="mb-3 font-semibold">Ask to follow another child</h2>
        <form onSubmit={ask} className="flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="parent-link-phone">
            Your child&apos;s phone number
          </label>
          <input
            id="parent-link-phone"
            type="tel"
            inputMode="tel"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Their phone number"
            className="min-h-11 flex-1 rounded-lg border border-border bg-surface px-3 text-sm"
          />
          <button
            type="submit"
            disabled={sending || phone.trim().length === 0}
            className="min-h-11 rounded-lg border border-border px-4 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            Send request
          </button>
        </form>
        {message && <p className="mt-3 text-sm text-ink-soft">{message}</p>}
      </section>
    </>
  );
}
