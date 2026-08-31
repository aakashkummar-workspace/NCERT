"use client";

import { useMemo } from "react";

/**
 * The right-hand half of the grading canvas: the marking scheme, one line at a
 * time, with the current verdict on each.
 *
 * **Unmarked comes first, and that is the point of the whole screen.**
 * `data/rubrics.schema.md` has a fourth outcome beside hit/partial/miss:
 * *unmarked*, which awards nothing and means "nobody has judged this yet". It
 * arises two ways and both of them are exactly what a human is here to resolve:
 *
 * - a diagram, or any step marked `autoGradable: false` — a keyword matcher run
 *   over a photograph cannot honestly say whether a triangle was drawn right;
 * - a miss withheld because the rubric is flagged `needsReview` — nothing is
 *   ever painted red on an unsigned rubric, because an unchecked conversion may
 *   accuse a student of writing nothing of value, and that is the one mistake
 *   with no recovery.
 *
 * A checklist that lists these in authored order buries the two lines that need
 * a person under twelve the model already settled. So they sort to the top,
 * banded and labelled, and the banner above the list counts them.
 *
 * The colours are the product's three and no more. An unmarked criterion draws
 * **no** highlight over the student's handwriting — `HighlightSpan.color` is NOT
 * NULL over exactly GREEN/ORANGE/RED precisely so that a renderer cannot fall
 * back to a default for it, and the default it would reach for is red.
 */

export type CriterionVerdict = "HIT" | "PARTIAL" | "MISS" | "UNMARKED";
export type UnmarkedReason = "NOT_AUTO_GRADABLE" | "RUBRIC_NEEDS_REVIEW";
export type ChecklistUrgency = "NEEDS_YOUR_EYE" | "NEEDS_SIGN_OFF" | "REVIEW" | "SETTLED";

export interface PartialRule {
  id: string;
  reason: string;
  award: number;
  note: string | null;
}

export interface ChecklistItem {
  rubricCriterionId: string;
  stepId: string;
  kind: string;
  awardFor: string;
  branchLabel: string | null;
  parentId: string | null;
  worth: number;
  autoGradable: boolean;
  labels: string[];
  concepts: string[][];
  partialRules: PartialRule[];
  verdict: CriterionVerdict | null;
  awarded: number | null;
  unmarkedReason: UnmarkedReason | null;
  note: string | null;
  urgency: ChecklistUrgency;
}

export interface Checklist {
  answerId: string;
  questionNumber: number;
  maxMarks: number;
  rubricId: string | null;
  rubricNeedsReview: boolean;
  reviewNotes: string[];
  unresolvedCount: number;
  items: ChecklistItem[];
}

/** The evaluator's working verdict on one criterion, before it is appended. */
export interface DraftVerdict {
  verdict: CriterionVerdict;
  awarded: number;
  partialRuleId: string | null;
  unmarkedReason: UnmarkedReason | null;
  note: string | null;
}

const URGENCY_COPY: Record<ChecklistUrgency, { label: string; hint: string } | null> = {
  NEEDS_YOUR_EYE: {
    label: "Needs your eye",
    hint: "No matcher may decide this. It is why the ticket came to a person.",
  },
  NEEDS_SIGN_OFF: {
    label: "Needs sign-off",
    hint: "Held back because the marking scheme is unsigned. Nothing was painted red.",
  },
  REVIEW: { label: "Worth a look", hint: "The model took marks off here." },
  SETTLED: null,
};

const VERDICT_STYLE: Record<CriterionVerdict, string> = {
  HIT: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/40",
  PARTIAL: "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/40",
  MISS: "bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/40",
  // No colour. An unmarked criterion is not a loss and must never read as one.
  UNMARKED: "bg-surface-alt text-ink-soft border-border",
};

const VERDICT_LABEL: Record<CriterionVerdict, string> = {
  HIT: "Full",
  PARTIAL: "Partial",
  MISS: "Miss",
  UNMARKED: "Unmarked",
};

