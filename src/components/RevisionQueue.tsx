"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DAY_MS,
  allCards,
  dueCards,
  dueCount,
  review,
  type Card,
  type Confidence,
} from "@/lib/revision";
import { getPaper } from "@/lib/papers";

/**
 * The payoff of practice mode: every question the student self-scored became an
 * SM-2 card, and this is where those cards come back.
 *
 * One card at a time — a list would invite skimming, and the whole point is an
 * honest judgement on each question before the next one appears.
 */

/** In the order a student should read them: worst to best. */
const BUTTONS: { confidence: Confidence; label: string; hint: string }[] = [
  { confidence: "again", label: "Again", hint: "no idea" },
  { confidence: "hard", label: "Hard", hint: "struggled" },
  { confidence: "good", label: "Good", hint: "got it" },
  { confidence: "easy", label: "Easy", hint: "instant" },
];

const HOW_MANY = 20;

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

/** A bare slug means nothing to a student; show the paper's own title. */
function sourceLabel(card: Card): string {
  if (card.sourceType === "paper") return getPaper(card.sourceId)?.title ?? card.sourceId;
  return card.sourceId;
}

function whenDue(at: number, now: number): string {
  const days = Math.round((at - now) / DAY_MS);
  if (days <= 0) return "later today";
  if (days === 1) return "tomorrow";
  if (days < 30) return `in ${days} days`;
  return `on ${DATE.format(at)}`;
}

/** What is left once the queue is cleared: still-due count and the next date. */
async function lookAhead(now: number): Promise<Done> {
  const [due, cards] = await Promise.all([dueCount(now), allCards()]);
  const upcoming = cards.map((c) => c.dueAt).filter((d) => d > now);
  return {
    due,
    scheduled: upcoming.length,
    nextLabel: upcoming.length === 0 ? null : whenDue(Math.min(...upcoming), now),
  };
}

interface Done {
  due: number;
  /** Cards waiting on a future date — the difference between "none due" and "none at all". */
  scheduled: number;
  /** Null when the student has no card scheduled at all. */
  nextLabel: string | null;
}

/**
 * Remounted with a fresh `key` for each batch, so starting the next twenty is
 * a new mount rather than a pile of state resets.
 */
function Queue({ onNextBatch }: { onNextBatch: () => void }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  // Filled in only once the queue runs dry.
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    let live = true;
    dueCards(HOW_MANY)
      .then((next) => {
        if (live) setCards(next);
      })
      .catch(() => {
        if (live) setCards([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const finished = cards !== null && cards.length > 0 && index >= cards.length;
  const empty = cards !== null && cards.length === 0;

  // Also runs for an empty queue: SM-2 schedules every freshly scored question
  // at least a day out, so a student who has just marked a whole paper arrives
  // here with nothing due and needs telling that their work did register.
  useEffect(() => {
    if (!finished && !empty) return;
    let live = true;
    lookAhead(Date.now())
      .then((next) => {
        if (live) setDone(next);
      })
      .catch(() => {
        if (live) setDone({ due: 0, scheduled: 0, nextLabel: null });
      });
    return () => {
      live = false;
    };
  }, [finished, empty]);

  async function onRate(card: Card, confidence: Confidence) {
    if (busy) return;
    setBusy(true);
    try {
      await review(card.id, confidence);
    } finally {
      setBusy(false);
      setIndex((i) => i + 1);
    }
  }

  if (cards === null) {
    return <p className="text-sm text-ink-faint">Loading your revision queue…</p>;
  }

  if (cards.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-ink-soft">Nothing is due right now.</p>
        {done && done.scheduled > 0 ? (
          <p className="mt-1 text-xs text-ink-faint">
            {done.scheduled} {done.scheduled === 1 ? "card is" : "cards are"} waiting — the next
            {done.nextLabel ? ` is due ${done.nextLabel}` : " has no date yet"}. Revision works by
            leaving a gap, so a question you scored today comes back once you have had time to
            forget it.
          </p>
        ) : (
          <p className="mt-1 text-xs text-ink-faint">
            Cards appear here after you sit a paper in Practice and score yourself against the
            marking scheme. Every question you score becomes a card, and the ones you found hardest
            come back soonest.
          </p>
        )}
        <Link
          href="/practice"
          className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-accent transition-colors hover:border-accent"
        >
          Go to practice papers
        </Link>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-8 text-center">
        <p className="text-sm font-medium">
          Queue cleared — {cards.length} {cards.length === 1 ? "card" : "cards"} reviewed.
        </p>
        {done === null ? (
          <p className="mt-1 text-xs text-ink-faint">Working out what comes next…</p>
        ) : done.due > 0 ? (
          <>
            <p className="mt-1 text-xs text-ink-faint">
              {done.due} more {done.due === 1 ? "card is" : "cards are"} still due.
            </p>
            <button
              type="button"
              onClick={onNextBatch}
              className="mt-4 rounded-lg border border-border px-4 py-2 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
            >
              Review the next {Math.min(done.due, HOW_MANY)}
            </button>
          </>
        ) : (
          <p className="mt-1 text-xs text-ink-faint">
            {done.nextLabel === null
              ? "That is every card you have — nothing else is scheduled."
              : `Next cards are due ${done.nextLabel}.`}
          </p>
        )}
        <p className="mt-4">
          <Link href="/practice" className="text-sm text-accent underline underline-offset-4">
            Back to practice papers
          </Link>
        </p>
      </div>
    );
  }

  const card = cards[index];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-xs text-ink-faint">
        <span className="tabular-nums">
          {index + 1} of {cards.length}
        </span>
        <span className="uppercase tracking-wider">{card.subject}</span>
      </div>

      <div
        className="h-1 overflow-hidden rounded-full bg-surface-alt"
        role="progressbar"
        aria-valuenow={index}
        aria-valuemin={0}
        aria-valuemax={cards.length}
        aria-label="Revision progress"
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${(index / cards.length) * 100}%` }}
        />
      </div>

      <article className="mt-4 rounded-2xl border border-border bg-surface p-5">
        <p className="text-xs text-ink-faint">
          Class {card.classNum} · {card.subject}
        </p>
        <p className="mt-1 text-sm text-ink-soft">{sourceLabel(card)}</p>
        <p className="mt-4 text-2xl font-semibold tracking-tight">Question {card.questionNo}</p>
        <p className="mt-1 text-xs tabular-nums text-ink-faint">
          {card.maxMarks === undefined ? "Marks not recorded" : `${card.maxMarks} marks`}
          {card.lastScore !== undefined &&
            ` · you scored ${card.lastScore}${
              card.maxMarks === undefined ? "" : `/${card.maxMarks}`
            } last time`}
        </p>
        <p className="mt-4 text-xs text-ink-faint">
          Look the question up and answer it again before you rate yourself.
        </p>
      </article>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BUTTONS.map((b) => (
          <button
            key={b.confidence}
            type="button"
            disabled={busy}
            onClick={() => onRate(card, b.confidence)}
            className="rounded-xl border border-border bg-surface px-3 py-3 text-center transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            <span className="block text-sm font-medium">{b.label}</span>
            <span className="block text-[11px] text-ink-faint">{b.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function RevisionQueue() {
  const [batch, setBatch] = useState(0);
  return <Queue key={batch} onNextBatch={() => setBatch((b) => b + 1)} />;
}
