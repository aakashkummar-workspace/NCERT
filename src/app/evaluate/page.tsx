"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/**
 * /evaluate — the master bulletin board.
 *
 * One board for both engines. A rostered tuition tutor and a freelance marker
 * open the same page and see the same layout; what differs is which tickets are
 * on it, and that comes from their own profile on the server, never from
 * anything this page sends. The claim button is the only control that matters,
 * and pressing it is a single conditional `UPDATE` — the row it returns *is*
 * the claim, so two people pressing at the same moment get two different
 * tickets rather than one ticket twice.
 *
 * When the button is disabled the page says why in words: off shift, at the
 * concurrency limit, not active for routing. A "Claim" that silently does
 * nothing is how an evaluator learns to stop trusting the queue.
 */

interface TicketCard {
  id: string;
  subject: string;
  classNum: number;
  priority: number;
  status: string;
  claimCount: number;
  leaseExpiresAt: string | null;
  slaDueAt: string | null;
  createdAt: string;
  submission: {
    id: string;
    paperSlug: string | null;
    pageCount: number;
    _count: { answers: number };
  };
}

interface Board {
  view: "EVALUATOR" | "ADMIN";
  tickets?: TicketCard[];
  mine?: TicketCard[];
  available?: TicketCard[];
  evaluator?: {
    evaluatorType: string;
    activeForRouting: boolean;
    maxConcurrent: number;
    openTickets: number;
    onShift: boolean;
    shift: { startMinute: number; endMinute: number; timeZone: string } | null;
    qualifications: { subject: string; classNum: number }[];
    canClaim: boolean;
    refusedMessage: string | null;
  };
}

function wallTime(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  return `${h}:${String(minutes % 60).padStart(2, "0")}`;
}

async function fetchBoard(): Promise<Board> {
  const res = await fetch("/api/tickets/", { cache: "no-store" });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? "Could not load the board.");
  return json as Board;
}

export default function EvaluatePage() {
  const router = useRouter();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the board.");
    }
  }, []);

  useEffect(() => {
    let live = true;
    async function poll() {
      try {
        const next = await fetchBoard();
        if (live) {
          setBoard(next);
          setError(null);
        }
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : "Could not load the board.");
      }
    }
    void poll();
    // Polling, not a socket. The queue moves in seconds, not milliseconds, and a
    // socket would be a second stateful system standing guard over a list.
    const id = setInterval(() => void poll(), 15_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  async function claim() {
    setClaiming(true);
    setNotice(null);
    try {
      const res = await fetch("/api/tickets/claim/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? "Could not claim.");
      // An empty queue is a 200 with `claimed: false`. It is the ordinary answer
      // all afternoon, and treating it as an error trains everyone to ignore them.
      if (json.claimed) {
        router.push(`/evaluate/${json.ticket.id}/`);
        return;
      }
      setNotice(json.message ?? "Nothing is waiting for you right now.");
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not claim.");
    } finally {
      setClaiming(false);
    }
  }

  if (error && !board) return <main className="p-6 text-sm text-ink-soft">{error}</main>;
  if (!board) return <main className="p-6 text-sm text-ink-soft">Loading the board…</main>;

  const e = board.evaluator;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-xl font-semibold">Marking queue</h1>

      {e && (
        <section className="mt-3 rounded-lg border border-border bg-surface p-4">
          <p className="text-sm text-ink-soft">
            {e.evaluatorType.replace(/_/g, " ").toLowerCase()} · holding{" "}
            <strong className="text-ink">{e.openTickets}</strong> of {e.maxConcurrent}
          </p>
          {e.shift ? (
            <p className="mt-1 text-sm text-ink-soft">
              Shift {wallTime(e.shift.startMinute)}–{wallTime(e.shift.endMinute)} {e.shift.timeZone}
              {e.shift.startMinute > e.shift.endMinute && " (crosses midnight)"} ·{" "}
              {e.onShift ? "on shift now" : "off shift now"}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-soft">
              Open network — no rostered hours. You take work off the board when you want it.
            </p>
          )}
          <p className="mt-1 text-sm text-ink-faint">
            {e.qualifications.map((q) => `${q.subject} ${q.classNum}`).join(", ") ||
              "No subjects registered"}
          </p>
          <button
            type="button"
            onClick={claim}
            disabled={claiming || !e.canClaim}
            className="mt-3 min-h-11 w-full rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-40 sm:w-auto"
          >
            {claiming ? "Claiming…" : "Claim the next script"}
          </button>
          {(e.refusedMessage || notice) && (
            <p className="mt-2 text-sm text-ink-soft">{e.refusedMessage ?? notice}</p>
          )}
        </section>
      )}

      {board.mine && board.mine.length > 0 && (
        <TicketList title="In your hands" tickets={board.mine} linkable />
      )}
      {board.available && <TicketList title="On the board" tickets={board.available} />}
      {board.tickets && (
        <TicketList title="Every ticket in this scope" tickets={board.tickets} linkable />
      )}
    </main>
  );
}

function TicketList({
  title,
  tickets,
  linkable,
}: {
  title: string;
  tickets: TicketCard[];
  linkable?: boolean;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">{title}</h2>
      {tickets.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">Nothing here.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {tickets.map((t) => {
            const body = (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium">
                    {t.subject} · Class {t.classNum}
                  </p>
                  <span className="text-xs text-ink-faint">{t.status.toLowerCase()}</span>
                </div>
                <p className="mt-0.5 text-xs text-ink-soft">
                  {t.submission._count.answers} answer(s) · {t.submission.pageCount} page(s)
                  {t.priority > 0 && ` · priority ${t.priority}`}
                  {/* A ticket claimed and dropped repeatedly is a bad scan, not
                      four bad tutors. Surfacing it is how it gets triaged. */}
                  {t.claimCount > 1 && ` · claimed ${t.claimCount}×`}
                </p>
                {t.leaseExpiresAt && (
                  <p className="mt-0.5 text-xs text-ink-faint">
                    Held until {new Date(t.leaseExpiresAt).toLocaleTimeString()}
                  </p>
                )}
              </>
            );
            return (
              <li key={t.id} className="rounded-lg border border-border bg-surface p-3">
                {linkable ? (
                  <Link href={`/evaluate/${t.id}/`} className="block">
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
