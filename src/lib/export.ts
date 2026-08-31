/**
 * The egress layer: everything that lets a student's data leave the student.
 *
 * Two things do that, and they are in one file on purpose — a rule written
 * twice is a rule that disagrees with itself:
 *
 *  1. **The parent dashboard.** Someone who is not the student reads a summary
 *     of their work.
 *  2. **The school export.** A CSV lands in a spreadsheet on somebody's laptop
 *     and is thereafter beyond our reach entirely.
 *
 * The PRD names "Punitive Parental Telemetry" as a *cause* of study paralysis
 * and academic dishonesty. So the disclosure rule is stated once, here, and
 * both paths are built out of it:
 *
 * > **A parent — and therefore any export — sees trend, effort and
 * > chapter-level difficulty. Never raw doubt text, never an answer scan,
 * > never anything a student wrote believing it was between them and their
 * > teacher.**
 *
 * `assertDisclosable()` below is how that is enforced *at the query layer*
 * rather than in a view. `src/lib/parent.ts` runs every one of its Prisma
 * selects through it at module load, so a select that names `transcript`
 * crashes the module on import — in `next dev`, in `next build`, and in
 * `scripts/test-parent.mjs`. A field that is never fetched cannot leak through
 * a second view, a debug log, a JSON response someone forgot to prune, or a
 * CSV column added in a hurry the week before results day.
 *
 * ## Why this module has no runtime imports
 *
 * Only `import type`. It is the contract, and a contract that needs a database
 * connection to state itself cannot be checked by `node scripts/test-parent.mjs`
 * on a laptop with no Postgres. The test imports this file for real — not a
 * re-implementation of it — which is the only way "the boundary is tested" is
 * true rather than aspirational.
 */
import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// The disclosure policy
// ---------------------------------------------------------------------------

/**
 * Column names that must never appear in a select on a parent or export path,
 * whatever model they hang off.
 *
 * Matched by *name*, deliberately, rather than by model-qualified path. Prisma
 * selects nest, a new relation arrives every phase, and a policy keyed on
 * `answer.transcript` says nothing about `voiceNote.transcript`. A bare name is
 * blunter than it needs to be — and blunt is the correct failure direction for
 * a rule whose violation is a fourteen-year-old's private writing on their
 * parent's screen.
 */
export const FORBIDDEN_FIELDS: readonly string[] = [
  // What the student wrote, as OCR read it, and the photograph it was read from.
  "transcript",
  "transcriptLang",
  "transcriptStatus",
  "transcriptStart",
  "transcriptEnd",
  "ocrText",
  "storageKey",
  "sha256",
  // Words addressed to the student by a person who was marking their work.
  // A parent reading their teacher's feedback over their shoulder changes what
  // the teacher is willing to write, which costs the student the feedback.
  "comment",
  "note",
  "notes",
  "reviewNotes",
  "unmarkedReason",
  // The map of exactly what was wrong on the page, line by line.
  "label",
  "labels",
  "awardFor",
  // Operational detail that reads as blame ("upload failed: page 3 unreadable").
  "failureReason",
  // Contact details of anybody. A parent link is consent to see schoolwork, not
  // a directory lookup.
  "phone",
  "email",
  // The question stem is CBSE's, not the student's — but it is also the thing
  // that turns a chapter-level summary into "she got question 27 wrong", which
  // is the interrogation this dashboard exists to avoid.
  "prompt",
] as const;

/**
 * Relations a parent-path select must not traverse at all.
 *
 * The division of labour between this list and `FORBIDDEN_FIELDS` is worth
 * stating, because it is the difference between a rule and a habit:
 *
 *  - **A field is banned** when the column is private but the model has other
 *    columns that are not. `Answer` is the example — `transcript` is what the
 *    student wrote, but `Answer.id` is a foreign key, and the chapter export
 *    genuinely needs to walk `gradingResult → answer → submission → student`.
 *    Banning the field is enough there, because a relation can only ever be
 *    fetched through an explicit `select` (both `include` and a select-less
 *    relation are rejected below), so there is no way to reach `transcript`
 *    without naming it, and naming it fails.
 *  - **A relation is banned** when the model has *nothing* a parent may see, so
 *    that any traversal into it is a mistake whatever columns it names. A voice
 *    note's very existence and length is private; a highlight span is the
 *    line-by-line map of what was wrong on the page; a criterion result is the
 *    same thing in words.
 */
