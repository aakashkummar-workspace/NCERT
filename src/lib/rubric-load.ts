/**
 * A marking scheme, as the grader needs it.
 *
 * `data/rubrics.json` is the authoring format and `data/rubrics.schema.md` is
 * its contract; `prisma/seed.ts` loads a copy into Postgres so a grade can hold
 * a foreign key to the exact rubric version it was given under. This module is
 * the third thing: it reads that copy back out as one plain, fully-hydrated
 * tree, and owns the arithmetic every consumer of it would otherwise re-derive.
 *
 * ## Why the arithmetic lives here, and why it is in half-mark units
 *
 * `data/rubrics.schema.md` calls a rubric whose steps do not sum to `maxMarks`
 * "the single most damaging error in this file, because it grades every attempt
 * at that question out of the wrong denominator". Half marks are the finest
 * grain CBSE uses, and `1.5 + 1.5 + 1.5 + 0.5` is 5 in integers and is not
 * reliably 5 in doubles. So every sum here is computed in *halves* — an integer
 * — and converted back once, at the edge. `criterionHalves()` is the single
 * definition of what a criterion is worth, and it is the reason a `CHOOSE`
 * group counts `chooseAtLeast x marksEach` rather than `marksEach`.
 *
 * ## The pure half and the database half
 *
 * Everything above the `--- database ---` rule is pure: no Prisma, no I/O, no
 * environment. That is what lets `scripts/test-grading.mjs` check the marks
 * arithmetic, the branch-sum rule and the auto-gradability rule in plain Node.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  CriterionKind,
  MatchMode,
  PartialReason,
  QuestionType,
  RubricOrdering,
} from "@prisma/client";
import { ApiError } from "@/lib/api";
import prisma from "@/lib/db";

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

export interface LoadedConcept {
  ordinal: number;
  /** Accepted phrasings; any one satisfies the concept. Never empty. */
  phrasings: string[];
}

export interface LoadedPartialRule {
  id: string;
  reason: PartialReason;
  award: number;
  note: string | null;
}

export interface LoadedTagDemand {
  tag: string;
  minCount: number;
}

export interface LoadedCriterion {
  id: string;
  /** The authored step id. An option is qualified with its group: `g3/o1`. */
  stepId: string;
  kind: CriterionKind;
  ordinal: number;
  awardFor: string;
  branchLabel: string | null;
  marks: number | null;
  marksEach: number | null;
  chooseAtLeast: number | null;
  match: MatchMode;
  unitRequired: boolean;
  unitAccepted: string[];
  tags: string[];
  labels: string[];
  autoGradable: boolean;
  ordered: boolean | null;
  concepts: LoadedConcept[];
  partialRules: LoadedPartialRule[];
  tagDemands: LoadedTagDemand[];
  children: LoadedCriterion[];
}

export interface LoadedRubric {
  id: string;
  externalId: string | null;
  paperSlug: string;
  questionNumber: number;
  variant: string;
  session: string | null;
  type: QuestionType;
  maxMarks: number;
  version: number;
  bookCode: string;
  chapter: number;
  subject: string;
  classNum: number;
  prompt: string | null;
  ordering: RubricOrdering;
  acceptEquivalentWording: boolean;
  needsReview: boolean;
  reviewNotes: string[];
  schemeFile: string | null;
  schemePage: number | null;
  /** Top-level criteria in authored order. These are the scoring units. */
  criteria: LoadedCriterion[];
}

// ---------------------------------------------------------------------------
// Marks, in halves
// ---------------------------------------------------------------------------

/** Marks to half-mark units. The only place doubles become integers. */
export function halves(marks: number): number {
  return Math.round(marks * 2);
}

/** Half-mark units back to marks. The only place integers become doubles. */
export function fromHalves(units: number): number {
  return units / 2;
}

/** Snap to the nearest half mark and clamp into `[0, maxHalves]`, in halves. */
export function clampHalves(units: number, maxHalves: number): number {
  if (!Number.isFinite(units)) return 0;
  return Math.max(0, Math.min(maxHalves, Math.round(units)));
}

