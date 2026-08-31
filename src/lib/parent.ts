/**
 * The parent↔student edge, and a query layer that cannot return a student's
 * private writing.
 *
 * ============================================================================
 * 1. What the edge is, under a frozen schema
 * ============================================================================
 *
 * `UserRole` has `PARENT`. There is no `ParentLink` model, and
 * `prisma/schema.prisma` is frozen, so the edge is assembled from what exists:
 *
 *   **identity**  a `User` row with `role: PARENT`. The role on its own grants
 *                 nothing at all — every read below needs a consent record too —
 *                 which is why it is safe for it to be just a role.
 *
 *   **discovery** the household phone number. `prisma/seed.ts` deliberately
 *                 seeds two siblings sharing their parent's number across two
 *                 scopes, which is the case `@@unique([scopeId, phone])` exists
 *                 to permit. A parent types that number into "find my children"
 *                 and both siblings are found, in both scopes. Discovery
 *                 discloses nothing: it only creates a *request*, and the route
 *                 answers identically whether or not the number matched anyone,
 *                 because "no student with that number" is an account-existence
 *                 oracle.
 *
 *   **consent**   an append-only event ledger, `parentLinkLedger()` below.
 *                 REQUESTED / GRANTED / DECLINED / REVOKED, reduced to a
 *                 current state on every read.
 *
 * ### What we actually need, precisely
 *
 * The ledger is a working stand-in, not a good home. It is a file: it does not
 * participate in a transaction with the `users` row it references, it cannot be
 * indexed or joined, `ON DELETE CASCADE` does not reach it, and two app
 * instances behind a load balancer do not share it. What this lane needs from
 * whoever unfreezes the schema is exactly this, and nothing more:
 *
 * ```prisma
 * enum ParentLinkStatus { PENDING ACTIVE DECLINED REVOKED }
 *
 * model ParentLink {
 *   id             String   @id @default(uuid()) @db.Uuid
 *   parentId       String   @db.Uuid
 *   parent         User     @relation("ParentOf", fields: [parentId], references: [id], onDelete: Cascade)
 *   studentId      String   @db.Uuid
 *   student        User     @relation("ChildOf",  fields: [studentId], references: [id], onDelete: Cascade)
 *   /// The student's scope. A household can straddle two: one child at a
 *   /// school tenant, one on the public scope, one parent.
 *   studentScopeId String   @db.Uuid
 *   status         ParentLinkStatus @default(PENDING)
 *   requestedAt    DateTime @default(now()) @db.Timestamptz(6)
 *   /// When the *student* granted or revoked. NULL while PENDING.
 *   decidedAt      DateTime? @db.Timestamptz(6)
 *   @@unique([parentId, studentId])
 *   @@index([studentId, status])
 *   @@index([parentId, status])
 * }
 * ```
 *
 * Plus `parents ParentLink[] @relation("ChildOf")` / `children ParentLink[]
 * @relation("ParentOf")` on `User`. A separate `ParentLinkEvent` table would be
 * better still — the history of who revoked and when is evidence, the way
 * `GradingResult` is — but the four columns above are the minimum.
 *
 * ============================================================================
 * 2. What a parent may see, and where that is enforced
 * ============================================================================
 *
 * > Trend, effort, and chapter-level difficulty. Never raw doubt text, never an
 * > answer scan, never anything a student wrote believing it was between them
 * > and their teacher.
 *
 * Enforced **at the query layer**, in two ways that are both load-bearing:
 *
 *  - Every select in this file is wrapped in `disclosable()` from
 *    `src/lib/export.ts`. It runs at module load, so a select that names
 *    `transcript`, or that uses `include`, or that pulls a relation without
 *    naming its columns, crashes this module on import — in `next dev`, in
 *    `next build`, and in `node scripts/test-parent.mjs`. The private column is
 *    never fetched, so it is never in a row, a log line, a JSON response or a
 *    CSV, and there is no second view that can forget to filter it.
 *
 *  - Every query function takes a `ConsentedLink`, a branded type that only
 *    `requireConsentedLink()` can produce. There is no overload that takes a
 *    student id, so "read this student's chapters" is not expressible without
 *    first having proved a live consent record exists. That is deliberately a
 *    *compile-time* obstacle: a runtime check is one forgotten `await` away
 *    from being no check at all.
 *
 * The specific things a parent never sees, and the column each one is:
 * `Answer.transcript` (what they wrote), `SubmissionPage.ocrText` /
 * `storageKey` (the photograph of their handwriting), `VoiceNote.*` (the
 * spoken note their teacher recorded for them), `GradingResult.comment` and
 * `CriterionResult.note` (their teacher's words to them), `HighlightSpan.label`
 * (the line-by-line map of what was wrong), `EvaluatorReview.notes`,
 * `Submission.failureReason`, and anybody's `phone` or `email`.
 *
 * This schema has no `doubts` table. The PRD's "raw doubt text" is, in the data
 * that exists today, `Answer.transcript` and `VoiceNote.transcript`. Both are
 * forbidden. When a doubts table lands, its text column goes in
 * `FORBIDDEN_FIELDS` in the same commit that creates it.
 *
 * ============================================================================
 * 3. The conflict this lane cannot resolve on its own
 * ============================================================================
 *
 * Under India's DPDP Act 2023 a child under 18 is processed on **verifiable
 * parental consent**: legally the parent is the consent-giver. The PRD's own
 * problem statement asks us to protect the student from the parent. Those point
 * opposite ways, and the honest thing is to say so rather than quietly pick:
 *
 *  - What is built here: the *lawful basis* for processing is the parent's, and
 *    is unaffected by anything in this file. What the student controls is
 *    narrower and different — **disclosure of their work to a specific named
 *    person**, which they grant and can withdraw, visibly.
 *  - That is a product decision with a legal edge, and it is not a lane's to
 *    make. If counsel decides a guardian's DPDP consent must also compel
 *    disclosure, the change is one function — `requireConsentedLink()` — and
 *    the ledger still records that the student did not agree, which is the
 *    part that must survive either way.
 *  - What is *not* negotiable in either reading, because it is a product
 *    promise rather than a legal one: the forbidden fields above. Nothing a
 *    student wrote in confidence is disclosed to anyone, under any consent
 *    model, without them being told.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import prisma from "@/lib/db";
import { assertFilterSafe, disclosable, EXPORT_ATTEMPT_SELECT } from "@/lib/export";
import type { AttemptExportRow, ChapterExportRow } from "@/lib/export";
import { getChapter } from "@/lib/manifest";
import type { ChapterSignal, HouseholdSnapshot, SubjectTrend, WeekEffort } from "@/lib/insights";

// ---------------------------------------------------------------------------
// The consent ledger
// ---------------------------------------------------------------------------

export type LinkEventType = "REQUESTED" | "GRANTED" | "DECLINED" | "REVOKED";
export type ParentLinkStatus = "PENDING" | "ACTIVE" | "DECLINED" | "REVOKED";

export interface LinkEvent {
  /** ISO-8601. */
  at: string;
  type: LinkEventType;
  parentUserId: string;
  studentUserId: string;
  studentScopeId: string;
  /**
   * The session user who caused this event. A GRANTED or REVOKED written by
   * anybody but the student is a bug, and recording the actor is what makes
   * that auditable rather than arguable.
   */
  actorUserId: string;
  /** The client's Idempotency-Key, so a retried POST is visibly the same action. */
  idempotencyKey?: string;
}