export const FORBIDDEN_RELATIONS: readonly string[] = [
  "pages",
  "submissionPage",
  "answerPages",
  "voiceNotes",
  "highlights",
  "highlightSpans",
  "criterionResults",
  "reviews",
  "review",
  "criteria",
] as const;

/**
 * Keys that are query *structure*, not field selection: they may hold nested
 * objects without those objects being a relation select.
 */
const STRUCTURAL_KEYS: readonly string[] = [
  "select",
  "where",
  "orderBy",
  "take",
  "skip",
  "distinct",
  "cursor",
  "by",
  "having",
  "_count",
  "_sum",
  "_avg",
  "_min",
  "_max",
  "AND",
  "OR",
  "NOT",
  "in",
  "notIn",
  "gte",
  "lte",
  "gt",
  "lt",
  "equals",
  "not",
  "some",
  "every",
  "none",
  "is",
  "isNot",
];

/** Thrown by `assertDisclosable`. Not an `ApiError`: this is a programming */
/** error at module load, not something a request did. */
export class DisclosureError extends Error {
  readonly violations: string[];
  constructor(where: string, violations: string[]) {
    super(
      `Disclosure policy violated in ${where}:\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        `\n\nSee the rule at the top of src/lib/export.ts. A parent sees trend, effort and\n` +
        `chapter-level difficulty — never what the student wrote. If this field really is\n` +
        `safe to disclose, change FORBIDDEN_FIELDS deliberately and say why in the commit.`,
    );
    this.name = "DisclosureError";
    this.violations = violations;
  }
}

/**
 * Walk a Prisma select tree and throw unless everything in it may be disclosed.
 *
 * Three separate things fail here, and each one is a real way this leaks:
 *
 *  - **A forbidden field name, at any depth.** The obvious case.
 *  - **`include` anywhere.** `include` fetches *every* scalar on the related
 *    row, so it is a leak by omission: the row grows a `transcript` column two
 *    phases from now and nobody edits this file. Only `select` is allowed.
 *  - **A relation object with no `select` inside it.** Same failure, spelled
 *    differently.
 *
 * It is deliberately structural rather than a check on the returned *rows*.
 * Filtering a result after fetching it means the private column was read out of
 * Postgres, crossed the wire, sat in a log line, and was then dropped by a view
 * that the next view will not copy.
 */
export function assertDisclosable(select: unknown, where: string): void {
  const violations: string[] = [];
  walk(select, "", violations);
  if (violations.length) throw new DisclosureError(where, violations);
}

function walk(node: unknown, path: string, violations: string[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}[${i}]`, violations));
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;

    if (key === "include") {
      violations.push(`${childPath} — use \`select\`; \`include\` fetches every scalar on the relation`);
    }
    if (FORBIDDEN_FIELDS.includes(key)) {
      violations.push(`${childPath} — a student wrote this, or it identifies them off-platform`);
    }
    if (FORBIDDEN_RELATIONS.includes(key)) {
      violations.push(`${childPath} — this relation is the student's own words or their handwriting`);
    }

    const isPlainObject =
      value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

    if (isPlainObject && !STRUCTURAL_KEYS.includes(key)) {
      const inner = value as Record<string, unknown>;
      if (!("select" in inner) && !("_count" in inner)) {
        violations.push(`${childPath} — a relation must name its columns with \`select\``);
      }
    }

    walk(value, childPath, violations);
  }
}

/**
 * The narrower check for a `where` clause.
 *
 * A filter may navigate a relation the select may not fetch — walking
 * `gradingResult → answer → submission → studentId` is how a grade is
 * attributed to a student at all, and a foreign key is not a disclosure. What a
 * filter must never do is *mention* a private column: `where: { answer: {
 * transcript: { contains: "…" } } }` discloses the contents of the transcript
 * one boolean at a time without ever selecting it, which is the oracle shape
 * that a select-only check would miss entirely.
 */
export function assertFilterSafe(where: unknown, at: string): void {
  const violations: string[] = [];
  filterWalk(where, "", violations);
  if (violations.length) throw new DisclosureError(`${at} (where clause)`, violations);
}

function filterWalk(node: unknown, path: string, violations: string[]): void {
  if (node === null || typeof node !== "object" || node instanceof Date) return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => filterWalk(child, `${path}[${i}]`, violations));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_FIELDS.includes(key)) {
      violations.push(`${childPath} — filtering on a private column is an oracle over its contents`);
    }
    filterWalk(value, childPath, violations);
  }
}

