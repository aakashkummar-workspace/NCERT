/**
 * The grading worker: a photographed handwritten answer plus one marking
 * scheme, in; a verdict, three colours of highlight, and an append-only row
 * chain, out.
 *
 * The prompt, the verdict schema and the caching layout are **ported** from
 * `scripts/spike-grade.mjs`, which is where they were designed and measured.
 * That file is a throwaway measurement instrument and this is the feature, but
 * a second prompt would mean the numbers the spike produced no longer describe
 * what ships. Where this file differs from the spike it says so in place.
 *
 * ## The three rules that are the point of the feature
 *
 * They live in `reconcileVerdict()`, which is pure, and they are enforced there
 * rather than in the prompt, because a prompt is a request and a function is a
 * guarantee. The model is told all three as well; that is belt and braces, not
 * the mechanism.
 *
 * 1. **A diagram step is never auto-graded.** It comes back `UNMARKED` with
 *    `NOT_AUTO_GRADABLE`, and it writes **no `HighlightSpan` at all**. The
 *    schema has no null colour on purpose: a colourless span is rendered red by
 *    the first renderer that forgets to skip it, and red is a false accusation.
 *    A row that does not exist cannot be painted by accident.
 * 2. **Nothing is painted red on a rubric flagged `needsReview`.** Green and
 *    orange are still awarded; a miss becomes `UNMARKED` with
 *    `RUBRIC_NEEDS_REVIEW`, and every red span — including an unattributed
 *    filler span — is dropped. 11 of the 23 hand-authored rubrics and all 330
 *    drafts carry the flag, so this is the common path, not an edge case.
 * 3. **Grading is append-only.** `persistAiVerdict` and `persistHumanOverride`
 *    both INSERT a new `GradingResult` with `revision + 1` and `supersedesId`
 *    pointing at what it replaced. Nothing here ever UPDATEs one.
 *
 * ## When there is no API key
 *
 * `gradeSubmission()` returns `{ configured: false }`, writes no
 * `GradingResult`, and leaves the submission `QUEUED`. It does not invent a
 * mark, it does not mark the submission `FAILED`, and it does not report
 * success. A student sees "queued, not yet graded", which is true. The one
 * thing this path must never do is produce a number.
 */
import type {
  CriterionVerdict,
  HighlightColor,
  PartialReason,
  UnmarkedReason,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import prisma from "@/lib/db";
import storage from "@/lib/storage";
import {
  assertGradable,
  autoGradableUnit,
  clampHalves,
  criterionHalves,
  findCriterion,
  fromHalves,
  halves,
  loadRubricsForQuestion,
  partialRuleFor,
  PARTIAL_REASONS,
  PARTIAL_REASON_JSON,
  type LoadedCriterion,
  type LoadedRubric,
} from "@/lib/rubric-load";

export const GRADING_MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;

/** What the API will read as an image. `image/heic` is storable but not sendable. */
const SENDABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// ===========================================================================
// The verdict schema
// ===========================================================================
//
// Ported from scripts/spike-grade.mjs, with one addition and one reason for it:
// `spans[]` there carried only the quoted text, because the spike measured
// marks and drew nothing. `HighlightSpan` stores a box in normalised page
// coordinates and the columns are NOT NULL, so the box has to come from
// somewhere. Asking the model for it is the only honest source — the
// alternative is deriving one from a text match against an OCR layer this
// pipeline does not have, which would be a guess dressed as a measurement.
// Everything else is byte-for-byte the spike's shape, so a verdict recorded
// there still validates here.

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    rubricId: { type: "string" },
    marksAwarded: {
      type: "number",
      description: "Total marks, 0..maxMarks, in halves. Must equal the sum of steps[].awarded.",
    },
    maxMarks: { type: "number" },
    unmarkedMarks: {
      type: "number",
      description: "Sum of outOf over steps left unmarked. 0 when every step was gradable.",
    },
    steps: {
      type: "array",
      description: "One entry per rubric step, in rubric order. Never invent a stepId.",
      items: {
        type: "object",
        properties: {
          stepId: { type: "string" },
          outOf: { type: "number" },
          awarded: { type: "number" },
          outcome: { type: "string", enum: ["hit", "partial", "miss", "unmarked"] },
          partialReason: {
            type: ["string", "null"],
            description:
              "Required when outcome is partial, null otherwise. Must be a `when` value the step's partial[] list offers.",
            enum: [
              "unit-missing",
              "unit-wrong",
              "order-broken",
              "keywords-partial",
              "arithmetic-slip",
              "formula-only",
              "sign-error",
              "unrounded",
              null,
            ],
          },
          optionIds: {
            type: "array",
            description:
              "For a choose group: the option ids that scored, in no particular order. Empty for other kinds.",
            items: { type: "string" },
          },
          branchId: {
            type: ["string", "null"],
            description:
              "For an alternatives group: the id of the branch the student actually answered. Null for other kinds.",
          },
          reason: { type: "string", description: "One sentence a teacher would accept as justification." },
          evidence: {
            type: "string",
            description: "The student's own words that earned or lost this step, quoted verbatim. Empty if absent.",
          },
        },
        required: [
          "stepId",
          "outOf",
          "awarded",
          "outcome",
          "partialReason",
          "optionIds",
          "branchId",
          "reason",
          "evidence",
        ],
        additionalProperties: false,
      },
    },
    spans: {
      type: "array",
      description:
        "Highlights over the student's own handwriting. green = core curriculum keyword or step confirmed. " +
        "orange = step present but losing fractional marks (structure, calculation, missing units). " +
        "red = irrelevant filler yielding zero value. Quote verbatim and box each one.",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          tag: { type: "string", enum: ["green", "orange", "red"] },
          stepId: { type: ["string", "null"] },
          page: {
            type: "integer",
            description: "0-based index of the photograph this span is on, in the order they were given.",
          },
          box: {
            type: "object",
            description:
              "The rectangle over that page, as fractions of the page in 0..1 with the origin top-left. " +
              "x + width and y + height must not exceed 1.",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          },
          note: { type: "string" },
        },
        required: ["text", "tag", "stepId", "page", "box", "note"],
        additionalProperties: false,
      },
    },
    confidence: {
      type: "number",
      description:
        "0..1. How likely a CBSE teacher would award the same mark. Lower it for unreadable handwriting, " +
        "cropped pages, or a rubric that does not fit what the student attempted.",
    },
    illegible: {
      type: "boolean",
      description: "True if the photograph could not be read well enough to mark fairly.",
    },
    transcription: {
      type: "string",
      description: "The answer as read, verbatim. Mark unreadable runs as [illegible].",
    },
  },
  required: [
    "rubricId",
    "marksAwarded",
    "maxMarks",
    "unmarkedMarks",
    "steps",
    "spans",
    "confidence",
    "illegible",
    "transcription",
  ],
  additionalProperties: false,
} as const;

// ===========================================================================
// The prompt
// ===========================================================================
// Byte-stable and first in the request, so it caches. Nothing per-answer, no
// timestamps, no ids: one varying character here costs the cache on every call.