export interface ParentLink {
  parentUserId: string;
  studentUserId: string;
  studentScopeId: string;
  status: ParentLinkStatus;
  requestedAt: Date;
  /** When the student granted, declined or revoked. Null while PENDING. */
  decidedAt: Date | null;
  /** Every event, oldest first. The student is shown this; see ConsentGate. */
  history: LinkEvent[];
}

/**
 * Append-only, one JSON object per line, under the gitignored `.storage/`.
 *
 * Append-only rather than a mutable record for the same reason `GradingResult`
 * is: a consent that was withdrawn is not the absence of a consent. A student
 * asked to explain why a parent stopped seeing their work — or a parent asking
 * whether they ever had access — needs the sequence, not the current value.
 */
export function parentLinkLedger(): string {
  return (
    process.env.PARENT_LINK_LEDGER ??
    path.join(process.cwd(), ".storage", "parent-links", "ledger.jsonl")
  );
}

async function readEvents(): Promise<LinkEvent[]> {
  let text: string;
  try {
    text = await readFile(parentLinkLedger(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: LinkEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as LinkEvent);
    } catch {
      // A half-written last line after a crash. Skipping it loses at most the
      // event in flight; throwing would take the whole dashboard down with it.
      continue;
    }
  }
  return events;
}

async function appendEvent(event: LinkEvent): Promise<void> {
  const file = parentLinkLedger();
  await mkdir(path.dirname(file), { recursive: true });
  // O_APPEND: a single short line is written atomically, so two requests
  // landing together interleave as two lines rather than one corrupt one.
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

function key(parentUserId: string, studentUserId: string): string {
  return `${parentUserId} ${studentUserId}`;
}

/**
 * Fold the event log into the current state of every link.
 *
 * The transitions, and the reasoning behind the two that are not obvious:
 *
 *  - `REQUESTED` on a link that was REVOKED or DECLINED re-opens it as PENDING.
 *    People change their minds, and phones get replaced. The whole history
 *    stays on the link and is shown to the student, so a parent who asks
 *    repeatedly after being refused is visible to the person refusing —
 *    which is the mitigation that matters. Rate limiting is not built here and
 *    is noted as a gap.
 *  - `GRANTED` is only honoured from PENDING. A revoked link cannot be revived
 *    by a stale GRANT event arriving late; the parent has to ask again.
 */
export function reduceLinks(events: readonly LinkEvent[]): ParentLink[] {
  const byPair = new Map<string, ParentLink>();

  for (const event of events) {
    const k = key(event.parentUserId, event.studentUserId);
    const at = new Date(event.at);
    let link = byPair.get(k);

    if (!link) {
      if (event.type !== "REQUESTED") continue; // an event about a link nobody asked for
      link = {
        parentUserId: event.parentUserId,
        studentUserId: event.studentUserId,
        studentScopeId: event.studentScopeId,
        status: "PENDING",
        requestedAt: at,
        decidedAt: null,
        history: [event],
      };
      byPair.set(k, link);
      continue;
    }

    link.history.push(event);

    switch (event.type) {
      case "REQUESTED":
        if (link.status === "REVOKED" || link.status === "DECLINED") {
          link.status = "PENDING";
          link.requestedAt = at;
          link.decidedAt = null;
        }
        break;
      case "GRANTED":
        if (link.status === "PENDING") {
          link.status = "ACTIVE";
          link.decidedAt = at;
        }
        break;
      case "DECLINED":
        if (link.status === "PENDING") {
          link.status = "DECLINED";
          link.decidedAt = at;
        }
        break;
      case "REVOKED":
        if (link.status === "ACTIVE" || link.status === "PENDING") {
          link.status = "REVOKED";
          link.decidedAt = at;
        }
        break;
    }
  }

  return [...byPair.values()];
}

export async function linksForParent(parentUserId: string): Promise<ParentLink[]> {
  return reduceLinks(await readEvents()).filter((l) => l.parentUserId === parentUserId);
}

export async function linksForStudent(studentUserId: string): Promise<ParentLink[]> {
  return reduceLinks(await readEvents()).filter((l) => l.studentUserId === studentUserId);
}

/**
 * Record a request. Idempotent: asking twice for a link that is already PENDING
 * or ACTIVE writes nothing, so a retried POST on a dropped connection does not
 * fill a student's screen with duplicate requests.
 */
export async function requestLink(input: {
  parentUserId: string;
  studentUserId: string;
  studentScopeId: string;
  idempotencyKey?: string;
  now?: Date;
}): Promise<{ created: boolean; status: ParentLinkStatus }> {
  const existing = (await linksForParent(input.parentUserId)).find(
    (l) => l.studentUserId === input.studentUserId,
  );
  if (existing && (existing.status === "PENDING" || existing.status === "ACTIVE")) {
    return { created: false, status: existing.status };
  }
  await appendEvent({
    at: (input.now ?? new Date()).toISOString(),
    type: "REQUESTED",
    parentUserId: input.parentUserId,
    studentUserId: input.studentUserId,
    studentScopeId: input.studentScopeId,
    actorUserId: input.parentUserId,
    idempotencyKey: input.idempotencyKey,
  });
  return { created: true, status: "PENDING" };
}

/**
 * The student's decision. `studentUserId` is the acting user from the session
 * and nothing else — there is no parameter here a parent could set to grant
 * themselves access, which is the whole reason this takes an actor at all.
 */
export async function recordDecision(input: {
  studentUserId: string;
  parentUserId: string;
  decision: "GRANT" | "DECLINE" | "REVOKE";
  idempotencyKey?: string;
  now?: Date;
}): Promise<ParentLink> {
  const links = await linksForStudent(input.studentUserId);
  const link = links.find((l) => l.parentUserId === input.parentUserId);
  if (!link) throw ApiError.notFound("Request");

  const type: LinkEventType =
    input.decision === "GRANT" ? "GRANTED" : input.decision === "DECLINE" ? "DECLINED" : "REVOKED";

  // Idempotent: deciding the same way twice is a no-op rather than a second
  // ledger line, so a phone that retries a tap does not write history twice.
  const alreadyThere =
    (type === "GRANTED" && link.status === "ACTIVE") ||
    (type === "DECLINED" && link.status === "DECLINED") ||
    (type === "REVOKED" && link.status === "REVOKED");
  if (alreadyThere) return link;

  if (type === "GRANTED" && link.status !== "PENDING") {
    throw new ApiError("CONFLICT", "That request is no longer open. Ask them to send a new one.");
  }

  await appendEvent({
    at: (input.now ?? new Date()).toISOString(),
    type,
    parentUserId: input.parentUserId,
    studentUserId: input.studentUserId,
    studentScopeId: link.studentScopeId,
    actorUserId: input.studentUserId,
    idempotencyKey: input.idempotencyKey,
  });

  const updated = (await linksForStudent(input.studentUserId)).find(
    (l) => l.parentUserId === input.parentUserId,
  );
  return updated ?? link;
}

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

declare const consented: unique symbol;

/**
 * Proof that a live, student-granted consent exists for this pair, right now.
 *
 * Branded so that it cannot be constructed anywhere but `requireConsentedLink`.
 * Every query below takes one, so "read this student's marks" is not a sentence
 * this module can say without first having said "and they agreed".
 */
export interface ConsentedLink {
  readonly [consented]: true;
  parentUserId: string;
  studentUserId: string;
  studentScopeId: string;
  grantedAt: Date;
}

/**
 * The single gate. Re-reads the ledger every call, deliberately: **revocation
 * has to bite on the next request**, not on the next deploy or the next cache
 * expiry, or "you can take this away whenever you like" was not true.
 */
export async function requireConsentedLink(
  parentUserId: string,
  studentUserId: string,
): Promise<ConsentedLink> {
  const link = (await linksForParent(parentUserId)).find(
    (l) => l.studentUserId === studentUserId,
  );
  // One message for "no such link", "not yours", "still pending" and "revoked".
  // A 403 that distinguishes them tells a stranger which user ids are real, and
  // tells a parent whose access was withdrawn exactly when it happened.
  if (!link || link.status !== "ACTIVE" || !link.decidedAt) {
    throw ApiError.forbidden("You do not have access to this.");
  }
  return {
    parentUserId: link.parentUserId,
    studentUserId: link.studentUserId,
    studentScopeId: link.studentScopeId,
    grantedAt: link.decidedAt,
  } as ConsentedLink;
}

// ---------------------------------------------------------------------------
// The selects. Guarded at module load — see the header.
// ---------------------------------------------------------------------------

/** Who the child is. No phone, no email: a link is not a directory lookup. */
export const PARENT_STUDENT_SELECT = disclosable(
  {
    id: true,
    displayName: true,
    studentProfile: { select: { classNum: true, schoolName: true, language: true } },
  } satisfies Prisma.UserSelect,
  "PARENT_STUDENT_SELECT",
);

/**
 * Effort and trend. `durationMs` and `startedAt` are the effort half — the part
 * a report card never carries and the only part a parent can actually support.
 */
export const PARENT_ATTEMPT_SELECT = disclosable(
  {
    id: true,
    subject: true,
    classNum: true,
    startedAt: true,
    submittedAt: true,
    durationMs: true,
    status: true,
    maxMarks: true,
    totalScore: true,
  } satisfies Prisma.AttemptSelect,
  "PARENT_ATTEMPT_SELECT",
);

/**
 * Chapter-level difficulty. The rubric is what carries `bookCode` and
 * `chapter`; `prompt` and `reviewNotes` on the same row are forbidden, and the
 * guard is what stops a future `...rubricFields` spread from bringing them.
 *
 * Note what is *absent*: `comment`, the feedback the evaluator wrote for the
 * student, and any traversal into `criterionResults`, which is the line-by-line
 * account of what they got wrong. A parent gets the chapter. The interrogation
 * material stays with the student.
 */
/**
 * The chapter export's join. It walks into `answer` for one reason — a
 * `GradingResult` reaches its student only through `answer.submission` — and
 * names two foreign keys and a display name on the way. `transcript` is a
 * forbidden *field*, so the guard rejects this select the moment anybody adds
 * it, which is why the traversal itself is safe to allow. See the note on the
 * two lists in src/lib/export.ts.
 */
export const EXPORT_CHAPTER_SELECT = disclosable(
  {
    awardedMarks: true,
    maxMarks: true,
    createdAt: true,
    rubric: { select: { bookCode: true, chapter: true, subject: true, classNum: true } },
    answer: {
      select: {
        submission: {
          select: { studentId: true, student: { select: { displayName: true } } },
        },
      },
    },
  } satisfies Prisma.GradingResultSelect,
  "EXPORT_CHAPTER_SELECT",
);

export const PARENT_GRADE_SELECT = disclosable(
  {
    awardedMarks: true,
    maxMarks: true,
    unmarkedCount: true,
    source: true,
    createdAt: true,
    rubric: { select: { bookCode: true, chapter: true, subject: true, classNum: true } },
  } satisfies Prisma.GradingResultSelect,
  "PARENT_GRADE_SELECT",
);

// ---------------------------------------------------------------------------
// The queries. Each one needs a ConsentedLink; none takes a bare student id.
// ---------------------------------------------------------------------------

export type ParentStudent = Prisma.UserGetPayload<{ select: typeof PARENT_STUDENT_SELECT }>;
export type ParentAttempt = Prisma.AttemptGetPayload<{ select: typeof PARENT_ATTEMPT_SELECT }>;
export type ParentGrade = Prisma.GradingResultGetPayload<{ select: typeof PARENT_GRADE_SELECT }>;

export async function childOf(link: ConsentedLink): Promise<ParentStudent | null> {
  return prisma.user.findFirst({
    where: { id: link.studentUserId, scopeId: link.studentScopeId },
    select: PARENT_STUDENT_SELECT,
  });
}

/** Newest first. `take` is a cap, not a page: a parent dashboard is a summary. */
export async function attemptsFor(link: ConsentedLink, take = 60): Promise<ParentAttempt[]> {
  return prisma.attempt.findMany({
    where: { studentId: link.studentUserId },
    orderBy: { startedAt: "desc" },
    take,
    select: PARENT_ATTEMPT_SELECT,
  });
}

/**
 * Current grades for this student.
 *
 * The `where` navigates `answer.submission.studentId` — a foreign key — which
 * is the only route from a grade to its student. That is navigation, not
 * disclosure: `assertFilterSafe` checks the filter never *mentions* a forbidden
 * column (a `transcript: { contains: … }` filter would be an oracle even though
 * nothing is selected), while the select above never fetches one.
 *
 * `supersededBy: null` is what makes these the *current* grades: grading is
 * append-only, so an overridden AI mark is still a row, and counting both would
 * show a parent every answer twice at two different marks.
 */
export async function gradesFor(link: ConsentedLink, take = 400): Promise<ParentGrade[]> {
  const where = {
    supersededBy: null,
    answer: { submission: { studentId: link.studentUserId } },
  } satisfies Prisma.GradingResultWhereInput;
  assertFilterSafe(where, "gradesFor");

  return prisma.gradingResult.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
    select: PARENT_GRADE_SELECT,
  });
}

