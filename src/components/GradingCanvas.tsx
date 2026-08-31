"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RubricChecklist, {
  type Checklist,
  type CriterionVerdict,
  type DraftVerdict,
} from "@/components/RubricChecklist";
import VoiceNoteRecorder, { type VoiceNote } from "@/components/VoiceNoteRecorder";

/**
 * The integrated grading canvas: the student's scan on the left with sketch
 * annotation, the marking scheme on the right.
 *
 * ## One component, every evaluator
 *
 * There is no `if (evaluatorType === …)` in this file, and there is not going to
 * be one. The PRD asks that "the grading interface must be identical for
 * internal tutors and school teachers", and the way that stops being true is
 * not a deliberate fork — it is one conditional that hides a panel from
 * freelancers, then another, until the two paths need testing separately and
 * only one of them gets it. A role changes `permissions` — what you may *do* —
 * and never the layout. A read-only viewer sees the marks and the boxes in
 * exactly the places a marking one does, with the controls disabled.
 *
 * ## Two kinds of ink, and only one of them is a grade
 *
 * - **Boxes** are `HighlightSpan` rows: green, orange or red, tied to one rubric
 *   line, stored as fractions of the page rather than pixels because the phone
 *   picks the capture resolution and the viewer picks the zoom. They are
 *   evidence, they are what the student sees over their own handwriting, and
 *   they are appended with the grade.
 * - **Pen strokes** are working ink. `prisma/schema.prisma` has no table for
 *   freehand geometry — `HighlightSpan` is a rectangle and nothing else — and
 *   the schema is frozen, so a stroke lives in this tab and nowhere else. The
 *   toolbar says so rather than implying a save that cannot happen. Persisting
 *   ink needs a schema change; see the lane report.
 *
 * ## Unmarked paints nothing
 *
 * The box tool refuses to draw for a criterion the evaluator has set to
 * UNMARKED. `HighlightSpan.color` is NOT NULL over exactly GREEN/ORANGE/RED so
 * that no renderer can fall back to a default for the fourth outcome — and the
 * default it would reach for, on a criterion that awarded nothing, is red. Red
 * is the accusation the unmarked outcome exists to prevent.
 *
 * The per-question working state lives in `AnswerWorkspace`, which is keyed on
 * the answer id. Changing question remounts it, so there is no effect resetting
 * six pieces of state and no way for one question's boxes to survive onto
 * another's page.
 */

// ---------------------------------------------------------------------------
// The payload from GET /api/tickets/{id}/
// ---------------------------------------------------------------------------

export interface CanvasPage {
  id: string;
  pageIndex: number;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  url: string;
}

export interface GradeChainEntry {
  id: string;
  revision: number;
  source: "AI" | "HUMAN";
  awardedMarks: number;
  maxMarks: number;
  unmarkedCount: number;
  comment: string | null;
  confidence: number | null;
  modelName: string | null;
  evaluatorName: string | null;
  createdAt: string;
  current: boolean;
}

export interface CanvasAnswer {
  id: string;
  questionNumber: number;
  maxMarks: number;
  type: string;
  transcript: string | null;
  pageIds: string[];
  checklist: Checklist;
  grades: GradeChainEntry[];
  voiceNotes: VoiceNote[];
}

export interface CanvasPermissions {
  canAnnotate: boolean;
  canGrade: boolean;
  canRecordVoiceNote: boolean;
  canRelease: boolean;
  readOnlyReason: string | null;
}

export interface CanvasPayload {
  ticket: {
    id: string;
    subject: string;
    classNum: number;
    status: string;
    leaseExpiresAt: string | null;
  };
  submission: { id: string; paperSlug: string | null; subject: string; classNum: number };
  pages: CanvasPage[];
  answers: CanvasAnswer[];
  review: { id: string } | null;
  permissions: CanvasPermissions;
  transcription: { provider: string | null; available: boolean };
}

interface Box {
  key: string;
  rubricCriterionId: string;
  submissionPageId: string;
  color: "GREEN" | "ORANGE" | "RED";
  x: number;
  y: number;
  width: number;
  height: number;
  label: string | null;
  /** False for a box the evaluator has drawn and not yet saved. */
  saved: boolean;
}