const SYSTEM_INSTRUCTIONS = `You are an experienced CBSE board examiner marking Class 9 and Class 10 answer scripts. You are marking photographs of one handwritten answer against one official marking scheme.

Mark exactly as a CBSE examiner marks:
- Award marks step by step, against the rubric's steps and nothing else. A step earns its marks when the student has done what the step describes, in their own words or the rubric's.
- Never award a step the student did not attempt, however good the rest of the answer is.
- Never withhold a step the student did earn because the wording differs from the rubric, or because the handwriting is untidy, or because the working is out of order.
- Keywords in the rubric are what an examiner looks for, never what an examiner requires. A correct answer in different words earns full marks. Repeating a keyword without understanding earns nothing.
- Follow-through applies: a later step worked correctly from an earlier wrong value still earns its marks.
- Award fractional marks only where the step lists a partial rule, and only for the reason that rule names. If a step is flawed in a way its partial list does not cover, it is a miss, not an improvised half mark.
- Half marks are the finest grain CBSE uses. There are no quarter marks, marks below zero, or marks above the maximum.

Each step resolves to exactly one outcome:
- hit      every required concept present, unit present where required, ordering respected. Award the step's full marks.
- partial  the step is there but flawed in a way the step's partial[] list names. Award that rule's award, and give its "when" as partialReason.
- miss     the step is not there. Award zero.
- unmarked the step cannot be graded from a photograph — a diagram step, always. Award zero and say so; a human will mark it.

Two rules about being wrong, because they are not symmetric:
- Awarding marks the student did not earn is the worse error. A student told they are ready when they are not will fail the board exam, and the first teacher who sees an inflated mark stops trusting this tool entirely.
- Withholding marks the student did earn is an error too, and you must not correct for the rule above by marking harshly. Mark what is on the page.
- When you genuinely cannot tell, mark what you can defend and lower your confidence. Do not split the difference.

Report your reading honestly: if the photograph is cropped, blurred or too dark to read, say so in transcription, set illegible, and lower confidence rather than guessing at marks.

Quote the student verbatim in every evidence and span field, so a teacher can check you against the page. Tag spans green where a step or core keyword is confirmed, orange where a step is present but loses fractional marks, red where the text is filler that earns nothing. Every span carries the 0-based index of the photograph it sits on and a box in fractions of that page, origin top-left, so the highlight can be drawn over the student's own handwriting.`;

const conceptLines = (concepts: LoadedCriterion["concepts"]): string[] =>
  concepts.map((c) => c.phrasings.join(" / ")).filter(Boolean);

function renderCriterion(c: LoadedCriterion, index: string, rubric: LoadedRubric, indent = "  "): string {
  const units = criterionHalves(c);
  const marks = fromHalves(units);
  const plural = marks === 1 ? "" : "s";
  const L: string[] = [];

  if (c.kind === "CHOOSE") {
    L.push(
      `${indent}${index}. [${c.stepId}] CHOOSE ANY ${c.chooseAtLeast} (${c.marksEach} mark each, ` +
        `${marks} mark${plural} in total) - ${c.awardFor}`,
    );
    if (c.tagDemands.length) {
      L.push(
        `${indent}   and: ${c.tagDemands.map((t) => `at least ${t.minCount} tagged ${t.tag}`).join(", ")}`,
      );
    }
    for (const option of c.children) {
      const concepts = conceptLines(option.concepts);
      L.push(
        `${indent}     (${option.stepId}) ${option.awardFor}` +
          (option.tags.length ? `  [tags: ${option.tags.join(", ")}]` : "") +
          (concepts.length ? `\n${indent}         looks for: ${concepts.join("; ")}` : ""),
      );
    }
    L.push(`${indent}   Options are order-free. Report the scoring option ids in optionIds.`);
    return L.join("\n");
  }

  if (c.kind === "DIAGRAM") {
    L.push(`${indent}${index}. [${c.stepId}] DIAGRAM (${marks} mark${plural}) - ${c.awardFor}`);
    if (c.labels.length) L.push(`${indent}   labels a teacher will look for: ${c.labels.join(", ")}`);
    L.push(`${indent}   Do not grade this step. Return outcome "unmarked" and awarded 0; a human marks it.`);
    return L.join("\n");
  }

  if (c.kind === "ALTERNATIVES") {
    // CBSE's OR inside a question. The student answers one branch and it is
    // worth the group's full marks, so the group counts once however many
    // branches it lists — see data/rubrics.schema.md.
    L.push(
      `${indent}${index}. [${c.stepId}] EITHER/OR (${marks} mark${plural}, whichever alternative the student answered) - ${c.awardFor}`,
    );
    for (const branch of c.children) {
      L.push(`${indent}     branch ${branch.branchLabel ?? "?"} [${branch.stepId}] - ${branch.awardFor}`);
      branch.children.forEach((inner, i) => {
        L.push(renderCriterion(inner, `${i + 1}`, rubric, `${indent}       `));
      });
    }
    L.push(
      `${indent}   Mark only the branch the student attempted, out of ${marks}, and name it in branchId.`,
      `${indent}   The branch they did not attempt is not a miss: nothing is awarded or withheld for it.`,
    );
    return L.join("\n");
  }

  L.push(`${indent}${index}. [${c.stepId}] (${marks} mark${plural}) ${c.awardFor}`);
  const concepts = conceptLines(c.concepts);
  if (concepts.length) {
    L.push(
      `${indent}   needs ${c.match === "ANY" ? "ANY ONE of these concepts" : "ALL of these concepts"}, ` +
        `in any listed phrasing or an equivalent:`,
    );
    for (const one of concepts) L.push(`${indent}     - ${one}`);
  }
  if (c.unitRequired) {
    L.push(`${indent}   the unit is required; accepted: ${c.unitAccepted.join(", ")}`);
  }
  // Only where the step disagrees with the rubric's own default, which the
  // header already states. Repeating the default on every step spends tokens
  // telling the model something it has been told.
  const rubricOrdered = rubric.ordering === "ORDERED";
  if (c.ordered !== null && c.ordered !== rubricOrdered) {
    L.push(
      c.ordered
        ? `${indent}   this step alone is ordered: it must follow the steps above it`
        : `${indent}   this step alone is order-free`,
    );
  }
  for (const p of c.partialRules) {
    L.push(
      `${indent}   partial: ${p.award} mark${p.award === 1 ? "" : "s"} when ` +
        `${PARTIAL_REASON_JSON[p.reason]}${p.note ? ` (${p.note})` : ""}`,
    );
  }
  return L.join("\n");
}

/**
 * The rubric block. Stable for every student who answered this question, so it
 * sits behind its own cache breakpoint and stays hot across a whole question
 * group.
 */