/**
 * How many answers are sitting with a human. A count, never the submissions
 * themselves — there is nothing on a submission a parent needs and several
 * things they must not have.
 */
export async function pendingHumanReviewFor(link: ConsentedLink): Promise<number> {
  return prisma.submission.count({
    where: {
      studentId: link.studentUserId,
      status: { in: ["AWAITING_REVIEW", "UNDER_REVIEW"] },
    },
  });
}

// ---------------------------------------------------------------------------
// Snapshot: the shape src/lib/insights.ts consumes
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/**
 * IST, as a fixed offset. The app is India-only and no timezone is stored
 * anywhere in the schema, so "did they start this at half past eleven at night"
 * is answered against +05:30 rather than against the server's clock — which in
 * a container is UTC, and would report every 9 pm sitting as late night.
 */
const IST_OFFSET_MIN = 330;

function istHour(date: Date): number {
  return new Date(date.getTime() + IST_OFFSET_MIN * 60_000).getUTCHours();
}

/** Midnight UTC on the Monday of the week containing `ms`. */
function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Everything the dashboard needs, in one shape, containing nothing forbidden by
 * construction: it is built only out of the guarded selects above.
 */
export async function householdSnapshot(
  link: ConsentedLink,
  now: number = Date.now(),
): Promise<{ student: ParentStudent | null; snapshot: HouseholdSnapshot }> {
  const [student, attempts, grades, pendingHumanReview] = await Promise.all([
    childOf(link),
    attemptsFor(link),
    gradesFor(link),
    pendingHumanReviewFor(link),
  ]);

  const firstName = (student?.displayName ?? "your child").trim().split(/\s+/)[0];

  // --- effort, by week ---------------------------------------------------
  const weekMap = new Map<number, WeekEffort>();
  for (const a of attempts) {
    const ws = weekStart(a.startedAt.getTime());
    const w = weekMap.get(ws) ?? { weekStartMs: ws, sessions: 0, minutes: 0, papers: 0 };
    w.sessions += 1;
    w.minutes += a.durationMs / 60_000;
    if (a.status === "SUBMITTED") w.papers += 1;
    weekMap.set(ws, w);
  }
  const weeks = [...weekMap.values()]
    .map((w) => ({ ...w, minutes: Math.round(w.minutes) }))
    .sort((a, b) => a.weekStartMs - b.weekStartMs);

  // --- subject trend -----------------------------------------------------
  const bySubject = new Map<string, number[]>();
  // Oldest first, so "recent" is genuinely the tail.
  for (const a of [...attempts].reverse()) {
    const score = toNumber(a.totalScore);
    if (score === null || !a.maxMarks) continue;
    const list = bySubject.get(a.subject) ?? [];
    list.push(score / a.maxMarks);
    bySubject.set(a.subject, list);
  }
  const subjects: SubjectTrend[] = [...bySubject.entries()]
    .map(([subject, fractions]) => {
      const recent = fractions.slice(-2);
      const earlier = fractions.slice(-4, -2);
      return { subject, recent: mean(recent), earlier: mean(earlier), papers: fractions.length };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));

  // --- chapter-level difficulty -----------------------------------------
  interface ChapterAcc {
    awarded: number;
    possible: number;
    answers: number;
    days: Set<string>;
    lastSeenMs: number;
    subject: string;
  }
  const byChapter = new Map<string, ChapterAcc>();
  for (const g of grades) {
    if (!g.rubric) continue;
    const k = `${g.rubric.bookCode}:${g.rubric.chapter}`;
    const acc = byChapter.get(k) ?? {
      awarded: 0,
      possible: 0,
      answers: 0,
      days: new Set<string>(),
      lastSeenMs: 0,
      subject: g.rubric.subject,
    };
    acc.awarded += toNumber(g.awardedMarks) ?? 0;
    acc.possible += toNumber(g.maxMarks) ?? 0;
    acc.answers += 1;
    acc.days.add(g.createdAt.toISOString().slice(0, 10));
    acc.lastSeenMs = Math.max(acc.lastSeenMs, g.createdAt.getTime());
    byChapter.set(k, acc);
  }
  const chapters: ChapterSignal[] = [...byChapter.entries()]
    .map(([k, acc]) => {
      const [bookCode, chapterStr] = k.split(":");
      const chapter = Number(chapterStr);
      const title = getChapter(bookCode, chapter)?.title;
      return {
        bookCode,
        chapter,
        subject: acc.subject,
        // NCERT publishes no chapter titles for the Hindi books, and 44 of 149
        // cannot be recovered from the PDFs. A plain "Chapter 7" is better than
        // a wrong title on a screen a parent is about to act on.
        label: title && !/^Chapter \d+$/i.test(title) ? title : `Chapter ${chapter}`,
        // "Revisits" is distinct *days* on which work on this chapter was
        // marked — a proxy for sittings, and the only one available without
        // traversing into `Answer`, which is forbidden. Named honestly here so
        // nobody reads it as an exact session count.
        revisits: acc.days.size,
        fraction: acc.possible > 0 ? acc.awarded / acc.possible : null,
        answersGraded: acc.answers,
        lastSeenMs: acc.lastSeenMs,
      };
    })
    .sort((a, b) => a.bookCode.localeCompare(b.bookCode) || a.chapter - b.chapter);

  const monthAgo = now - 30 * DAY_MS;
  const lateNightSessions = attempts.filter(
    (a) => a.startedAt.getTime() >= monthAgo && (istHour(a.startedAt) >= 22 || istHour(a.startedAt) < 4),
  ).length;

  const lastActiveMs = attempts.length
    ? Math.max(...attempts.map((a) => a.startedAt.getTime()))
    : null;

  return {
    student,
    snapshot: {
      studentName: firstName,
      classNum: student?.studentProfile?.classNum ?? 10,
      now,
      // Only the weeks that matter to a household this term.
      weeks: weeks.filter((w) => w.weekStartMs >= now - 12 * WEEK_MS),
      subjects,
      chapters,
      pendingHumanReview,
      lastActiveMs,
      lateNightSessions,
    },
  };
}