/**
 * What one criterion contributes to `maxMarks`, in halves.
 *
 * - `CHOOSE` is `chooseAtLeast x marksEach`, not `marksEach`. The schema keeps
 *   the two in separate columns precisely so this cannot be got wrong by
 *   reading one field.
 * - `ALTERNATIVES` counts its own `marks` **once**, however many branches it
 *   lists. A branch is not an extra way to earn marks; it is another way to
 *   earn the same ones.
 * - `BRANCH` and `OPTION` contribute nothing of their own: they are children of
 *   a unit that has already been counted. Counting them again is exactly the
 *   double count that inflates a denominator.
 */
export function criterionHalves(
  c: Pick<LoadedCriterion, "kind" | "marks" | "marksEach" | "chooseAtLeast">,
): number {
  switch (c.kind) {
    case "CHOOSE":
      return halves((c.chooseAtLeast ?? 0) * (c.marksEach ?? 0));
    case "OPTION":
    case "BRANCH":
      return 0;
    default:
      return halves(c.marks ?? 0);
  }
}

/** What a `BRANCH`'s own steps sum to, in halves. Must equal its group's marks. */
export function branchHalves(branch: LoadedCriterion): number {
  return branch.children.reduce((sum, child) => sum + criterionHalves(child), 0);
}

/** The rubric's steps, summed in halves. Compare against `halves(maxMarks)`. */
export function rubricHalves(rubric: Pick<LoadedRubric, "criteria">): number {
  return rubric.criteria.reduce((sum, c) => sum + criterionHalves(c), 0);
}

/**
 * Everything that would make this rubric grade an answer out of the wrong
 * denominator. Not a second `rubric:check` — that script owns full validation
 * and this must not grow into a rival. These are only the failures that would
 * corrupt a mark if grading proceeded anyway.
 */
export function rubricProblems(rubric: LoadedRubric): string[] {
  const problems: string[] = [];
  const want = halves(rubric.maxMarks);
  const got = rubricHalves(rubric);
  if (got !== want) {
    problems.push(`steps sum to ${fromHalves(got)} but maxMarks is ${rubric.maxMarks}`);
  }

  const seen = new Set<string>();
  const walk = (list: LoadedCriterion[]) => {
    for (const c of list) {
      if (seen.has(c.stepId)) problems.push(`duplicate step id ${c.stepId}`);
      else seen.add(c.stepId);
      walk(c.children);
    }
  };
  walk(rubric.criteria);

  for (const c of rubric.criteria) {
    if (c.kind !== "ALTERNATIVES") continue;
    const groupHalves = criterionHalves(c);
    if (c.children.length < 2) {
      problems.push(`${c.stepId}: an alternatives group needs at least two branches`);
    }
    for (const branch of c.children) {
      // The defect this kind exists to prevent: a branch summing to less grades
      // the student who chose it out of a smaller total than the one who chose
      // the other, for no reason but which alternative they preferred.
      if (branchHalves(branch) !== groupHalves) {
        problems.push(
          `${c.stepId}/${branch.stepId}: branch sums to ${fromHalves(branchHalves(branch))}, ` +
            `the group is worth ${fromHalves(groupHalves)}`,
        );
      }
    }
    if (c.children.some((b) => b.children.some((s) => s.kind === "ALTERNATIVES"))) {
      problems.push(`${c.stepId}: alternatives groups do not nest`);
    }
  }
  return problems;
}

/**
 * May a matcher decide this scoring unit at all?
 *
 * A `DIAGRAM` never may — the column is forced false at import and
 * `diagram_not_auto_gradable` says the same thing in SQL. An `ALTERNATIVES`
 * group may only if some branch is gradable end to end: if every branch
 * contains a diagram, there is no route through the group a machine can mark.
 */
export function autoGradableUnit(c: LoadedCriterion): boolean {
  if (c.kind === "DIAGRAM") return false;
  if (!c.autoGradable) return false;
  if (c.kind === "ALTERNATIVES") {
    return c.children.some((b) => b.children.every((s) => autoGradableUnit(s)));
  }
  return true;
}

/** The partial rule for a named reason, or null. Orange is only ever a rule. */
export function partialRuleFor(
  c: LoadedCriterion,
  reason: PartialReason,
): LoadedPartialRule | null {
  return c.partialRules.find((r) => r.reason === reason) ?? null;
}