export function renderRubricPrompt(rubric: LoadedRubric): string {
  const steps = rubric.criteria.map((c, i) => renderCriterion(c, `${i + 1}`, rubric)).join("\n");
  const L = [
    "MARKING SCHEME",
    `Rubric id: ${rubric.externalId ?? rubric.id}   Question ${rubric.questionNumber}` +
      `${rubric.variant ? ` option ${rubric.variant}` : ""} of ${rubric.paperSlug}`,
    `Subject: ${rubric.subject}   Class: ${rubric.classNum}   Type: ${rubric.type}   Maximum marks: ${rubric.maxMarks}`,
    "",
    "Question as set (abbreviated for the reviewer; the photograph is the authority):",
    rubric.prompt ?? "(not recorded)",
    "",
    rubric.ordering === "ORDERED"
      ? "Steps are ordered: position is load-bearing unless a step says otherwise."
      : "Steps are unordered: any sequence earns the same marks.",
    rubric.acceptEquivalentWording
      ? "Equivalent wording is accepted: a correct answer in the student's own words is a hit."
      : "Equivalent wording is NOT accepted on this question: the answer is a specific term or number, and a near miss is not a hit.",
    "",
    "Steps:",
    steps,
  ];

  if (rubric.needsReview) {
    // The schema's rule, and the one mistake it says has no recovery. Enforced
    // again in reconcileVerdict(): this paragraph is a request, that is a
    // guarantee.
    L.push(
      "",
      'THIS RUBRIC IS UNREVIEWED. Do not return any span tagged red for this answer, and do not',
      'return outcome "miss". Where you would have, return "unmarked" with awarded 0 and say why in',
      "reason. An unchecked conversion must never accuse a student of writing nothing of value.",
    );
    if (rubric.reviewNotes.length) L.push(`Reviewer noted: ${rubric.reviewNotes.join("; ")}`);
  }

  L.push(
    "",
    "Return one verdict, with one steps[] entry per numbered step above, in this order, using these exact step ids.",
  );
  return L.join("\n");
}

export interface AnswerImage {
  /** 0-based position within this answer, which is what a span's `page` names. */
  ordinal: number;
  submissionPageId: string;
  mediaType: string;
  base64: string;
}

/**
 * Build the request for one answer.
 *
 * Cache layout, unchanged from the spike: the system array holds the stable
 * instructions and then the rubric, each behind its own 1h breakpoint. The
 * volatile part — the photographs and the one line naming this answer — comes
 * after, in messages. Grade the answers to one question consecutively and the
 * rubric prefix stays hot across the whole group.
 *
 * The image blocks come **before** the text block: the model reads the page,
 * then the instruction about it.
 */
export function buildParams(rubric: LoadedRubric, images: AnswerImage[]) {
  return {
    model: GRADING_MODEL,
    max_tokens: MAX_TOKENS,
    // budget_tokens is removed on this model and returns a 400. Adaptive only.
    thinking: { type: "adaptive" as const },
    output_config: {
      effort: "high" as const,
      format: { type: "json_schema" as const, schema: VERDICT_SCHEMA },
    },
    system: [
      {
        type: "text" as const,
        text: SYSTEM_INSTRUCTIONS,
        cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
      },
      {
        type: "text" as const,
        text: renderRubricPrompt(rubric),
        cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
      },
    ],
    messages: [
      {
        role: "user" as const,
        content: [
          ...images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType,
              data: img.base64,
            },
          })),
          {
            type: "text" as const,
            text:
              `Mark this student's answer to ${rubric.externalId ?? rubric.id} against the marking scheme ` +
              `above, out of ${rubric.maxMarks}. ` +
              (images.length === 1
                ? "There is one photograph; every span sits on page 0."
                : `There are ${images.length} photographs, in reading order; a span's page is its 0-based index.`),
          },
        ],
      },
    ],
  };
}

// ===========================================================================
// The verdict, as the model returns it
// ===========================================================================

export type RawOutcome = "hit" | "partial" | "miss" | "unmarked";

export interface RawStepVerdict {
  stepId: string;
  outOf: number;
  awarded: number;
  outcome: RawOutcome;
  partialReason: string | null;
  optionIds: string[];
  branchId: string | null;
  reason: string;
  evidence: string;
}

export interface RawSpan {
  text: string;
  tag: "green" | "orange" | "red";
  stepId: string | null;
  page: number;
  box: { x: number; y: number; width: number; height: number };
  note: string;
}

export interface RawVerdict {
  rubricId: string;
  marksAwarded: number;
  maxMarks: number;
  unmarkedMarks: number;
  steps: RawStepVerdict[];
  spans: RawSpan[];
  confidence: number;
  illegible: boolean;
  transcription: string;
}

// ===========================================================================
// Reconciliation — the safety rules, pure
// ===========================================================================

export interface ReconciledCriterion {
  /** `RubricCriterion.id`. */
  criterionId: string;
  stepId: string;
  verdict: CriterionVerdict;
  awardedHalves: number;
  outOfHalves: number;
  partialRuleId: string | null;
  unmarkedReason: UnmarkedReason | null;
  note: string | null;
}

export interface ReconciledSpan {
  /** The step this span is the visual proof of, or null for filler. */
  stepId: string | null;
  color: HighlightColor;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string | null;
  transcriptStart: number | null;
  transcriptEnd: number | null;
}

export interface ReconciledVerdict {
  awardedHalves: number;
  maxHalves: number;
  /** Marks nobody has judged. The difference between "3 out of 5" and "3 of 4 checked". */
  unmarkedHalves: number;
  unmarkedCount: number;
  criteria: ReconciledCriterion[];
  spans: ReconciledSpan[];
  confidence: number | null;
  transcript: string | null;
  illegible: boolean;
  /** How many red spans the `needsReview` rule withheld. Reported, not hidden. */
  suppressedRed: number;
  /** What was adjusted and why, for the reviewer. Never shown as the model's own words. */
  notes: string[];
}

/** A verdict we will not persist. The submission fails; no marks are invented. */
export class VerdictRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictRejected";
  }
}

const COLOR_FOR: Record<"HIT" | "PARTIAL" | "MISS", HighlightColor> = {
  HIT: "GREEN",
  PARTIAL: "ORANGE",
  MISS: "RED",
};

/** An option id as the model may spell it: bare `o1`, or qualified `g1/o1`. */
function matchesOption(option: LoadedCriterion, spelling: string): boolean {
  return option.stepId === spelling || option.stepId.endsWith(`/${spelling}`);
}

/**
 * Turn what the model said into what may be stored, applying every rule the
 * rubric contract states. Pure: no database, no clock, no environment.
 *
 * The model's own `marksAwarded` and `maxMarks` are **ignored**. Identity and
 * denominator come from the rubric, never from the model's echo of them — the
 * same rule `spike-grade.mjs` applies in `toVerdict()`, and the reason a
 * verdict cannot quietly grade an answer out of the wrong total.
 */