// ---------------------------------------------------------------------------
// The export queries
// ---------------------------------------------------------------------------

/**
 * These live here rather than in `src/lib/export.ts` because that file is the
 * policy and is deliberately free of runtime imports, so it can be checked by a
 * plain-Node test with no database. This is the half that needs Prisma.
 *
 * Both are scoped by `scopeId` — the admin's own, from their session. Today
 * every B2C row is on the nil UUID and the filter looks redundant; the day it
 * is not, the query that forgot is the one that shows one school another
 * school's marks.
 */
export async function exportAttempts(scopeId: string, limit = 5000): Promise<AttemptExportRow[]> {
  const rows = await prisma.attempt.findMany({
    where: { student: { scopeId } },
    orderBy: [{ startedAt: "desc" }],
    take: limit,
    select: EXPORT_ATTEMPT_SELECT,
  });

  return rows.map((r) => ({
    studentId: r.studentId,
    studentName: r.student.displayName ?? "",
    classNum: r.classNum,
    subject: r.subject,
    paperSlug: r.paperSlug,
    startedAt: r.startedAt,
    submittedAt: r.submittedAt,
    durationMs: r.durationMs,
    status: r.status,
    maxMarks: r.maxMarks,
    totalScore: r.totalScore,
    questionsTotal: r.questions.length,
    questionsAttempted: r.questions.filter((q) => q.attempted).length,
  }));
}