/** Depth-first over the whole tree, groups before their children. */
export function walkCriteria(rubric: Pick<LoadedRubric, "criteria">): LoadedCriterion[] {
  const out: LoadedCriterion[] = [];
  const visit = (list: LoadedCriterion[]) => {
    for (const c of list) {
      out.push(c);
      visit(c.children);
    }
  };
  visit(rubric.criteria);
  return out;
}

export function findCriterion(
  rubric: Pick<LoadedRubric, "criteria">,
  stepId: string,
): LoadedCriterion | null {
  return walkCriteria(rubric).find((c) => c.stepId === stepId) ?? null;
}

/** The closed list of partial-credit reasons, JSON spelling to enum member. */
export const PARTIAL_REASONS: Record<string, PartialReason> = {
  "unit-missing": "UNIT_MISSING",
  "unit-wrong": "UNIT_WRONG",
  "order-broken": "ORDER_BROKEN",
  "keywords-partial": "KEYWORDS_PARTIAL",
  "arithmetic-slip": "ARITHMETIC_SLIP",
  "formula-only": "FORMULA_ONLY",
  "sign-error": "SIGN_ERROR",
  unrounded: "UNROUNDED",
};

/** The inverse, for talking to the model in the contract's own vocabulary. */
export const PARTIAL_REASON_JSON = Object.fromEntries(
  Object.entries(PARTIAL_REASONS).map(([json, member]) => [member, json]),
) as Record<PartialReason, string>;

// ---------------------------------------------------------------------------
// --- database ---
// ---------------------------------------------------------------------------

const CRITERION_SELECT = {
  id: true,
  stepId: true,
  parentId: true,
  kind: true,
  ordinal: true,
  awardFor: true,
  branchLabel: true,
  marks: true,
  marksEach: true,
  chooseAtLeast: true,
  match: true,
  unitRequired: true,
  unitAccepted: true,
  tags: true,
  labels: true,
  autoGradable: true,
  ordered: true,
  concepts: { select: { ordinal: true, phrasings: true }, orderBy: { ordinal: "asc" } },
  partialRules: { select: { id: true, reason: true, award: true, note: true } },
  tagDemands: { select: { tag: true, minCount: true } },
} as const;

interface CriterionRow {
  id: string;
  stepId: string;
  parentId: string | null;
  kind: CriterionKind;
  ordinal: number;
  awardFor: string;
  branchLabel: string | null;
  marks: Prisma.Decimal | null;
  marksEach: Prisma.Decimal | null;
  chooseAtLeast: number | null;
  match: MatchMode;
  unitRequired: boolean;
  unitAccepted: string[];
  tags: string[];
  labels: string[];
  autoGradable: boolean;
  ordered: boolean | null;
  concepts: { ordinal: number; phrasings: string[] }[];
  partialRules: { id: string; reason: PartialReason; award: Prisma.Decimal; note: string | null }[];
  tagDemands: { tag: string; minCount: number }[];
}

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d));

/** Rows to a tree. Prisma cannot select a self-relation to unknown depth. */
function assemble(rows: CriterionRow[]): LoadedCriterion[] {
  const byId = new Map<string, LoadedCriterion>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      stepId: r.stepId,
      kind: r.kind,
      ordinal: r.ordinal,
      awardFor: r.awardFor,
      branchLabel: r.branchLabel,
      marks: num(r.marks),
      marksEach: num(r.marksEach),
      chooseAtLeast: r.chooseAtLeast,
      match: r.match,
      unitRequired: r.unitRequired,
      unitAccepted: r.unitAccepted,
      tags: r.tags,
      labels: r.labels,
      autoGradable: r.autoGradable,
      ordered: r.ordered,
      concepts: r.concepts,
      partialRules: r.partialRules.map((p) => ({
        id: p.id,
        reason: p.reason,
        award: Number(p.award),
        note: p.note,
      })),
      tagDemands: r.tagDemands,
      children: [],
    });
  }
  const roots: LoadedCriterion[] = [];
  for (const r of rows) {
    const node = byId.get(r.id);
    if (!node) continue;
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: LoadedCriterion[]) => {
    list.sort((a, b) => a.ordinal - b.ordinal);
    for (const c of list) sort(c.children);
  };
  sort(roots);
  return roots;
}