export function reconcileVerdict(raw: RawVerdict, rubric: LoadedRubric): ReconciledVerdict {
  const notes: string[] = [];
  const byStep = new Map<string, RawStepVerdict>();
  for (const s of raw.steps ?? []) byStep.set(s.stepId, s);

  const criteria: ReconciledCriterion[] = [];
  let awardedHalves = 0;
  let unmarkedHalves = 0;

  for (const c of rubric.criteria) {
    const outOfHalves = criterionHalves(c);

    // ---- Rule 1: a diagram, or anything else nobody has agreed how to check.
    if (!autoGradableUnit(c)) {
      criteria.push({
        criterionId: c.id,
        stepId: c.stepId,
        verdict: "UNMARKED",
        awardedHalves: 0,
        outOfHalves,
        partialRuleId: null,
        unmarkedReason: "NOT_AUTO_GRADABLE",
        note: c.kind === "DIAGRAM" ? "A diagram is marked by a person." : "Not automatically gradable.",
      });
      unmarkedHalves += outOfHalves;
      continue;
    }

    const step = byStep.get(c.stepId);
    if (!step) {
      // A verdict missing a step is malformed, not a step the student missed.
      // Rejecting the whole thing is the only reading that does not invent a
      // mark, in either direction.
      throw new VerdictRejected(`the verdict has no entry for step ${c.stepId}`);
    }

    let verdict: CriterionVerdict;
    let awarded = 0;
    let partialRuleId: string | null = null;
    let note = step.reason?.slice(0, 500) || null;

    if (step.outcome === "unmarked") {
      if (!rubric.needsReview) {
        // The prompt says "unmarked" is for a diagram, always, and a diagram
        // never reaches here. There is no `UnmarkedReason` member that honestly
        // describes a refusal on a signed-off rubric, and inventing one would
        // put a lie in a column a teacher reads. Reject instead.
        throw new VerdictRejected(
          `step ${c.stepId} came back unmarked on a rubric that is not flagged needsReview`,
        );
      }
      verdict = "UNMARKED";
    } else if (step.outcome === "hit") {
      verdict = "HIT";
      awarded = outOfHalves;
      const downgrade = chooseShortfall(c, step);
      if (downgrade) {
        notes.push(`${c.stepId}: ${downgrade}`);
        verdict = "MISS";
        awarded = 0;
        const rule = partialRuleFor(c, "KEYWORDS_PARTIAL");
        if (rule) {
          verdict = "PARTIAL";
          awarded = clampHalves(halves(rule.award), outOfHalves - 1);
          partialRuleId = rule.id;
        }
        note = `${note ?? ""}${note ? " " : ""}(${downgrade})`.slice(0, 500);
      }
    } else if (step.outcome === "partial") {
      const reason = step.partialReason ? PARTIAL_REASONS[step.partialReason] : undefined;
      const rule = reason ? partialRuleFor(c, reason) : null;
      if (!rule) {
        // "If a step is flawed in a way its partial list does not cover, it is
        // a miss, not an improvised half mark." — data/rubrics.schema.md.
        notes.push(
          `${c.stepId}: partial claimed for "${step.partialReason ?? "no reason"}", which this step offers no rule for; read as a miss`,
        );
        verdict = "MISS";
      } else {
        verdict = "PARTIAL";
        // The rule's award, not the model's number. A half mark is the scheme's
        // to give, and `partial_award_half` in the database agrees.
        awarded = clampHalves(halves(rule.award), Math.max(1, outOfHalves - 1));
        partialRuleId = rule.id;
      }
    } else {
      verdict = "MISS";
    }

    // ---- Rule 2: nothing is painted red on an unreviewed rubric.
    let unmarkedReason: UnmarkedReason | null = null;
    if (verdict === "MISS" && rubric.needsReview) {
      verdict = "UNMARKED";
      awarded = 0;
      unmarkedReason = "RUBRIC_NEEDS_REVIEW";
    } else if (verdict === "UNMARKED") {
      unmarkedReason = "RUBRIC_NEEDS_REVIEW";
    }

    // `criterion_verdict_consistent`: HIT and PARTIAL award more than zero;
    // MISS and UNMARKED award exactly zero. A HIT worth nothing is not a rubric
    // this code can express, so it is downgraded rather than rejected by the
    // database at insert.
    if ((verdict === "HIT" || verdict === "PARTIAL") && awarded <= 0) {
      notes.push(`${c.stepId}: awarded nothing on a ${verdict.toLowerCase()}; recorded as a miss`);
      verdict = rubric.needsReview ? "UNMARKED" : "MISS";
      unmarkedReason = verdict === "UNMARKED" ? "RUBRIC_NEEDS_REVIEW" : null;
      partialRuleId = null;
      awarded = 0;
    }
    if (verdict === "MISS" || verdict === "UNMARKED") {
      awarded = 0;
      partialRuleId = null;
    }

    criteria.push({
      criterionId: c.id,
      stepId: c.stepId,
      verdict,
      awardedHalves: awarded,
      outOfHalves,
      partialRuleId,
      unmarkedReason,
      note: noteFor(c, step, note),
    });
    awardedHalves += awarded;
    if (verdict === "UNMARKED") unmarkedHalves += outOfHalves;
  }

  const maxHalves = halves(rubric.maxMarks);
  if (awardedHalves > maxHalves) {
    // `grade_within_max`. Reaching here means criterionHalves and maxMarks
    // disagree, which assertGradable() should already have refused.
    throw new VerdictRejected(
      `awarded ${fromHalves(awardedHalves)} exceeds the rubric maximum of ${rubric.maxMarks}`,
    );
  }

  const verdictByStep = new Map(criteria.map((c) => [c.stepId, c]));
  const { spans, suppressedRed } = reconcileSpans(raw, rubric, verdictByStep);

  return {
    awardedHalves,
    maxHalves,
    unmarkedHalves,
    unmarkedCount: criteria.filter((c) => c.verdict === "UNMARKED").length,
    criteria,
    spans,
    confidence: Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : null,
    transcript: raw.transcription || null,
    illegible: Boolean(raw.illegible),
    suppressedRed,
    notes,
  };
}

/** Record which options scored, or which branch was answered — the group result cannot. */
function noteFor(c: LoadedCriterion, step: RawStepVerdict, note: string | null): string | null {
  const extras: string[] = [];
  if (c.kind === "CHOOSE" && step.optionIds?.length) {
    const scoring = c.children.filter((o) => step.optionIds.some((id) => matchesOption(o, id)));
    if (scoring.length) extras.push(`scored on: ${scoring.map((o) => o.stepId).join(", ")}`);
  }
  if (c.kind === "ALTERNATIVES" && step.branchId) {
    const branch = c.children.find(
      (b) => b.stepId === step.branchId || b.stepId.endsWith(`/${step.branchId}`),
    );
    if (branch) extras.push(`branch ${branch.branchLabel ?? branch.stepId}`);
  }
  const all = [note, ...extras].filter(Boolean).join(" — ");
  return all ? all.slice(0, 500) : null;
}

/**
 * "Any two of the following" is a constraint, not a suggestion. A group the
 * model called a hit on one option is not a hit, and a group that meets the
 * count but not its `requireTags` is not full marks — that is the awkward
 * second half of the convention the Social Science scheme leans on.
 *
 * Returns why it should be downgraded, or null.
 */
function chooseShortfall(c: LoadedCriterion, step: RawStepVerdict): string | null {
  if (c.kind !== "CHOOSE") return null;
  const scoring = c.children.filter((o) => (step.optionIds ?? []).some((id) => matchesOption(o, id)));
  const need = c.chooseAtLeast ?? 0;
  // An empty optionIds on a hit is under-reporting, not under-answering: the
  // marks were awarded, the ids were left out. Only a short non-empty list is
  // evidence of a shortfall.
  if (step.optionIds?.length && scoring.length < need) {
    return `${scoring.length} option(s) named where the group needs ${need}`;
  }
  for (const demand of c.tagDemands) {
    if (!step.optionIds?.length) continue;
    const carrying = scoring.filter((o) => o.tags.includes(demand.tag)).length;
    if (carrying < demand.minCount) {
      return `needs at least ${demand.minCount} option(s) tagged ${demand.tag}, found ${carrying}`;
    }
  }
  return null;
}

