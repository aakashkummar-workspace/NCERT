"use client";

import { useRef, useState } from "react";
import { saveQuizResult, type AnsweredQuestion } from "@/lib/quiz-attempts";
import type { QuizQuestion } from "@/lib/quiz";
import { loadMemory, selectBridge, signalsFromAnswers } from "@/lib/bridge";
import { MicroBridgeOffer } from "@/components/MicroBridge";

/**
 * One quiz, one question at a time.
 *
 * Deliberately not a scrolling list of every question. On a 390px phone a list
 * means a student answers with the next question's stem already half on screen,
 * and the marking happens at the end when the reasoning has gone cold. One
 * question filling the screen, marked the instant it is answered, with the
 * explanation shown right there, is the format that teaches.
 *
 * Answering is final. There is no going back to change an answer, because the
 * explanation for the previous question is already on screen — letting a
 * student return and "fix" it would score something they did not know, and the
 * score is what feeds their revision schedule.
 *
 * The parent hands over an already-ordered list; shuffling happens on the tap
 * that starts the quiz, which is safely after hydration.
 */

interface Props {
  questions: QuizQuestion[];
  classNum: 9 | 10;
  subject: string;
  /** Absent for a mixed quiz across chapters. */
  bookCode?: string;
  chapter?: number;
  scopeLabel: string;
  onExit: () => void;
  /** Start a fresh run over the given questions — retry, or retry mistakes. */
  onRestart: (questions: QuizQuestion[]) => void;
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export default function QuizRunner({
  questions,
  classNum,
  subject,
  bookCode,
  chapter,
  scopeLabel,
  onExit,
  onRestart,
}: Props) {
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<(number | null)[]>(() => questions.map(() => null));
  const [revealed, setRevealed] = useState(false);
  const [finished, setFinished] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  /* Clock starts on the first tap, not on render: `Date.now()` in a render
     body is impure, and "how long the quiz took" honestly means from the first
     answer anyway, not from whenever React happened to mount the component. */
  const startedAt = useRef<number | null>(null);

  const q = questions[index];
  const last = index === questions.length - 1;

  const answers: AnsweredQuestion[] = questions.map((question, i) => ({
    question,
    chosen: chosen[i],
  }));
  const correctCount = answers.filter((a) => a.chosen === a.question.answer).length;

  function answer(option: number) {
    if (revealed) return;
    startedAt.current ??= Date.now();
    setChosen((prev) => prev.map((v, i) => (i === index ? option : v)));
    setRevealed(true);
  }

  function finish(finalChosen: (number | null)[]) {
    setFinished(true);
    const final: AnsweredQuestion[] = questions.map((question, i) => ({
      question,
      chosen: finalChosen[i],
    }));
    // Fire-and-forget: the score is already on screen, and a browser that
    // refuses IndexedDB must still be able to sit a quiz.
    saveQuizResult(final, {
      classNum,
      subject,
      bookCode,
      chapter,
      scopeLabel,
      durationMs: startedAt.current === null ? 0 : Date.now() - startedAt.current,
    }).catch(() => setSaveFailed(true));
  }

  function next() {
    if (last) {
      finish(chosen);
      return;
    }
    setIndex((i) => i + 1);
    setRevealed(false);
  }

  function skip() {
    if (last) {
      finish(chosen);
      return;
    }
    setIndex((i) => i + 1);
    setRevealed(false);
  }

  if (finished) {
    return (
      <QuizResult
        answers={answers}
        correct={correctCount}
        scopeLabel={scopeLabel}
        saveFailed={saveFailed}
        onExit={onExit}
        onRestart={onRestart}
      />
    );
  }

  return (
    <div>
      {/* Progress: the count is what a student checks, the bar is the glance. */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            {scopeLabel}
          </p>
          <p className="text-xs tabular-nums text-ink-soft">
            Question {index + 1} of {questions.length} · {correctCount} right
          </p>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-surface-alt"
          role="progressbar"
          aria-valuenow={index + 1}
          aria-valuemin={1}
          aria-valuemax={questions.length}
          aria-label="Quiz progress"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${((index + 1) / questions.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-medium text-ink-soft">
            {q.difficulty}
          </span>
          <span className="rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-medium text-ink-soft">
            {q.marks} {q.marks === 1 ? "mark" : "marks"}
          </span>
          {q.type === "assertion-reason" && (
            <span className="rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-medium text-ink-soft">
              Assertion &amp; reason
            </span>
          )}
        </div>

        {/* The stem is the screen. It wraps freely and is never clamped: half a
            question is not a question. */}
        <p className="text-[15px] leading-relaxed font-medium break-words">{q.question}</p>

        <div className="mt-4 space-y-2" role="group" aria-label="Answer options">
          {q.options.map((option, i) => {
            const isChosen = chosen[index] === i;
            const isAnswer = i === q.answer;

            // Before answering every option is neutral. After, the right one is
            // always marked — including when the student got it right, so the
            // page reads the same way every time.
            let tone = "border-border bg-surface text-ink hover:border-accent/60";
            if (revealed && isAnswer) tone = "border-accent bg-accent-soft text-accent";
            else if (revealed && isChosen) tone = "border-ink-faint bg-surface-alt text-ink-soft";
            else if (revealed) tone = "border-border bg-surface text-ink-faint";

            return (
              <button
                key={option}
                type="button"
                onClick={() => answer(i)}
                disabled={revealed}
                aria-pressed={isChosen}
                className={`flex w-full min-h-14 items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors disabled:cursor-default ${tone}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${
                    revealed && isAnswer
                      ? "border-accent bg-accent text-accent-ink"
                      : "border-border text-ink-faint"
                  }`}
                >
                  {LETTERS[i] ?? i + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-snug break-words">{option}</span>
                {revealed && isAnswer && (
                  <span className="shrink-0 text-xs font-semibold">Correct</span>
                )}
                {revealed && isChosen && !isAnswer && (
                  <span className="shrink-0 text-xs font-semibold">Your answer</span>
                )}
              </button>
            );
          })}
        </div>

        {revealed && (
          <div className="mt-4 rounded-xl bg-surface-alt p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
              {chosen[index] === q.answer ? "Right" : "Not quite"}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft break-words">
              {q.explanation ??
                `The correct answer is ${LETTERS[q.answer] ?? q.answer + 1}. ${q.options[q.answer]}`}
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onExit}
          className="min-h-12 rounded-xl border border-border px-4 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          Quit
        </button>
        {revealed ? (
          <button
            type="button"
            onClick={next}
            className="min-h-12 flex-1 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
          >
            {last ? "See result" : "Next question"}
          </button>
        ) : (
          <button
            type="button"
            onClick={skip}
            className="min-h-12 flex-1 rounded-xl border border-border px-4 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
          >
            {last ? "Skip and finish" : "Skip"}
          </button>
        )}
      </div>
    </div>
  );
}

/** The score sheet: what was got wrong, and what to do next. */
function QuizResult({
  answers,
  correct,
  scopeLabel,
  saveFailed,
  onExit,
  onRestart,
}: {
  answers: AnsweredQuestion[];
  correct: number;
  scopeLabel: string;
  saveFailed: boolean;
  onExit: () => void;
  onRestart: (questions: QuizQuestion[]) => void;
}) {
  const total = answers.length;
  const pct = total === 0 ? 0 : Math.round((correct / total) * 100);
  const wrong = answers.filter((a) => a.chosen !== a.question.answer);

  // At most one run-up, chosen once when the sheet first renders. Recomputing
  // it on every render would re-roll the offer under the student mid-read, and
  // selectBridge already rate-limits itself against what they have been shown.
  const [offer] = useState(() =>
    selectBridge(
      signalsFromAnswers(
        answers.map((a) => ({
          bookCode: a.question.bookCode,
          chapter: a.question.chapter,
          id: a.question.id,
          correct: a.chosen === a.question.answer,
        })),
      ),
      loadMemory(),
    ),
  );
  const [offerOpen, setOfferOpen] = useState(true);

  return (
    <div>
      <div className="rounded-2xl border border-border bg-surface p-5 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
          {scopeLabel}
        </p>
        <p className="mt-2 text-4xl font-semibold tabular-nums">
          {correct}
          <span className="text-ink-faint"> / {total}</span>
        </p>
        <p className="mt-1 text-sm text-ink-soft">{pct}% correct</p>

        <div className="mx-auto mt-4 h-2 max-w-xs overflow-hidden rounded-full bg-surface-alt">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>

        <p className="mt-4 text-xs text-ink-faint">
          {saveFailed
            ? "This browser is blocking on-device storage, so the result was not saved."
            : wrong.length === 0
              ? "Saved. This chapter has been pushed further down your revision schedule."
              : "Saved. The chapters you struggled with will come back sooner in Revise."}
        </p>
      </div>

      {offer && offerOpen && (
        <div className="mt-4">
          <MicroBridgeOffer offer={offer} onClose={() => setOfferOpen(false)} />
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {wrong.length > 0 && (
          <button
            type="button"
            onClick={() => onRestart(wrong.map((a) => a.question))}
            className="min-h-12 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
          >
            Retry the {wrong.length} you missed
          </button>
        )}
        <button
          type="button"
          onClick={() => onRestart(answers.map((a) => a.question))}
          className="min-h-12 rounded-xl border border-border px-4 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
        >
          Take it again
        </button>
        <button
          type="button"
          onClick={onExit}
          className="min-h-12 rounded-xl border border-border px-4 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent sm:col-span-2"
        >
          Back to chapters
        </button>
      </div>

      <h3 className="mt-8 mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
        Every question
      </h3>
      <ol className="space-y-3">
        {answers.map((a, i) => {
          const right = a.chosen === a.question.answer;
          return (
            <li key={a.question.id} className="rounded-2xl border border-border bg-surface p-4">
              <div className="flex items-start gap-3">
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                    right ? "bg-accent-soft text-accent" : "bg-surface-alt text-ink-soft"
                  }`}
                >
                  {i + 1}
                </span>
                <p className="min-w-0 flex-1 text-sm leading-snug font-medium break-words">
                  {a.question.question}
                </p>
              </div>
              <p className="mt-2 pl-9 text-xs text-ink-soft break-words">
                {right ? (
                  <>Correct — {a.question.options[a.question.answer]}</>
                ) : (
                  <>
                    {a.chosen === null ? "Skipped" : `You chose ${a.question.options[a.chosen]}`} ·
                    Correct answer: {a.question.options[a.question.answer]}
                  </>
                )}
              </p>
              {!right && a.question.explanation && (
                <p className="mt-1 pl-9 text-xs leading-relaxed text-ink-faint break-words">
                  {a.question.explanation}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