interface Stroke {
  submissionPageId: string;
  points: { x: number; y: number }[];
}

type Tool = "box" | "pen" | "pan";

const COLOR_FOR: Record<CriterionVerdict, "GREEN" | "ORANGE" | "RED" | null> = {
  HIT: "GREEN",
  PARTIAL: "ORANGE",
  MISS: "RED",
  UNMARKED: null,
};

const BOX_STYLE: Record<"GREEN" | "ORANGE" | "RED", string> = {
  GREEN: "stroke-emerald-500 fill-emerald-500/15",
  ORANGE: "stroke-amber-500 fill-amber-500/15",
  RED: "stroke-rose-500 fill-rose-500/15",
};

// ---------------------------------------------------------------------------

export default function GradingCanvas({
  payload,
  onSaved,
}: {
  payload: CanvasPayload;
  onSaved: (answerId: string) => void;
}) {
  const [answerId, setAnswerId] = useState(payload.answers[0]?.id ?? "");
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>(() =>
    payload.answers.flatMap((a) => a.voiceNotes),
  );
  const [leaseExpiresAt, setLeaseExpiresAt] = useState(payload.ticket.leaseExpiresAt);

  const answer = payload.answers.find((a) => a.id === answerId) ?? payload.answers[0];

  // The lease, extended while the evaluator is demonstrably still here. Not a
  // heartbeat: if this tab goes away the lease runs out and the sweeper puts the
  // ticket back, which is the whole reason there is no presence service.
  const ticketId = payload.ticket.id;
  const canGrade = payload.permissions.canGrade;
  useEffect(() => {
    if (!canGrade) return;
    const id = setInterval(
      () => {
        void (async () => {
          try {
            const res = await fetch(`/api/tickets/${ticketId}/lease/`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({}),
            });
            if (!res.ok) return;
            const json = await res.json();
            if (json?.leaseExpiresAt) setLeaseExpiresAt(json.leaseExpiresAt);
          } catch {
            // A missed extension is not worth reporting: the next one is in
            // five minutes and the lease is fifteen.
          }
        })();
      },
      5 * 60 * 1000,
    );
    return () => clearInterval(id);
  }, [canGrade, ticketId]);

  if (!answer) {
    return <p className="p-6 text-sm text-ink-soft">This submission has no answers to mark.</p>;
  }

  return (
    <AnswerWorkspace
      // Keyed, so changing question throws away every piece of working state
      // rather than an effect trying to remember which pieces to reset.
      key={answer.id}
      answer={answer}
      answers={payload.answers}
      onSelectAnswer={setAnswerId}
      pages={payload.pages}
      permissions={payload.permissions}
      reviewId={payload.review?.id ?? null}
      transcriptionAvailable={payload.transcription.available}
      voiceNotes={voiceNotes}
      onVoiceNote={(n) => setVoiceNotes((v) => [...v, n])}
      leaseExpiresAt={leaseExpiresAt}
      onSaved={onSaved}
    />
  );
}

// ---------------------------------------------------------------------------