/**
 * Spans, filtered by the two rules that decide what may be drawn over a
 * student's handwriting.
 *
 * The colour follows the reconciled verdict wherever the span names a step:
 * the marks are what the colour means, so a model that tagged a span green on a
 * step it then marked a miss does not get to leave a green box on the page.
 */
function reconcileSpans(
  raw: RawVerdict,
  rubric: LoadedRubric,
  verdictByStep: Map<string, ReconciledCriterion>,
): { spans: ReconciledSpan[]; suppressedRed: number } {
  const spans: ReconciledSpan[] = [];
  let suppressedRed = 0;

  for (const span of raw.spans ?? []) {
    let color: HighlightColor;
    let stepId: string | null = null;

    if (span.stepId) {
      // Resolve through the tree, then up to the scoring unit that owns it: an
      // option's span is proof about its group, which is where the mark is.
      const owner = ownerUnit(rubric, span.stepId);
      const result = owner ? verdictByStep.get(owner) : undefined;
      if (!result) continue; // names a step this rubric does not have
      // ---- Rule 1, second half: an UNMARKED criterion produces no row here.
      if (result.verdict === "UNMARKED") continue;
      color = COLOR_FOR[result.verdict as "HIT" | "PARTIAL" | "MISS"];
      stepId = owner;
    } else {
      // Unattributed: the filler case. Grader behaviour, not something a rubric
      // declares — and green or orange with no step behind it is meaningless,
      // so only red survives without one.
      if (span.tag !== "red") continue;
      color = "RED";
    }

    // ---- Rule 2: nothing red on an unreviewed rubric, attributed or not.
    if (color === "RED" && rubric.needsReview) {
      suppressedRed++;
      continue;
    }

    const box = normaliseBox(span.box);
    if (!box) continue; // no honest box, so nothing is drawn; the checklist still shows the verdict

    const at = span.text && raw.transcription ? raw.transcription.indexOf(span.text) : -1;
    spans.push({
      stepId,
      color,
      page: Number.isInteger(span.page) && span.page >= 0 ? span.page : 0,
      ...box,
      label: (span.note || span.text || "").slice(0, 200) || null,
      transcriptStart: at >= 0 ? at : null,
      transcriptEnd: at >= 0 ? at + span.text.length : null,
    });
  }

  return { spans, suppressedRed };
}

/** The top-level scoring unit a step id belongs to — itself, or its ancestor. */
function ownerUnit(rubric: LoadedRubric, stepId: string): string | null {
  const direct = rubric.criteria.find((c) => c.stepId === stepId);
  if (direct) return direct.stepId;
  for (const c of rubric.criteria) {
    if (findCriterion({ criteria: c.children }, stepId)) return c.stepId;
  }
  return null;
}

/**
 * `highlight_box_normalised`: fractions of the page, not pixels, with width and
 * height strictly positive and neither edge past 1. A box that cannot be made
 * to satisfy that is dropped rather than clamped into a lie about where the
 * words are.
 */