const RUBRIC_INCLUDE = {
  criteria: { select: CRITERION_SELECT, orderBy: { ordinal: "asc" } },
} as const;

interface RubricRow {
  id: string;
  externalId: string | null;
  paperSlug: string;
  questionNumber: number;
  variant: string;
  session: string | null;
  type: QuestionType;
  maxMarks: Prisma.Decimal;
  version: number;
  bookCode: string;
  chapter: number;
  subject: string;
  classNum: number;
  prompt: string | null;
  ordering: RubricOrdering;
  acceptEquivalentWording: boolean;
  needsReview: boolean;
  reviewNotes: string[];
  schemeFile: string | null;
  schemePage: number | null;
  criteria: CriterionRow[];
}

function hydrate(row: RubricRow): LoadedRubric {
  return {
    id: row.id,
    externalId: row.externalId,
    paperSlug: row.paperSlug,
    questionNumber: row.questionNumber,
    variant: row.variant,
    session: row.session,
    type: row.type,
    maxMarks: Number(row.maxMarks),
    version: row.version,
    bookCode: row.bookCode,
    chapter: row.chapter,
    subject: row.subject,
    classNum: row.classNum,
    prompt: row.prompt,
    ordering: row.ordering,
    acceptEquivalentWording: row.acceptEquivalentWording,
    needsReview: row.needsReview,
    reviewNotes: row.reviewNotes,
    schemeFile: row.schemeFile,
    schemePage: row.schemePage,
    criteria: assemble(row.criteria),
  };
}

/** The newest version of one rubric, by its database id. */
export async function loadRubric(id: string): Promise<LoadedRubric | null> {
  const row = await prisma.rubric.findFirst({
    where: { id },
    orderBy: { version: "desc" },
    include: RUBRIC_INCLUDE,
  });
  return row ? hydrate(row as unknown as RubricRow) : null;
}

/** By the authored id in `data/rubrics.json`, newest version. */
export async function loadRubricByExternalId(externalId: string): Promise<LoadedRubric | null> {
  const row = await prisma.rubric.findFirst({
    where: { externalId },
    orderBy: { version: "desc" },
    include: RUBRIC_INCLUDE,
  });
  return row ? hydrate(row as unknown as RubricRow) : null;
}

/**
 * Every rubric for one printed question — one per variant, where CBSE offers
 * "attempt either option A or B". Newest version of each.
 */
export async function loadRubricsForQuestion(
  paperSlug: string,
  questionNumber: number,
): Promise<LoadedRubric[]> {
  const rows = await prisma.rubric.findMany({
    where: { paperSlug, questionNumber },
    orderBy: [{ variant: "asc" }, { version: "desc" }],
    include: RUBRIC_INCLUDE,
  });
  const newest = new Map<string, LoadedRubric>();
  for (const row of rows) {
    if (!newest.has(row.variant)) newest.set(row.variant, hydrate(row as unknown as RubricRow));
  }
  return [...newest.values()];
}

/**
 * Refuse to grade against a rubric that does not add up.
 *
 * Called before a request is built rather than after a verdict comes back: a
 * rubric discovered to be broken after the model has read the page has already
 * cost money, and the mark it produced is out of the wrong total.
 */