export async function exportChapters(scopeId: string, limit = 20000): Promise<ChapterExportRow[]> {
  const where = {
    supersededBy: null,
    answer: { submission: { student: { scopeId } } },
  } satisfies Prisma.GradingResultWhereInput;
  assertFilterSafe(where, "exportChapters");

  const grades = await prisma.gradingResult.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: EXPORT_CHAPTER_SELECT,
  });

  interface Acc extends ChapterExportRow {
    lastGradedAt: Date | null;
  }
  const byKey = new Map<string, Acc>();
  for (const g of grades) {
    if (!g.rubric) continue;
    const studentId = g.answer?.submission.studentId;
    if (!studentId) continue;
    const k = `${studentId}:${g.rubric.bookCode}:${g.rubric.chapter}`;
    const chapterTitle = getChapter(g.rubric.bookCode, g.rubric.chapter)?.title ?? "";
    const acc =
      byKey.get(k) ??
      ({
        studentId,
        studentName: g.answer?.submission.student.displayName ?? "",
        classNum: g.rubric.classNum,
        subject: g.rubric.subject,
        bookCode: g.rubric.bookCode,
        chapter: g.rubric.chapter,
        chapterTitle: /^Chapter \d+$/i.test(chapterTitle) ? "" : chapterTitle,
        answersGraded: 0,
        marksAwarded: 0,
        marksPossible: 0,
        lastGradedAt: null,
      } satisfies Acc);
    acc.answersGraded += 1;
    acc.marksAwarded += toNumber(g.awardedMarks) ?? 0;
    acc.marksPossible += toNumber(g.maxMarks) ?? 0;
    if (!acc.lastGradedAt || g.createdAt > acc.lastGradedAt) acc.lastGradedAt = g.createdAt;
    byKey.set(k, acc);
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.studentName.localeCompare(b.studentName) ||
      a.bookCode.localeCompare(b.bookCode) ||
      a.chapter - b.chapter,
  );
}