function normaliseBox(
  box: RawSpan["box"] | undefined,
): { x: number; y: number; width: number; height: number } | null {
  if (!box) return null;
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  const x = round(Math.max(0, Math.min(1, box.x)));
  const y = round(Math.max(0, Math.min(1, box.y)));
  const width = round(Math.min(box.width, 1 - x));
  const height = round(Math.min(box.height, 1 - y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

// ===========================================================================
// Persistence — append-only, both directions
// ===========================================================================

/** The current grade for an answer: the row in the chain nothing supersedes. */
export async function currentGrade(answerId: string) {
  return prisma.gradingResult.findFirst({
    where: { answerId },
    orderBy: { revision: "desc" },
  });
}

interface PersistOpts {
  answerId: string;
  rubric: LoadedRubric;
  verdict: ReconciledVerdict;
  /** 0-based page ordinal within the answer -> `SubmissionPage.id`. */
  pageIdByOrdinal: Map<number, string>;
  modelName?: string | null;
  modelVersion?: string | null;
}

/**
 * Write one AI verdict as a new revision.
 *
 * Never an UPDATE. `revision` is `previous + 1` and `supersedesId` points at
 * what it replaced, so "AI: 3/5 -> your teacher: 4/5" is a query rather than a
 * mark that silently changed. `supersedesId @unique` keeps the chain linear.
 */
export async function persistAiVerdict(opts: PersistOpts): Promise<string> {
  const { answerId, rubric, verdict, pageIdByOrdinal } = opts;

  return prisma.$transaction(async (tx) => {
    const previous = await tx.gradingResult.findFirst({
      where: { answerId },
      orderBy: { revision: "desc" },
      select: { id: true, revision: true },
    });

    const grade = await tx.gradingResult.create({
      data: {
        answerId,
        rubricId: rubric.id,
        source: "AI",
        // `grade_source_consistent`: an AI grade has no evaluator.
        evaluatorId: null,
        revision: (previous?.revision ?? 0) + 1,
        supersedesId: previous?.id ?? null,
        awardedMarks: new Prisma.Decimal(fromHalves(verdict.awardedHalves)),
        maxMarks: new Prisma.Decimal(rubric.maxMarks),
        unmarkedCount: verdict.unmarkedCount,
        confidence: verdict.confidence,
        modelName: opts.modelName ?? GRADING_MODEL,
        modelVersion: opts.modelVersion ?? null,
        comment: verdict.notes.length ? verdict.notes.join("; ").slice(0, 2000) : null,
      },
      select: { id: true },
    });

    await writeCriteriaAndSpans(tx, grade.id, verdict, pageIdByOrdinal);
    await denormaliseToAttemptQuestion(tx, answerId, verdict.awardedHalves);
    return grade.id;
  });
}

export interface OverrideCriterion {
  /** `RubricCriterion.id`. */
  criterionId: string;
  verdict: CriterionVerdict;
  /** In marks. Snapped to the half and clamped to the criterion's own maximum. */
  awarded: number;
  partialReason?: PartialReason | null;
  note?: string | null;
}

/**
 * A human disagreeing with the machine. Also an INSERT.
 *
 * The AI's verdict survives underneath it — that is the whole reason the table
 * is append-only. A student is entitled to see that a person changed the mark,
 * and an evaluator's own line-by-line reasons are new `CriterionResult` rows
 * rather than edits to the ones the model wrote.
 */
export async function persistHumanOverride(opts: {
  answerId: string;
  evaluatorId: string;
  reviewId?: string | null;
  criteria: OverrideCriterion[];
  comment?: string | null;
}): Promise<{ gradingResultId: string; awardedMarks: number }> {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.gradingResult.findFirst({
      where: { answerId: opts.answerId },
      orderBy: { revision: "desc" },
      select: { id: true, revision: true, rubricId: true, maxMarks: true },
    });
    if (!previous) throw ApiError.notFound("Grade");

    const criterionRows = await tx.rubricCriterion.findMany({
      where: { id: { in: opts.criteria.map((c) => c.criterionId) } },
      select: {
        id: true,
        kind: true,
        marks: true,
        marksEach: true,
        chooseAtLeast: true,
        partialRules: { select: { id: true, reason: true, award: true } },
      },
    });
    const byId = new Map(criterionRows.map((c) => [c.id, c]));

    let totalHalves = 0;
    let unmarked = 0;
    const rows = opts.criteria.map((c) => {
      const criterion = byId.get(c.criterionId);
      if (!criterion) throw ApiError.validation([{ path: "criteria", message: `unknown criterion ${c.criterionId}` }]);
      const outOf = criterionHalves({
        kind: criterion.kind,
        marks: criterion.marks === null ? null : Number(criterion.marks),
        marksEach: criterion.marksEach === null ? null : Number(criterion.marksEach),
        chooseAtLeast: criterion.chooseAtLeast,
      });
      let awarded = clampHalves(halves(c.awarded), outOf);
      let partialRuleId: string | null = null;
      let unmarkedReason: UnmarkedReason | null = null;

      if (c.verdict === "MISS" || c.verdict === "UNMARKED") awarded = 0;
      if (c.verdict === "UNMARKED") {
        // A person leaving something unmarked is waiting on another person.
        unmarkedReason = "NOT_AUTO_GRADABLE";
        unmarked++;
      }
      if (c.verdict === "PARTIAL") {
        const rule = c.partialReason
          ? criterion.partialRules.find((r) => r.reason === c.partialReason)
          : undefined;
        partialRuleId = rule?.id ?? null;
        if (awarded <= 0) awarded = 1; // `criterion_verdict_consistent`: PARTIAL awards more than zero
        if (awarded >= outOf) awarded = Math.max(1, outOf - 1);
      }
      if (c.verdict === "HIT") awarded = outOf;
      totalHalves += awarded;
      return {
        rubricCriterionId: c.criterionId,
        verdict: c.verdict,
        awarded: new Prisma.Decimal(fromHalves(awarded)),
        partialRuleId,
        unmarkedReason,
        note: c.note?.slice(0, 500) ?? null,
      };
    });

    const grade = await tx.gradingResult.create({
      data: {
        answerId: opts.answerId,
        rubricId: previous.rubricId,
        source: "HUMAN",
        // `grade_source_consistent`: a human grade must name one.
        evaluatorId: opts.evaluatorId,
        reviewId: opts.reviewId ?? null,
        revision: previous.revision + 1,
        supersedesId: previous.id,
        awardedMarks: new Prisma.Decimal(fromHalves(totalHalves)),
        maxMarks: previous.maxMarks,
        unmarkedCount: unmarked,
        comment: opts.comment?.slice(0, 2000) ?? null,
      },
      select: { id: true },
    });

    for (const row of rows) {
      await tx.criterionResult.create({ data: { gradingResultId: grade.id, ...row } });
    }
    await denormaliseToAttemptQuestion(tx, opts.answerId, totalHalves);

    return { gradingResultId: grade.id, awardedMarks: fromHalves(totalHalves) };
  });
}

type Tx = Prisma.TransactionClient;

async function writeCriteriaAndSpans(
  tx: Tx,
  gradingResultId: string,
  verdict: ReconciledVerdict,
  pageIdByOrdinal: Map<number, string>,
): Promise<void> {
  const resultIdByStep = new Map<string, string>();
  for (const c of verdict.criteria) {
    const row = await tx.criterionResult.create({
      data: {
        gradingResultId,
        rubricCriterionId: c.criterionId,
        verdict: c.verdict,
        awarded: new Prisma.Decimal(fromHalves(c.awardedHalves)),
        partialRuleId: c.partialRuleId,
        unmarkedReason: c.unmarkedReason,
        note: c.note,
      },
      select: { id: true },
    });
    resultIdByStep.set(c.stepId, row.id);
  }

  for (const span of verdict.spans) {
    const submissionPageId = pageIdByOrdinal.get(span.page) ?? pageIdByOrdinal.get(0);
    if (!submissionPageId) continue;
    await tx.highlightSpan.create({
      data: {
        gradingResultId,
        criterionResultId: span.stepId ? (resultIdByStep.get(span.stepId) ?? null) : null,
        submissionPageId,
        color: span.color,
        x: new Prisma.Decimal(span.x),
        y: new Prisma.Decimal(span.y),
        width: new Prisma.Decimal(span.width),
        height: new Prisma.Decimal(span.height),
        transcriptStart: span.transcriptStart,
        transcriptEnd: span.transcriptEnd,
        label: span.label,
      },
    });
  }
}

/**
 * Copy the new mark down onto `AttemptQuestion.awardedMarks`.
 *
 * The schema asks for this in as many words — "denormalised so a results screen
 * is one query. Recomputed whenever a grade is appended; `GradingResult` stays
 * the authority." Skipped for a loose photo with no mark grid behind it.
 */
async function denormaliseToAttemptQuestion(
  tx: Tx,
  answerId: string,
  awardedHalves: number,
): Promise<void> {
  const answer = await tx.answer.findUnique({
    where: { id: answerId },
    select: { attemptQuestionId: true },
  });
  if (!answer?.attemptQuestionId) return;
  await tx.attemptQuestion.update({
    where: { id: answer.attemptQuestionId },
    data: { awardedMarks: new Prisma.Decimal(fromHalves(awardedHalves)) },
  });
}

// ===========================================================================
// The worker
// ===========================================================================

/** True when a key is configured. False is a supported state, not a failure. */
export function isGradingConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 8);
}

export interface AnswerOutcome {
  answerId: string;
  questionNumber: number;
  status: "graded" | "no-rubric" | "no-pages" | "failed" | "already-graded" | "queued";
  gradingResultId?: string;
  rubricId?: string;
  awardedMarks?: number;
  maxMarks?: number;
  unmarkedCount?: number;
  unmarkedMarks?: number;
  suppressedRed?: number;
  detail?: string;
}

export interface GradeSubmissionResult {
  submissionId: string;
  configured: boolean;
  status: string;
  answers: AnswerOutcome[];
  /** Present only when grading did not run because no key is configured. */
  reason?: string;
}

/**
 * Grade every ungraded answer on one submission.
 *
 * Sequential on purpose, exactly as the spike is: firing a question group in
 * parallel means every request races the first one's cache write and they all
 * miss the rubric prefix.
 */