function defaultAward(item: ChecklistItem, verdict: CriterionVerdict): number {
  if (verdict === "HIT") return item.worth;
  if (verdict === "PARTIAL") return item.partialRules[0]?.award ?? item.worth / 2;
  return 0;
}

export default function RubricChecklist({
  checklist,
  draft,
  onChange,
  readOnly,
  activeCriterionId,
  onFocusCriterion,
}: {
  checklist: Checklist;
  /** Working verdicts by `rubricCriterionId`. Absent means "as graded". */
  draft: Record<string, DraftVerdict>;
  onChange: (rubricCriterionId: string, next: DraftVerdict | null) => void;
  readOnly: boolean;
  /** The criterion whose highlight boxes the canvas is currently drawing. */
  activeCriterionId: string | null;
  onFocusCriterion: (rubricCriterionId: string) => void;
}) {
  const bands = useMemo(() => {
    const out: { urgency: ChecklistUrgency; items: ChecklistItem[] }[] = [];
    for (const item of checklist.items) {
      const last = out[out.length - 1];
      if (last && last.urgency === item.urgency) last.items.push(item);
      else out.push({ urgency: item.urgency, items: [item] });
    }
    return out;
  }, [checklist.items]);

  const total = checklist.items.reduce((sum, item) => {
    const d = draft[item.rubricCriterionId];
    return sum + (d ? d.awarded : (item.awarded ?? 0));
  }, 0);

  return (
    <section className="flex h-full flex-col overflow-hidden" aria-label="Marking scheme">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">Question {checklist.questionNumber}</h2>
          <p className="text-sm tabular-nums text-ink-soft">
            <span className="text-lg font-semibold text-ink">{total}</span> / {checklist.maxMarks}
          </p>
        </div>

        {checklist.rubricId === null && (
          <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            There is no marking scheme loaded for this question, so there is nothing to grade
            against. Mark it by hand or send the ticket back.
          </p>
        )}

        {checklist.rubricNeedsReview && (
          <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <p className="font-medium">This marking scheme is not signed off.</p>
            <p className="mt-1 text-ink-soft">
              Nothing was painted red automatically. A miss here was held back rather than shown
              to the student as a wrong answer — deciding it is your call.
            </p>
            {checklist.reviewNotes.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-ink-soft">
                {checklist.reviewNotes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {checklist.unresolvedCount > 0 && (
          <p className="mt-2 text-sm text-ink-soft">
            <strong className="text-ink">{checklist.unresolvedCount}</strong> line
            {checklist.unresolvedCount === 1 ? "" : "s"} still waiting on a person. They are at the
            top.
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {bands.map((band) => {
          const copy = URGENCY_COPY[band.urgency];
          return (
            <div key={band.urgency}>
              {copy && (
                <div className="sticky top-0 z-10 border-y border-border bg-surface-alt px-4 py-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                    {copy.label}
                  </p>
                  <p className="text-xs text-ink-faint">{copy.hint}</p>
                </div>
              )}
              <ul>
                {band.items.map((item) => (
                  <CriterionRow
                    key={item.rubricCriterionId}
                    item={item}
                    draft={draft[item.rubricCriterionId] ?? null}
                    onChange={(next) => onChange(item.rubricCriterionId, next)}
                    readOnly={readOnly}
                    active={activeCriterionId === item.rubricCriterionId}
                    onFocus={() => onFocusCriterion(item.rubricCriterionId)}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CriterionRow({
  item,
  draft,
  onChange,
  readOnly,
  active,
  onFocus,
}: {
  item: ChecklistItem;
  draft: DraftVerdict | null;
  onChange: (next: DraftVerdict | null) => void;
  readOnly: boolean;
  active: boolean;
  onFocus: () => void;
}) {
  const shown: CriterionVerdict | null = draft?.verdict ?? item.verdict;
  const awarded = draft ? draft.awarded : item.awarded;

  function setVerdict(verdict: CriterionVerdict) {
    onChange({
      verdict,
      awarded: defaultAward(item, verdict),
      partialRuleId: verdict === "PARTIAL" ? (item.partialRules[0]?.id ?? null) : null,
      // The constraint is not negotiable: an UNMARKED criterion must say which
      // kind of human it is waiting for.
      unmarkedReason:
        verdict === "UNMARKED"
          ? (item.unmarkedReason ?? (item.autoGradable ? "RUBRIC_NEEDS_REVIEW" : "NOT_AUTO_GRADABLE"))
          : null,
      note: draft?.note ?? null,
    });
  }

  return (
    <li
      className={`border-b border-border px-4 py-3 ${active ? "bg-accent-soft" : ""}`}
      onFocus={onFocus}
    >
      <button
        type="button"
        onClick={onFocus}
        className="block w-full text-left"
        aria-pressed={active}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm leading-snug">
            {item.branchLabel && (
              <span className="mr-1.5 rounded bg-surface-alt px-1.5 py-0.5 text-xs font-semibold">
                {item.branchLabel}
              </span>
            )}
            {item.awardFor}
          </p>
          <span className="shrink-0 text-xs tabular-nums text-ink-faint">
            {awarded ?? "—"}/{item.worth}
          </span>
        </div>
      </button>

      {item.labels.length > 0 && (
        <p className="mt-1 text-xs text-ink-soft">Must show: {item.labels.join(", ")}</p>
      )}
      {item.concepts.length > 0 && (
        <p className="mt-1 text-xs text-ink-faint">
          {item.concepts.map((c) => c.join(" / ")).join("  ·  ")}
        </p>
      )}
      {!item.autoGradable && (
        <p className="mt-1 text-xs text-ink-soft">
          Not machine-gradable — this one was always going to need you.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {(["HIT", "PARTIAL", "MISS", "UNMARKED"] as const).map((verdict) => {
          const disabled =
            readOnly ||
            // A half-mark step cannot be partially credited: there is no
            // positive multiple of 0.5 below 0.5. It is green or it is red.
            (verdict === "PARTIAL" && item.partialRules.length === 0 && item.worth <= 0.5);
          return (
            <button
              key={verdict}
              type="button"
              disabled={disabled}
              onClick={() => setVerdict(verdict)}
              className={`min-h-11 rounded-md border px-3 text-sm font-medium disabled:opacity-40 ${
                shown === verdict ? VERDICT_STYLE[verdict] : "border-border bg-surface text-ink-soft"
              }`}
            >
              {VERDICT_LABEL[verdict]}
            </button>
          );
        })}
      </div>

      {draft?.verdict === "PARTIAL" && item.partialRules.length > 0 && (
        <label className="mt-2 block text-xs text-ink-soft">
          Why partial
          <select
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-2 text-sm text-ink"
            value={draft.partialRuleId ?? ""}
            onChange={(e) => {
              const rule = item.partialRules.find((r) => r.id === e.target.value);
              onChange({
                ...draft,
                partialRuleId: rule?.id ?? null,
                awarded: rule?.award ?? draft.awarded,
              });
            }}
          >
            {item.partialRules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.reason.replace(/-/g, " ")} — {r.award}
                {r.note ? ` (${r.note})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {draft?.verdict === "UNMARKED" && (
        <p className="mt-2 rounded border border-border bg-surface-alt px-2 py-1.5 text-xs text-ink-soft">
          Left unmarked
          {draft.unmarkedReason === "NOT_AUTO_GRADABLE"
            ? " — waiting on a human eye."
            : " — waiting on the marking scheme being signed off."}{" "}
          Nothing is drawn over the student&rsquo;s work for this line, and it will not be shown to
          them as a mark lost.
        </p>
      )}

      {(item.verdict !== null || draft !== null) && !readOnly && draft !== null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="mt-2 text-xs underline text-ink-faint"
        >
          Undo my change to this line
        </button>
      )}
    </li>
  );
}