export function assertGradable(rubric: LoadedRubric): void {
  const problems = rubricProblems(rubric);
  if (problems.length) {
    throw new ApiError(
      "CONFLICT",
      `Rubric ${rubric.externalId ?? rubric.id} cannot be graded against: ${problems.join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Importing from data/rubrics.json
// ---------------------------------------------------------------------------

/**
 * A stable UUID from a name, byte-identical to `prisma/seed.ts`'s `id()`.
 *
 * Mirrored rather than imported: that file constructs its own `PrismaClient`
 * and is a script, not a module the app may pull in. The derivation has to
 * match, though — an import that minted fresh ids would collide with the seed
 * on `@@unique([externalId, version])` the next time either one ran.
 */
function seedId(name: string): string {
  const h = createHash("sha256").update(`ncert-seed:${name}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${variant}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

interface JsonConcept {
  any?: string[];
}
interface JsonOption {
  id: string;
  awardFor: string;
  keywords?: JsonConcept[];
  tags?: string[];
}
interface JsonBranch {
  id: string;
  label?: string;
  awardFor: string;
  steps?: JsonStep[];
}
interface JsonStep {
  id: string;
  kind?: "step" | "choose" | "diagram" | "alternatives";
  awardFor: string;
  marks?: number;
  marksEach?: number;
  chooseAtLeast?: number;
  keywords?: JsonConcept[];
  options?: JsonOption[];
  alternatives?: JsonBranch[];
  partial?: { when: string; award: number; note?: string }[];
  unit?: { required?: boolean; accepted?: string[] };
  requireTags?: Record<string, number>;
  labels?: string[];
  match?: "all" | "any";
  ordered?: boolean;
  autoGradable?: boolean;
}
interface JsonRubric {
  id: string;
  paper: string;
  session?: string;
  questionNo: number;
  variant?: string;
  type: string;
  maxMarks: number;
  bookCode: string;
  chapter: number;
  class: number;
  subject: string;
  prompt?: string;
  ordering?: "ordered" | "unordered";
  acceptEquivalentWording?: boolean;
  needsReview?: boolean;
  reviewNotes?: string[];
  scheme?: { file?: string; page?: number };
  steps: JsonStep[];
}

const QUESTION_TYPES: Record<string, QuestionType> = {
  mcq: "MCQ",
  "assertion-reason": "ASSERTION_REASON",
  vsa: "VSA",
  sa: "SA",
  la: "LA",
  "case-study": "CASE_STUDY",
};

const KIND_FOR: Record<string, CriterionKind> = {
  step: "STEP",
  choose: "CHOOSE",
  diagram: "DIAGRAM",
  alternatives: "ALTERNATIVES",
};

export interface ImportReport {
  imported: string[];
  /** Authored id, and why it could not be stored. Never silently dropped. */
  rejected: { id: string; reason: string }[];
}

/**
 * Load `data/rubrics.json` into the database, idempotently.
 *
 * `prisma/seed.ts` already does this for the 22 rubrics whose shape the CHECK
 * constraints accept, and derives the same ids, so running both is running one.
 * This exists for the twenty-third. `kind: "alternatives"` now has enum members
 * (`ALTERNATIVES`, `BRANCH`) and a `branchLabel` column, but
 * `criterion_marks_by_kind` and `option_has_parent` in
 * `20260831100300_check_constraints` predate them and reject every such row.
 * When those two are widened this function stores the tree with no further
 * change; until then it reports the rejection by rubric id rather than skipping
 * quietly, because a question silently absent from the grader is a student
 * ungraded for no stated reason.
 */
export async function importRubricsFromFile(
  opts: { only?: string[] } = {},
): Promise<ImportReport> {
  const file = path.resolve(process.cwd(), "data/rubrics.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as
    | JsonRubric[]
    | { rubrics?: JsonRubric[]; items?: JsonRubric[] };
  const list = Array.isArray(parsed) ? parsed : (parsed.rubrics ?? parsed.items ?? []);
  const wanted = opts.only ? new Set(opts.only) : null;

  const report: ImportReport = { imported: [], rejected: [] };
  for (const r of list) {
    if (wanted && !wanted.has(r.id)) continue;
    try {
      await importOne(r);
      report.imported.push(r.id);
    } catch (err) {
      report.rejected.push({ id: r.id, reason: reasonFor(err) });
    }
  }
  return report;
}

function reasonFor(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { constraint?: string } | undefined;
    if (meta?.constraint) return `database constraint ${meta.constraint} rejected the row`;
  }
  if (err instanceof Error) {
    // Prisma wraps a CHECK violation in a ConnectorError whose useful half is
    // one clause deep inside a paragraph of Rust debug output. The constraint
    // name is the part a reader needs; printing the paragraph buries it.
    const check = /violates check constraint \\?"([a-z_]+)\\?"/.exec(err.message);
    if (check) return `database check constraint ${check[1]} rejected the row`;
    const fk = /Foreign key constraint[^\n]*`([a-zA-Z_]+)`/.exec(err.message);
    if (fk) return `foreign key ${fk[1]} rejected the change`;
    return err.message.split("\n").filter(Boolean).slice(-1)[0]?.trim() ?? String(err);
  }
  return String(err);
}

async function importOne(r: JsonRubric): Promise<void> {
  const rubricId = seedId(`rubric:${r.id}:1`);
  const data = {
    externalId: r.id,
    paperSlug: r.paper,
    questionNumber: r.questionNo,
    variant: r.variant ?? "",
    session: r.session ?? null,
    type: QUESTION_TYPES[r.type] ?? ("SA" as QuestionType),
    maxMarks: new Prisma.Decimal(r.maxMarks),
    version: 1,
    source: "CBSE_MARKING_SCHEME" as const,
    bookCode: r.bookCode,
    chapter: r.chapter,
    subject: r.subject,
    classNum: r.class,
    prompt: r.prompt ?? null,
    ordering: ((r.ordering ?? "unordered") === "ordered"
      ? "ORDERED"
      : "UNORDERED") as RubricOrdering,
    acceptEquivalentWording: r.acceptEquivalentWording ?? true,
    needsReview: r.needsReview ?? false,
    reviewNotes: r.reviewNotes ?? [],
    schemeFile: r.scheme?.file ?? null,
    schemePage: r.scheme?.page ?? null,
  };

  // A rubric somebody has already been graded against is not re-importable in
  // place, and should not be.
  //
  // `CriterionResult.rubricCriterion` is `onDelete: Restrict`, so the
  // delete-and-rebuild below is refused by the database the moment one grade
  // points at one of these rows — which is the schema protecting the thing it
  // exists to protect. A grade must stay attached to the rubric it was actually
  // given under, so "a correction is a new version, not an edit". Reported by
  // name rather than swallowed: an author who edited a rubric and saw nothing
  // happen would assume it took.
  const alreadyGraded = await prisma.criterionResult.count({
    where: { rubricCriterion: { rubricId } },
  });
  if (alreadyGraded > 0) {
    throw new Error(
      `already graded against (${alreadyGraded} criterion result(s)); a correction must be a new rubric version, not an edit in place`,
    );
  }

  // One transaction: a rubric whose criteria were deleted and not rebuilt is a
  // rubric that grades every answer out of zero.
  await prisma.$transaction(async (tx) => {
    await tx.rubric.upsert({
      where: { id: rubricId },
      create: { id: rubricId, ...data },
      update: data,
    });
    await tx.rubricCriterion.deleteMany({ where: { rubricId } });

    let ordinal = 0;
    for (const step of r.steps) {
      const kind = KIND_FOR[step.kind ?? "step"] ?? "STEP";
      const criterionId = seedId(`criterion:${r.id}:${step.id}`);
      await tx.rubricCriterion.create({
        data: {
          id: criterionId,
          rubricId,
          stepId: step.id,
          parentId: null,
          ordinal: ordinal++,
          kind,
          awardFor: step.awardFor.slice(0, 300),
          branchLabel: null,
          marks: kind === "CHOOSE" ? null : new Prisma.Decimal(step.marks ?? 0),
          marksEach: kind === "CHOOSE" ? new Prisma.Decimal(step.marksEach ?? 0) : null,
          chooseAtLeast: kind === "CHOOSE" ? (step.chooseAtLeast ?? 1) : null,
          match: ((step.match ?? "all") === "any" ? "ANY" : "ALL") as MatchMode,
          unitRequired: step.unit?.required ?? false,
          unitAccepted: step.unit?.accepted ?? [],
          tags: [],
          labels: step.labels ?? [],
          // Forced, never copied: a matcher cannot judge a photograph of a triangle.
          autoGradable: kind === "DIAGRAM" ? false : (step.autoGradable ?? true),
          ordered: step.ordered ?? null,
          concepts: {
            create: (step.keywords ?? [])
              .filter((c) => c.any?.length)
              .map((c, i) => ({
                id: seedId(`concept:${r.id}:${step.id}:${i}`),
                ordinal: i,
                phrasings: c.any as string[],
              })),
          },
          partialRules: {
            create: (step.partial ?? [])
              .filter((p) => PARTIAL_REASONS[p.when])
              .map((p) => ({
                id: seedId(`partial:${r.id}:${step.id}:${p.when}`),
                reason: PARTIAL_REASONS[p.when],
                award: new Prisma.Decimal(p.award),
                note: p.note ?? null,
              })),
          },
          tagDemands: {
            create: Object.entries(step.requireTags ?? {}).map(([tag, minCount]) => ({
              id: seedId(`tagreq:${r.id}:${step.id}:${tag}`),
              tag,
              minCount,
            })),
          },
        },
      });

      let childOrdinal = 0;
      for (const option of step.options ?? []) {
        // Qualified with its group, always: the contract scopes an option id per
        // group and `@@unique([rubricId, stepId])` scopes it per rubric. Anything
        // joining a result back to authored JSON splits on the slash.
        const optionStepId = `${step.id}/${option.id}`;
        await tx.rubricCriterion.create({
          data: {
            id: seedId(`criterion:${r.id}:${optionStepId}`),
            rubricId,
            stepId: optionStepId,
            parentId: criterionId,
            ordinal: childOrdinal++,
            kind: "OPTION",
            awardFor: option.awardFor.slice(0, 300),
            tags: option.tags ?? [],
            ordered: null,
            concepts: {
              create: (option.keywords ?? [])
                .filter((c) => c.any?.length)
                .map((c, i) => ({
                  id: seedId(`concept:${r.id}:${optionStepId}:${i}`),
                  ordinal: i,
                  phrasings: c.any as string[],
                })),
            },
          },
        });
      }

      // CBSE's OR inside a question. The group is worth `marks` once; every
      // branch must sum to that same figure, which `rubricProblems` re-checks
      // after the round trip.
      let branchOrdinal = 0;
      for (const branch of step.alternatives ?? []) {
        const branchStepId = `${step.id}/${branch.id}`;
        const branchId = seedId(`criterion:${r.id}:${branchStepId}`);
        await tx.rubricCriterion.create({
          data: {
            id: branchId,
            rubricId,
            stepId: branchStepId,
            parentId: criterionId,
            ordinal: branchOrdinal,
            kind: "BRANCH",
            awardFor: branch.awardFor.slice(0, 300),
            // The letter the paper prints, not the prose label: a student picks
            // a branch by its printed letter, and the column is VarChar(16).
            branchLabel: String.fromCharCode(65 + branchOrdinal),
            marks: new Prisma.Decimal(step.marks ?? 0),
            ordered: null,
          },
        });
        branchOrdinal++;

        let innerOrdinal = 0;
        for (const inner of branch.steps ?? []) {
          const innerKind = KIND_FOR[inner.kind ?? "step"] ?? "STEP";
          const innerStepId = `${branchStepId}/${inner.id}`;
          await tx.rubricCriterion.create({
            data: {
              id: seedId(`criterion:${r.id}:${innerStepId}`),
              rubricId,
              stepId: innerStepId,
              parentId: branchId,
              ordinal: innerOrdinal++,
              kind: innerKind,
              awardFor: inner.awardFor.slice(0, 300),
              marks: innerKind === "CHOOSE" ? null : new Prisma.Decimal(inner.marks ?? 0),
              marksEach: innerKind === "CHOOSE" ? new Prisma.Decimal(inner.marksEach ?? 0) : null,
              chooseAtLeast: innerKind === "CHOOSE" ? (inner.chooseAtLeast ?? 1) : null,
              match: ((inner.match ?? "all") === "any" ? "ANY" : "ALL") as MatchMode,
              unitRequired: inner.unit?.required ?? false,
              unitAccepted: inner.unit?.accepted ?? [],
              labels: inner.labels ?? [],
              autoGradable: innerKind === "DIAGRAM" ? false : (inner.autoGradable ?? true),
              ordered: inner.ordered ?? null,
              concepts: {
                create: (inner.keywords ?? [])
                  .filter((c) => c.any?.length)
                  .map((c, i) => ({
                    id: seedId(`concept:${r.id}:${innerStepId}:${i}`),
                    ordinal: i,
                    phrasings: c.any as string[],
                  })),
              },
              partialRules: {
                create: (inner.partial ?? [])
                  .filter((p) => PARTIAL_REASONS[p.when])
                  .map((p) => ({
                    id: seedId(`partial:${r.id}:${innerStepId}:${p.when}`),
                    reason: PARTIAL_REASONS[p.when],
                    award: new Prisma.Decimal(p.award),
                    note: p.note ?? null,
                  })),
              },
            },
          });
        }
      }
    }
  });
}