export async function gradeSubmission(
  submissionId: string,
  opts: { force?: boolean } = {},
): Promise<GradeSubmissionResult> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      student: { select: { hitlEnabled: true } },
      pages: { select: { id: true, pageIndex: true, storageKey: true, contentType: true } },
      answers: {
        orderBy: { questionNumber: "asc" },
        include: {
          pages: { orderBy: { ordinal: "asc" }, select: { submissionPageId: true, ordinal: true } },
          gradingResults: { select: { id: true }, take: 1 },
        },
      },
    },
  });
  if (!submission) throw ApiError.notFound("Submission");

  if (!isGradingConfigured()) {
    // Honest degradation: nothing is written, the submission stays QUEUED, and
    // the caller is told why. Never a fabricated grade.
    return {
      submissionId,
      configured: false,
      status: submission.status,
      answers: submission.answers.map((a) => ({
        answerId: a.id,
        questionNumber: a.questionNumber,
        // "queued", not "failed": nothing was attempted, so nothing failed.
        status: a.gradingResults.length ? ("already-graded" as const) : ("queued" as const),
        detail: a.gradingResults.length ? undefined : "waiting for a configured marker",
      })),
      reason:
        "ANTHROPIC_API_KEY is not configured, so nothing was graded. The submission stays queued and unprocessed.",
    };
  }

  const pageById = new Map(submission.pages.map((p) => [p.id, p]));
  await prisma.submission.update({ where: { id: submissionId }, data: { status: "AI_GRADING" } });

  const outcomes: AnswerOutcome[] = [];
  for (const answer of submission.answers) {
    if (answer.gradingResults.length && !opts.force) {
      outcomes.push({
        answerId: answer.id,
        questionNumber: answer.questionNumber,
        status: "already-graded",
      });
      continue;
    }
    outcomes.push(await gradeOneAnswer(submission.paperSlug, answer, pageById));
  }

  const graded = outcomes.filter((o) => o.status === "graded");
  const anyUnmarked = graded.some((o) => (o.unmarkedCount ?? 0) > 0);
  const attempted = outcomes.filter((o) => o.status !== "already-graded");

  // A submission with unmarked criteria is the schema's own routing signal, and
  // a student flagged `hitlEnabled` is routed regardless. Creating the ticket
  // belongs to the review lane, which watches for this status; setting it here
  // is what tells that lane there is something to pick up.
  const status =
    attempted.length && !graded.length && attempted.every((o) => o.status === "failed")
      ? "FAILED"
      : anyUnmarked || submission.student.hitlEnabled
        ? "AWAITING_REVIEW"
        : "GRADED";

  await prisma.submission.update({
    where: { id: submissionId },
    data: {
      status,
      gradedAt: new Date(),
      failureReason:
        status === "FAILED" ? (attempted.find((o) => o.detail)?.detail ?? "grading failed") : null,
    },
  });

  return { submissionId, configured: true, status, answers: outcomes };
}

type AnswerForGrading = {
  id: string;
  questionNumber: number;
  pages: { submissionPageId: string; ordinal: number }[];
};

type PageRow = { id: string; pageIndex: number; storageKey: string; contentType: string };

async function gradeOneAnswer(
  paperSlug: string | null,
  answer: AnswerForGrading,
  pageById: Map<string, PageRow>,
): Promise<AnswerOutcome> {
  const base = { answerId: answer.id, questionNumber: answer.questionNumber };
  if (!paperSlug) {
    return { ...base, status: "no-rubric", detail: "the submission names no paper" };
  }
  if (!answer.pages.length) {
    return { ...base, status: "no-pages", detail: "no photograph is attached to this answer" };
  }

  const rubrics = await loadRubricsForQuestion(paperSlug, answer.questionNumber);
  if (!rubrics.length) {
    return {
      ...base,
      status: "no-rubric",
      detail: `no rubric for ${paperSlug} question ${answer.questionNumber}`,
    };
  }

  const images: AnswerImage[] = [];
  const pageIdByOrdinal = new Map<number, string>();
  for (const link of answer.pages) {
    const page = pageById.get(link.submissionPageId);
    if (!page) continue;
    if (!SENDABLE_IMAGE_TYPES.has(page.contentType)) {
      return {
        ...base,
        status: "failed",
        detail: `page ${page.pageIndex} is ${page.contentType}, which cannot be sent for marking`,
      };
    }
    const object = await storage.read(page.storageKey);
    images.push({
      ordinal: images.length,
      submissionPageId: page.id,
      mediaType: page.contentType,
      base64: object.body.toString("base64"),
    });
    pageIdByOrdinal.set(images.length - 1, page.id);
  }
  if (!images.length) {
    return { ...base, status: "no-pages", detail: "every attached page is missing from storage" };
  }

  // Where CBSE offers "attempt either option A or B" each option is its own
  // rubric. The student answered one; the one they answered is the one that
  // scores, so every offered variant is marked and the best stands.
  let best: {
    rubric: LoadedRubric;
    verdict: ReconciledVerdict;
    modelName?: string;
    modelVersion?: string;
  } | null = null;
  let lastFailure: string | null = null;

  for (const rubric of rubrics.slice(0, 3)) {
    try {
      assertGradable(rubric);
      const response = await callModel(buildParams(rubric, images));
      const verdict = reconcileVerdict(response.verdict, rubric);
      if (!best || verdict.awardedHalves > best.verdict.awardedHalves) {
        best = { rubric, verdict, modelName: response.model, modelVersion: response.stopReason };
      }
    } catch (err) {
      lastFailure =
        err instanceof VerdictRejected || err instanceof ApiError || err instanceof Error
          ? err.message
          : String(err);
    }
  }

  if (!best) return { ...base, status: "failed", detail: lastFailure ?? "grading failed" };

  const gradingResultId = await persistAiVerdict({
    answerId: answer.id,
    rubric: best.rubric,
    verdict: best.verdict,
    pageIdByOrdinal,
    modelName: best.modelName,
  });

  if (best.verdict.transcript) {
    await prisma.answer.update({
      where: { id: answer.id },
      data: { transcript: best.verdict.transcript },
    });
  }

  return {
    ...base,
    status: "graded",
    gradingResultId,
    rubricId: best.rubric.id,
    awardedMarks: fromHalves(best.verdict.awardedHalves),
    maxMarks: best.rubric.maxMarks,
    unmarkedCount: best.verdict.unmarkedCount,
    unmarkedMarks: fromHalves(best.verdict.unmarkedHalves),
    suppressedRed: best.verdict.suppressedRed,
  };
}

// ===========================================================================
// The model call
// ===========================================================================

interface ModelResponse {
  verdict: RawVerdict;
  model: string;
  stopReason: string;
}

/**
 * The SDK is imported here rather than at the top of the file, exactly as
 * `scripts/spike-grade.mjs` does it, so that everything above — the prompt, the
 * schema, the reconciliation, the whole test suite — runs with no SDK
 * installed, no key configured and no network.
 */
async function callModel(params: ReturnType<typeof buildParams>): Promise<ModelResponse> {
  if (!isGradingConfigured()) {
    throw new ApiError("NOT_AVAILABLE", "ANTHROPIC_API_KEY is not configured.");
  }
  let Anthropic: typeof import("@anthropic-ai/sdk").default;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    throw new ApiError(
      "NOT_AVAILABLE",
      "@anthropic-ai/sdk is not installed, so nothing can be graded.",
    );
  }
  const client = new Anthropic();
  const message = (await client.messages.create(
    params as unknown as Parameters<typeof client.messages.create>[0],
  )) as unknown as {
    content: { type: string; text?: string }[];
    model: string;
    stop_reason: string;
  };
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new VerdictRejected("the model returned no text block");
  return {
    // output_config.format guarantees this parses.
    verdict: JSON.parse(text) as RawVerdict,
    model: message.model,
    stopReason: message.stop_reason,
  };
}