function AnswerWorkspace({
  answer,
  answers,
  onSelectAnswer,
  pages,
  permissions,
  reviewId,
  transcriptionAvailable,
  voiceNotes,
  onVoiceNote,
  leaseExpiresAt,
  onSaved,
}: {
  answer: CanvasAnswer;
  answers: CanvasAnswer[];
  onSelectAnswer: (id: string) => void;
  pages: CanvasPage[];
  permissions: CanvasPermissions;
  reviewId: string | null;
  transcriptionAvailable: boolean;
  voiceNotes: VoiceNote[];
  onVoiceNote: (note: VoiceNote) => void;
  leaseExpiresAt: string | null;
  onSaved: (answerId: string) => void;
}) {
  const answerPages = useMemo(() => {
    const wanted = new Set(answer.pageIds);
    const scoped = pages.filter((p) => wanted.has(p.id));
    // An answer with no page mapping still has to be markable — showing the
    // whole script beats showing nothing.
    return scoped.length ? scoped : pages;
  }, [answer.pageIds, pages]);

  const [pageId, setPageId] = useState(answerPages[0]?.id ?? "");
  const [tool, setTool] = useState<Tool>("box");
  const [draft, setDraft] = useState<Record<string, DraftVerdict>>({});
  const [activeCriterionId, setActiveCriterionId] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const page = answerPages.find((p) => p.id === pageId) ?? answerPages[0];

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );

  const activeVerdict: CriterionVerdict | null = activeCriterionId
    ? (draft[activeCriterionId]?.verdict ??
      answer.checklist.items.find((i) => i.rubricCriterionId === activeCriterionId)?.verdict ??
      null)
    : null;
  const activeColor = activeVerdict ? COLOR_FOR[activeVerdict] : null;
  const canDrawBox =
    permissions.canAnnotate && tool === "box" && activeCriterionId !== null && activeColor !== null;

  const fractionAt = useCallback((e: React.PointerEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (!page) return;
    const at = fractionAt(e);
    if (!at) return;
    if (tool === "pen" && permissions.canAnnotate) {
      setStrokes((s) => [...s, { submissionPageId: page.id, points: [at] }]);
      dragRef.current = at;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (!canDrawBox) return;
    dragRef.current = at;
    setDragBox({ x: at.x, y: at.y, w: 0, h: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const from = dragRef.current;
    if (!from || !page) return;
    const at = fractionAt(e);
    if (!at) return;
    if (tool === "pen") {
      setStrokes((s) => {
        if (!s.length) return s;
        const next = s.slice();
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, points: [...last.points, at] };
        return next;
      });
      return;
    }
    setDragBox({
      x: Math.min(from.x, at.x),
      y: Math.min(from.y, at.y),
      w: Math.abs(at.x - from.x),
      h: Math.abs(at.y - from.y),
    });
  }

  function onPointerUp() {
    const box = dragBox;
    dragRef.current = null;
    setDragBox(null);
    if (!box || !page || !activeCriterionId || !activeColor) return;
    // A tap is not a box. `highlight_box_normalised` demands a positive size,
    // and a zero-width rectangle over a student's handwriting means nothing.
    if (box.w < 0.01 || box.h < 0.01) return;
    setBoxes((b) => [
      ...b,
      {
        key: `${Date.now()}-${b.length}`,
        rubricCriterionId: activeCriterionId,
        submissionPageId: page.id,
        color: activeColor,
        x: Number(box.x.toFixed(5)),
        y: Number(box.y.toFixed(5)),
        width: Number(box.w.toFixed(5)),
        height: Number(box.h.toFixed(5)),
        label: null,
        saved: false,
      },
    ]);
  }

  // A criterion moved to UNMARKED loses its boxes: an unmarked line paints
  // nothing, and a stale orange rectangle would be saved as a contradiction the
  // database would then refuse.
  const setVerdict = useCallback((criterionId: string, next: DraftVerdict | null) => {
    setDraft((d) => {
      const copy = { ...d };
      if (next === null) delete copy[criterionId];
      else copy[criterionId] = next;
      return copy;
    });
    if (next === null || next.verdict === "UNMARKED") {
      setBoxes((b) => b.filter((box) => box.rubricCriterionId !== criterionId));
    }
  }, []);

  const currentRevision = answer.grades.length
    ? answer.grades[answer.grades.length - 1].revision
    : 0;

  async function save() {
    if (!reviewId) return;
    setSaving(true);
    setMessage(null);
    try {
      // Every criterion, not only the changed ones: a `GradingResult`'s
      // criterion results are written fresh and never shared with the revision
      // it supersedes, which is what makes an override auditable line by line
      // rather than only in total.
      const criteria = answer.checklist.items.map((item) => {
        const d = draft[item.rubricCriterionId];
        // An untouched, never-graded line is honestly UNMARKED. Defaulting it to
        // MISS would paint red over work nobody looked at.
        const verdict: CriterionVerdict = d?.verdict ?? item.verdict ?? "UNMARKED";
        const unmarkedReason =
          verdict === "UNMARKED"
            ? (d?.unmarkedReason ??
              item.unmarkedReason ??
              (item.autoGradable ? "RUBRIC_NEEDS_REVIEW" : "NOT_AUTO_GRADABLE"))
            : undefined;
        return {
          rubricCriterionId: item.rubricCriterionId,
          verdict,
          awarded:
            verdict === "UNMARKED" || verdict === "MISS" ? 0 : (d?.awarded ?? item.awarded ?? 0),
          partialRuleId: verdict === "PARTIAL" ? (d?.partialRuleId ?? undefined) : undefined,
          unmarkedReason,
          note: d?.note ?? item.note ?? undefined,
          highlights:
            verdict === "UNMARKED"
              ? []
              : boxes
                  .filter((b) => b.rubricCriterionId === item.rubricCriterionId)
                  .map((b) => ({
                    submissionPageId: b.submissionPageId,
                    color: b.color,
                    x: b.x,
                    y: b.y,
                    width: b.width,
                    height: b.height,
                    label: b.label ?? undefined,
                  })),
        };
      });

      // Trailing slash. Without it the POST 308s and arrives with no body.
      const res = await fetch(`/api/reviews/${reviewId}/grade/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answerId: answer.id,
          expectedRevision: currentRevision,
          comment: comment.trim() || undefined,
          criteria,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? "Could not save.");
      setBoxes((b) => b.map((box) => ({ ...box, saved: true })));
      setMessage(`Saved as revision ${json.revision}.`);
      onSaved(answer.id);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  if (!page) {
    return <p className="p-6 text-sm text-ink-soft">This submission has no pages to mark.</p>;
  }

  const visibleBoxes = boxes.filter((b) => b.submissionPageId === page.id);
  const visibleStrokes = strokes.filter((s) => s.submissionPageId === page.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* ---------------- left: the student's work ---------------- */}
      <div className="flex min-h-0 flex-1 flex-col border-b border-border lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <label className="text-xs text-ink-soft">
            Question
            <select
              value={answer.id}
              onChange={(e) => onSelectAnswer(e.target.value)}
              className="ml-1.5 min-h-11 rounded-md border border-border bg-surface px-2 text-sm text-ink"
            >
              {answers.map((a) => (
                <option key={a.id} value={a.id}>
                  Q{a.questionNumber} ({a.maxMarks})
                </option>
              ))}
            </select>
          </label>

          <div className="flex gap-1" role="group" aria-label="Annotation tool">
            {(["box", "pen", "pan"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTool(t)}
                disabled={!permissions.canAnnotate && t !== "pan"}
                className={`min-h-11 rounded-md border px-3 text-sm capitalize disabled:opacity-40 ${
                  tool === t
                    ? "border-accent bg-accent-soft text-ink"
                    : "border-border bg-surface text-ink-soft"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {answerPages.length > 1 && (
            <div className="flex gap-1">
              {answerPages.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPageId(p.id)}
                  className={`min-h-11 min-w-11 rounded-md border px-2 text-sm tabular-nums ${
                    p.id === page.id
                      ? "border-accent bg-accent-soft"
                      : "border-border bg-surface text-ink-soft"
                  }`}
                >
                  {p.pageIndex + 1}
                </button>
              ))}
            </div>
          )}

          <span className="ml-auto text-xs text-ink-faint">
            {leaseExpiresAt
              ? `Held until ${new Date(leaseExpiresAt).toLocaleTimeString()}`
              : "Not held"}
          </span>
        </div>

        {tool === "pen" && (
          <p className="border-b border-border bg-surface-alt px-3 py-1.5 text-xs text-ink-soft">
            Pen strokes are working ink for your own eye. They are not saved and the student never
            sees them — only boxes tied to a marking-scheme line are stored.
          </p>
        )}
        {tool === "box" && !canDrawBox && permissions.canAnnotate && (
          <p className="border-b border-border bg-surface-alt px-3 py-1.5 text-xs text-ink-soft">
            {activeCriterionId === null
              ? "Pick a line from the marking scheme on the right, then draw over the working it refers to."
              : "That line is unmarked, so nothing is drawn over the student's work. Give it a verdict to box it."}
          </p>
        )}
        {permissions.readOnlyReason && (
          <p className="border-b border-border bg-surface-alt px-3 py-1.5 text-xs text-ink-soft">
            {permissions.readOnlyReason}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto bg-surface-alt p-3">
          <div
            ref={surfaceRef}
            className="relative mx-auto w-full max-w-3xl touch-none select-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ cursor: canDrawBox || tool === "pen" ? "crosshair" : "default" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={page.url}
              alt={`Page ${page.pageIndex + 1} of the student's answer sheet`}
              className="block w-full rounded-md border border-border bg-surface"
              draggable={false}
            />
            <svg
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-hidden
            >
              {visibleBoxes.map((b) => (
                <rect
                  key={b.key}
                  x={b.x}
                  y={b.y}
                  width={b.width}
                  height={b.height}
                  className={BOX_STYLE[b.color]}
                  strokeWidth={0.004}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray={b.saved ? undefined : "0.01 0.008"}
                />
              ))}
              {dragBox && activeColor && (
                <rect
                  x={dragBox.x}
                  y={dragBox.y}
                  width={dragBox.w}
                  height={dragBox.h}
                  className={BOX_STYLE[activeColor]}
                  strokeWidth={0.004}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {visibleStrokes.map((s, i) => (
                <polyline
                  key={i}
                  points={s.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  className="fill-none stroke-sky-500"
                  strokeWidth={0.005}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
          </div>

          {answer.transcript && (
            <details className="mx-auto mt-3 max-w-3xl rounded-md border border-border bg-surface p-3 text-sm">
              <summary className="cursor-pointer text-ink-soft">What OCR read</summary>
              <p className="mt-2 whitespace-pre-wrap text-ink-soft">{answer.transcript}</p>
            </details>
          )}
        </div>
      </div>

      {/* ---------------- right: the marking scheme ---------------- */}
      <div className="flex min-h-0 w-full flex-col lg:w-[26rem] lg:shrink-0">
        <GradeChain grades={answer.grades} />

        <div className="min-h-0 flex-1 overflow-hidden">
          <RubricChecklist
            checklist={answer.checklist}
            draft={draft}
            onChange={setVerdict}
            readOnly={!permissions.canGrade}
            activeCriterionId={activeCriterionId}
            onFocusCriterion={setActiveCriterionId}
          />
        </div>

        <VoiceNoteRecorder
          reviewId={reviewId ?? ""}
          answerId={answer.id}
          questionNumber={answer.questionNumber}
          notes={voiceNotes}
          transcriptionAvailable={transcriptionAvailable}
          transcriptionMessage={null}
          disabled={!permissions.canRecordVoiceNote || !reviewId}
          onUploaded={onVoiceNote}
        />

        <div className="border-t border-border px-4 py-3">
          <label className="block text-xs text-ink-soft">
            Written feedback
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              disabled={!permissions.canGrade}
              placeholder="Shown to the student under the marks."
              className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-2 text-sm text-ink disabled:opacity-40"
            />
          </label>
          {message && <p className="mt-2 text-sm text-ink-soft">{message}</p>}
          <button
            type="button"
            onClick={save}
            disabled={saving || !permissions.canGrade || !reviewId}
            className="mt-2 min-h-11 w-full rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-40"
          >
            {saving
              ? "Saving…"
              : `Save Q${answer.questionNumber} as revision ${currentRevision + 1}`}
          </button>
          <p className="mt-1.5 text-xs text-ink-faint">
            Saving appends a new verdict. The one before it is kept and shown to the student beside
            yours — nothing is overwritten.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * "AI: 3/5 → your teacher: 4/5". The chain, not the head, because the fact that
 * a person disagreed with the model is itself the thing worth showing.
 */
function GradeChain({ grades }: { grades: GradeChainEntry[] }) {
  if (!grades.length) {
    return (
      <p className="border-b border-border px-4 py-2 text-xs text-ink-soft">
        Not graded yet. Yours will be revision 1.
      </p>
    );
  }
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2 text-xs">
      {grades.map((g, i) => (
        <li key={g.id} className="flex items-center gap-2">
          {i > 0 && (
            <span aria-hidden className="text-ink-faint">
              →
            </span>
          )}
          <span className={g.current ? "font-semibold text-ink" : "text-ink-faint"}>
            {g.source === "AI" ? "AI" : (g.evaluatorName ?? "Teacher")}: {g.awardedMarks}/
            {g.maxMarks}
            {g.unmarkedCount > 0 && (
              <span className="ml-1 text-ink-faint">({g.unmarkedCount} unmarked)</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