/**
 * `assertDisclosable`, applied and returned, so a select can be *defined*
 * guarded rather than defined and then checked further down where a merge
 * conflict can separate the two.
 *
 * ```ts
 * const ATTEMPT = disclosable<Prisma.AttemptSelect>({ subject: true }, "attempt");
 * ```
 */
export function disclosable<T>(select: T, where: string): T {
  assertDisclosable(select, where);
  return select;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One output column. `header` is what the school's import wizard maps against,
 * so it is snake_case, ASCII, and stable — renaming one is a breaking change to
 * somebody's saved column mapping, which they will discover on results day.
 */
export interface CsvColumn<Row> {
  header: string;
  /** What this column means, for the docs table `/api/export/` serves. */
  describe: string;
  value: (row: Row) => string | number | null | undefined;
}

/**
 * Quote a single cell per RFC 4180, and defuse spreadsheet formula injection.
 *
 * The formula guard is not paranoia about a hostile student. A `displayName` of
 * `=cmd|…` is unlikely; a school that pastes our CSV into a shared sheet where
 * one cell silently evaluates is not. Excel, LibreOffice and Sheets all treat a
 * leading `= + - @` — and a leading tab or CR — as the start of a formula, so a
 * single quote is prefixed, which every one of them renders as plain text.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Rows to a CSV document.
 *
 * CRLF line endings and a UTF-8 BOM, both for the same reason: this file's
 * destination is Excel on a school office PC, and without the BOM every Indian
 * name with a Devanagari character or a diacritic arrives as mojibake. The
 * cost is that a naive `head -1` shows the BOM; that is the smaller wrong.
 */
export function toCsv<Row>(rows: readonly Row[], columns: readonly CsvColumn<Row>[]): string {
  const lines: string[] = [columns.map((c) => escapeCsvCell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvCell(c.value(row))).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** ISO-8601 in UTC, or empty. A school MIS parses one format or none. */
export function isoOrBlank(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** A Prisma `Decimal`, a number, or null — as a fixed-2 string, or empty. */
export function decimalOrBlank(value: unknown, places = 2): string {
  if (value === null || value === undefined) return "";
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n.toFixed(places) : "";
}

// ---------------------------------------------------------------------------
// The two datasets
// ---------------------------------------------------------------------------

/**
 * One row per timed paper a student sat.
 *
 * Every column here is something a parent may see. That is not a coincidence
 * and not a coding standard — it is the rule at the top of this file applied to
 * the other egress path. An export is a parent dashboard with no login and no
 * expiry, handed to a third party, so it cannot be more permissive than the
 * screen.
 *
 * `score_percent` *is* a bare percentage, and that is correct here: this file
 * feeds a school's MIS, which needs a number to put in a column. The
 * "never a bare percentage" rule belongs to `src/lib/insights.ts`, which
 * addresses a parent in words.
 */
export interface AttemptExportRow {
  studentId: string;
  studentName: string;
  classNum: number;
  subject: string;
  paperSlug: string | null;
  startedAt: Date;
  submittedAt: Date | null;
  durationMs: number;
  status: string;
  maxMarks: number;
  totalScore: unknown;
  questionsTotal: number;
  questionsAttempted: number;
}

export const ATTEMPT_COLUMNS: readonly CsvColumn<AttemptExportRow>[] = [
  { header: "student_id", describe: "Stable UUID. The join key for a school MIS.", value: (r) => r.studentId },
  { header: "student_name", describe: "Display name as the student entered it.", value: (r) => r.studentName },
  { header: "class_num", describe: "9 or 10.", value: (r) => r.classNum },
  { header: "subject", describe: "Science, Mathematics, Social Science, …", value: (r) => r.subject },
  { header: "paper_slug", describe: "Which paper, from data/papers.json. Blank for a loose attempt.", value: (r) => r.paperSlug },
  { header: "started_at", describe: "ISO-8601 UTC.", value: (r) => isoOrBlank(r.startedAt) },
  { header: "submitted_at", describe: "ISO-8601 UTC. Blank while still in progress.", value: (r) => isoOrBlank(r.submittedAt) },
  { header: "duration_min", describe: "Minutes the student spent, rounded.", value: (r) => Math.round(r.durationMs / 60000) },
  { header: "status", describe: "IN_PROGRESS | SUBMITTED.", value: (r) => r.status },
  { header: "max_marks", describe: "Denominator of the paper.", value: (r) => r.maxMarks },
  { header: "total_score", describe: "Marks awarded. Blank when nothing has been marked yet.", value: (r) => decimalOrBlank(r.totalScore) },
  {
    header: "score_percent",
    describe: "total_score / max_marks × 100, one decimal. Blank when unscored — never 0.",
    value: (r) => {
      const score = r.totalScore === null || r.totalScore === undefined ? null : Number(String(r.totalScore));
      if (score === null || !Number.isFinite(score) || !r.maxMarks) return "";
      return ((score / r.maxMarks) * 100).toFixed(1);
    },
  },
  { header: "questions_total", describe: "Questions in the paper's mark grid.", value: (r) => r.questionsTotal },
  { header: "questions_attempted", describe: "Questions the student did not leave blank.", value: (r) => r.questionsAttempted },
];

/** One row per student × chapter: the chapter-level difficulty a parent sees. */
export interface ChapterExportRow {
  studentId: string;
  studentName: string;
  classNum: number;
  subject: string;
  bookCode: string;
  chapter: number;
  chapterTitle: string;
  answersGraded: number;
  marksAwarded: number;
  marksPossible: number;
  lastGradedAt: Date | null;
}

export const CHAPTER_COLUMNS: readonly CsvColumn<ChapterExportRow>[] = [
  { header: "student_id", describe: "Stable UUID.", value: (r) => r.studentId },
  { header: "student_name", describe: "Display name.", value: (r) => r.studentName },
  { header: "class_num", describe: "9 or 10.", value: (r) => r.classNum },
  { header: "subject", describe: "Subject the chapter belongs to.", value: (r) => r.subject },
  { header: "book_code", describe: "NCERT book code, e.g. jesc1. Joins to data/manifest.json.", value: (r) => r.bookCode },
  { header: "chapter", describe: "Chapter number within the book.", value: (r) => r.chapter },
  { header: "chapter_title", describe: "Title from the manifest. Blank for the Hindi books, whose titles NCERT does not publish.", value: (r) => r.chapterTitle },
  { header: "answers_graded", describe: "How many answers on this chapter have a current grade.", value: (r) => r.answersGraded },
  { header: "marks_awarded", describe: "Sum of marks awarded across those answers.", value: (r) => decimalOrBlank(r.marksAwarded) },
  { header: "marks_possible", describe: "Sum of the denominators.", value: (r) => decimalOrBlank(r.marksPossible) },
  {
    header: "score_percent",
    describe: "marks_awarded / marks_possible × 100, one decimal.",
    value: (r) => (r.marksPossible > 0 ? ((r.marksAwarded / r.marksPossible) * 100).toFixed(1) : ""),
  },
  { header: "last_graded_at", describe: "ISO-8601 UTC of the most recent grade on this chapter.", value: (r) => isoOrBlank(r.lastGradedAt) },
];

export type ExportDataset = "attempts" | "chapters";

/** The documentation `/api/export/` serves when asked for no dataset. */
export function columnMap(): Record<ExportDataset, Array<{ header: string; describe: string }>> {
  return {
    attempts: ATTEMPT_COLUMNS.map((c) => ({ header: c.header, describe: c.describe })),
    chapters: CHAPTER_COLUMNS.map((c) => ({ header: c.header, describe: c.describe })),
  };
}

// ---------------------------------------------------------------------------
// The selects the export runs. Guarded by the same rule as the dashboard.
// ---------------------------------------------------------------------------

/**
 * Typed against `Prisma.AttemptSelect` so a column that no longer exists is a
 * compile error, and run through `disclosable()` so a column that exists but
 * must not leave is a load-time crash.
 */
export const EXPORT_ATTEMPT_SELECT = disclosable(
  {
    id: true,
    studentId: true,
    classNum: true,
    subject: true,
    paperSlug: true,
    startedAt: true,
    submittedAt: true,
    durationMs: true,
    status: true,
    maxMarks: true,
    totalScore: true,
    student: { select: { displayName: true } },
    questions: { select: { attempted: true } },
  } satisfies Prisma.AttemptSelect,
  "EXPORT_ATTEMPT_SELECT",
);