// ===========================================================================
// Batch
// ===========================================================================

export interface BatchItem {
  answerId: string;
  rubric: LoadedRubric;
  images: AnswerImage[];
}

export interface BatchContext {
  rubric: LoadedRubric;
  pageIdByOrdinal: Map<number, string>;
  questionNumber: number;
}

/**
 * Everything a batch needs, assembled from the database.
 *
 * Built the same way on the way in and on the way out. There is no column to
 * park a batch id in — `prisma/schema.prisma` is frozen and scoped to Phases
 * 0-4 — so the caller hands back the same submission ids when it collects, and
 * this rebuilds the identical context from them. Deterministic because
 * `AnswerPage.ordinal` is stored: the page a span called 0 on the way out is
 * the page a span called 0 on the way back.
 *
 * Only the first offered variant of a question is batched. The "mark every
 * variant and keep the best" pass in `gradeSubmission` doubles the request
 * count, which is exactly what a batch is being used to avoid.
 */
export async function collectBatchWork(
  submissionIds: string[],
): Promise<{ items: BatchItem[]; context: Map<string, BatchContext>; skipped: AnswerOutcome[] }> {
  const items: BatchItem[] = [];
  const context = new Map<string, BatchContext>();
  const skipped: AnswerOutcome[] = [];

  const submissions = await prisma.submission.findMany({
    where: { id: { in: submissionIds } },
    include: {
      pages: { select: { id: true, pageIndex: true, storageKey: true, contentType: true } },
      answers: {
        orderBy: { questionNumber: "asc" },
        include: {
          pages: { orderBy: { ordinal: "asc" }, select: { submissionPageId: true, ordinal: true } },
          gradingResults: { select: { id: true }, take: 1 },
        },
      },
    },
  });

  for (const submission of submissions) {
    const pageById = new Map(submission.pages.map((p) => [p.id, p]));
    for (const answer of submission.answers) {
      const base = { answerId: answer.id, questionNumber: answer.questionNumber };
      if (answer.gradingResults.length) {
        skipped.push({ ...base, status: "already-graded" });
        continue;
      }
      if (!submission.paperSlug) {
        skipped.push({ ...base, status: "no-rubric", detail: "the submission names no paper" });
        continue;
      }
      const rubrics = await loadRubricsForQuestion(submission.paperSlug, answer.questionNumber);
      if (!rubrics.length) {
        skipped.push({ ...base, status: "no-rubric", detail: "no rubric for this question" });
        continue;
      }
      const rubric = rubrics[0];
      try {
        assertGradable(rubric);
      } catch (err) {
        skipped.push({
          ...base,
          status: "failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const images: AnswerImage[] = [];
      const pageIdByOrdinal = new Map<number, string>();
      let unsendable: string | null = null;
      for (const link of answer.pages) {
        const page = pageById.get(link.submissionPageId);
        if (!page) continue;
        if (!SENDABLE_IMAGE_TYPES.has(page.contentType)) {
          unsendable = `page ${page.pageIndex} is ${page.contentType}, which cannot be sent for marking`;
          break;
        }
        const object = await storage.read(page.storageKey);
        images.push({
          ordinal: images.length,
          submissionPageId: page.id,
          mediaType: page.contentType,
          base64: object.body.toString("base64"),
        });
        pageIdByOrdinal.set(images.length - 1, page.id);
      }
      if (unsendable) {
        skipped.push({ ...base, status: "failed", detail: unsendable });
        continue;
      }
      if (!images.length) {
        skipped.push({ ...base, status: "no-pages", detail: "no photograph is attached" });
        continue;
      }

      items.push({ answerId: answer.id, rubric, images });
      context.set(answer.id, { rubric, pageIdByOrdinal, questionNumber: answer.questionNumber });
    }
  }

  // Grouped by question so the rubric prefix stays hot across the group, which
  // is the whole reason the cache breakpoint is where it is.
  items.sort((a, b) => a.rubric.id.localeCompare(b.rubric.id) || a.answerId.localeCompare(b.answerId));
  return { items, context, skipped };
}

/**
 * Submit many answers through the Batches API, at half price.
 *
 * Results come back in an arbitrary order and are keyed by `custom_id`, never
 * by position: grading answer 7 against answer 3's rubric would produce a
 * plausible number and silently poison every mark in the run.
 */
export async function createGradingBatch(items: BatchItem[]): Promise<string> {
  if (!isGradingConfigured()) {
    throw new ApiError("NOT_AVAILABLE", "ANTHROPIC_API_KEY is not configured.");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const batch = await client.messages.batches.create({
    requests: items.map((item) => ({
      custom_id: item.answerId,
      params: buildParams(item.rubric, item.images) as never,
    })),
  });
  return batch.id;
}

export interface BatchCollection {
  batchId: string;
  ended: boolean;
  processed: AnswerOutcome[];
}

/**
 * Collect a batch, if it has finished. A batch that is still running returns
 * `ended: false` and writes nothing — the caller polls, rather than this
 * function blocking a request handler for an hour.
 */
export async function collectGradingBatch(
  batchId: string,
  context: Map<string, { rubric: LoadedRubric; pageIdByOrdinal: Map<number, string>; questionNumber: number }>,
): Promise<BatchCollection> {
  if (!isGradingConfigured()) {
    throw new ApiError("NOT_AVAILABLE", "ANTHROPIC_API_KEY is not configured.");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const batch = await client.messages.batches.retrieve(batchId);
  if (batch.processing_status !== "ended") return { batchId, ended: false, processed: [] };

  const processed: AnswerOutcome[] = [];
  for await (const result of await client.messages.batches.results(batchId)) {
    const ctx = context.get(result.custom_id);
    if (!ctx) continue;
    const base = { answerId: result.custom_id, questionNumber: ctx.questionNumber };
    if (result.result.type !== "succeeded") {
      processed.push({ ...base, status: "failed", detail: result.result.type });
      continue;
    }
    const text = result.result.message.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      processed.push({ ...base, status: "failed", detail: "no text block" });
      continue;
    }
    try {
      const verdict = reconcileVerdict(JSON.parse(text.text) as RawVerdict, ctx.rubric);
      const gradingResultId = await persistAiVerdict({
        answerId: result.custom_id,
        rubric: ctx.rubric,
        verdict,
        pageIdByOrdinal: ctx.pageIdByOrdinal,
        modelName: result.result.message.model,
      });
      processed.push({
        ...base,
        status: "graded",
        gradingResultId,
        rubricId: ctx.rubric.id,
        awardedMarks: fromHalves(verdict.awardedHalves),
        maxMarks: ctx.rubric.maxMarks,
        unmarkedCount: verdict.unmarkedCount,
        unmarkedMarks: fromHalves(verdict.unmarkedHalves),
        suppressedRed: verdict.suppressedRed,
      });
    } catch (err) {
      processed.push({
        ...base,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { batchId, ended: true, processed };
}
