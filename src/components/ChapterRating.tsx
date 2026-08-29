"use client";

import { useEffect, useState } from "react";
import {
  allCards,
  cardId,
  review,
  upsertCard,
  type Confidence,
} from "@/lib/revision";

/**
 * Self-rated confidence on a whole chapter.
 *
 * This exists because the only other producer of revision cards is a scored
 * paper attempt, and a CBSE paper question carries no chapter tag — nothing in
 * the app was ever writing a card with `bookCode`/`chapter`, so the Phase 5
 * weak-area dashboard had nothing to cross against the syllabus weightage and
 * read "Not tested yet" forever.
 *
 * It matters most for Class 9, which has no sample papers and no NCERT answer
 * keys at all: rating a chapter is the *only* way a Class 9 student can feed
 * the revision engine. So this path deliberately touches neither papers nor
 * attempts. SM-2 runs on self-rating rather than on objective correctness, so a
 * chapter rating is a first-class input to it, not a downgrade.
 *
 * The card is keyed on the chapter number as its question number, which gives
 * one stable card per chapter: re-rating updates that card instead of piling up
 * duplicates, and `upsertCard` keeps the existing SM-2 state.
 *
 * Rendered as two grid children of a ChapterList row: the trigger sits on the
 * row's action line, the panel takes a full-width line under it.
 */

/** Worst to best, the order a student should read them — same as /revise. */
const LEVELS: { confidence: Confidence; label: string; hint: string }[] = [
  { confidence: "again", label: "Again", hint: "not started" },
  { confidence: "hard", label: "Hard", hint: "struggling" },
  { confidence: "good", label: "Good", hint: "solid" },
  { confidence: "easy", label: "Easy", hint: "exam ready" },
];

/**
 * Every row on the page mounts in the same tick, so share one read of the card
 * table between them rather than scanning it once per chapter. The promise is
 * released as soon as it settles, so a later mount — or a return to the page
 * after revising elsewhere — reads fresh state.
 */
let pendingRatings: Promise<Map<string, Confidence>> | null = null;

function loadRatings(): Promise<Map<string, Confidence>> {
  if (!pendingRatings) {
    pendingRatings = allCards()
      .then((cards) => {
        const map = new Map<string, Confidence>();
        for (const c of cards) {
          if (c.lastConfidence) map.set(c.id, c.lastConfidence);
        }
        return map;
      })
      // A private window can refuse IndexedDB outright; an unrated row is the
      // correct fallback, and rating still fails loudly below if it is broken.
      .catch(() => new Map<string, Confidence>())
      .finally(() => {
        pendingRatings = null;
      });
  }
  return pendingRatings;
}

export default function ChapterRating({
  bookCode,
  chapter,
  subject,
  classNum,
  className = "",
}: {
  bookCode: string;
  chapter: number;
  subject: string;
  classNum: 9 | 10;
  /** Placement for the trigger within the row grid. */
  className?: string;
}) {
  // undefined while the store is being read: the button renders unrated, which
  // is also what the prerendered HTML contains, so hydration matches.
  const [rating, setRating] = useState<Confidence | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const id = cardId("exercise", bookCode, chapter);

  useEffect(() => {
    let live = true;
    // Never set state synchronously in an effect body; only from the callback.
    loadRatings().then((map) => {
      if (live) setRating(map.get(id));
    });
    return () => {
      live = false;
    };
  }, [id]);

  async function onRate(confidence: Confidence) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // The chapter tag is the whole point: it is what lets /progress join this
      // rating onto a syllabus unit and turn it into marks at risk.
      await upsertCard({
        sourceType: "exercise",
        sourceId: bookCode,
        subject,
        classNum,
        bookCode,
        chapter,
        questionNo: chapter,
      });
      await review(id, confidence);
      setRating(confidence);
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const current = rating ? LEVELS.find((l) => l.confidence === rating) : undefined;
  const triggerLabel = current
    ? `You rated chapter ${chapter} "${current.label}". Change your rating.`
    : `Rate how well you know chapter ${chapter}`;

  return (
    <>
      {/* `relative z-10` keeps the button above the row link's stretched hit
          area, which otherwise swallows the tap and opens the chapter. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        className={`relative z-10 inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors hover:border-accent/50 hover:text-accent ${
          current ? "border-accent/40 text-accent" : "border-border text-ink-soft"
        } ${className}`}
      >
        {/* A gauge, not a tick: this is a judgement, not a completion mark. */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 18a8 8 0 1 1 16 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path d="M12 18l4-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span aria-hidden="true">{current ? current.label : "Rate"}</span>
      </button>

      {open && (
        // Full width on a line of its own, bled out to the row's edges, so four
        // 44px targets fit across a 390px phone.
        <div className="relative z-10 col-span-full row-start-3 -mx-3 mt-2 border-t border-border bg-surface-alt/40 px-3 py-3">
          <p className="mb-2 text-xs text-ink-soft">How well do you know this?</p>
          <div className="grid grid-cols-4 gap-1.5">
            {LEVELS.map((l) => (
              <button
                key={l.confidence}
                type="button"
                disabled={busy}
                onClick={() => onRate(l.confidence)}
                aria-pressed={rating === l.confidence}
                aria-label={`${l.label} — ${l.hint} — chapter ${chapter}`}
                className={`min-h-11 rounded-lg border px-1 py-2 text-center transition-colors disabled:opacity-50 ${
                  rating === l.confidence
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border bg-surface text-ink hover:border-accent hover:text-accent"
                }`}
              >
                <span className="block text-xs font-medium">{l.label}</span>
                <span className="block text-[10px] text-ink-faint">{l.hint}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            {failed
              ? "Could not save — this browser is blocking on-device storage."
              : "Your rating schedules this chapter for revision and feeds the weak-area dashboard."}
          </p>
        </div>
      )}
    </>
  );
}
