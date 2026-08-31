/**
 * The doubt registry — a student asks, peers and a teacher answer, optionally
 * with a voice note instead of typing a formula out longhand.
 *
 * ## Where this lives, given that the schema is frozen
 *
 * `prisma/schema.prisma` is final and has no `doubts` table, no `posts` table
 * and no generic content table. Rather than edit a frozen schema, this domain
 * is stored in the models that exist. The mapping is the load-bearing part of
 * this file, so it is written out in full:
 *
 * | this domain            | stored as                                              |
 * | ---------------------- | ------------------------------------------------------ |
 * | a doubt                | `Submission` + one `Answer`                            |
 * | a reply                | `Submission` + one `Answer`                            |
 * | a report               | `Submission` + one `Answer`  (see src/lib/moderation.ts)|
 * | a moderator action     | `Submission` + one `Answer`  (see src/lib/moderation.ts)|
 * | the author of any of them | `Submission.studentId` — NOT NULL, FK to `users`    |
 * | the text               | `Answer.transcript`, on the row's single `Answer`      |
 * | a voice note           | `VoiceNote`, hung off that `Answer`                    |
 * | which kind, and what it points at | `Submission.paperSlug`                      |
 * | posted in Shadow Mode  | `Submission.pageCount`: 0 named, 1 shadow              |
 * | visible / hidden / removed | `Submission.status`: GRADED / UNDER_REVIEW / FAILED |
 * | why it was removed     | `Submission.failureReason`                             |
 * | resolved / dealt with  | `Submission.gradedAt`                                  |
 * | the retry guard        | `Submission.idempotencyKey`, unique per author         |
 *
 * Three things make this a real fit rather than a squeeze:
 *
 * 1. **`Submission.studentId` is NOT NULL and a foreign key.** The safety rule
 *    this whole feature rests on — the author is always recorded, even in
 *    Shadow Mode — is therefore enforced by the database, not by our care. It
 *    is not possible to write an unattributable doubt through this module, or
 *    through any other, because the column will not accept one.
 * 2. **`@@unique([studentId, idempotencyKey])`** is exactly the retry guard a
 *    doubt posted on a dropping 2G connection needs.
 * 3. **`VoiceNote` already carries `storageKey`, `durationMs` and a
 *    `voice_note_max_90s` CHECK constraint.** The duration cap the brief asks
 *    for is already in Postgres; we do not get to forget it.
 *
 * ### What it costs, stated plainly
 *
 * These rows sit in `submissions`, which another lane reads. A doubt is not an
 * answer sheet, and a query that does not know that will find one. Two things
 * limit the damage, and neither is a substitute for the column this domain
 * really wants:
 *
 * - Every row here has `paperSlug` starting `doubt/v1`. `NOT_A_DOUBT` below is
 *   the `where` fragment that excludes the whole domain in one clause, and any
 *   grading query should carry it.
 * - The resting state is `GRADED`, which is **terminal** in
 *   `SubmissionStatus`. A pipeline sweeper looks for `QUEUED`, `OCR_RUNNING`,
 *   `AI_GRADING` or `AWAITING_REVIEW`; none of those is ever a doubt. A doubt
 *   also has zero `SubmissionPage` rows and no `EvaluationTicket`, so nothing
 *   in the grading path has anything to work on even if it does pick one up.
 *
 * The honest fix is a schema change — see the note at the bottom of this file
 * for the exact models this domain would rather have.
 */
import type { Prisma, Submission, User } from "@prisma/client";
import { ApiError, createOnce } from "@/lib/api";
import prisma from "@/lib/db";
import storage, { storageKeys, extensionFor, STORAGE_POLICY } from "@/lib/storage";
import { attributeThread, attributionKey, type Attribution } from "@/lib/shadow";

// ---------------------------------------------------------------------------
// The discriminator
// ---------------------------------------------------------------------------

export const DOUBT_PREFIX = "doubt/v1";

/**
 * Excludes this entire domain from a `submissions` query. Any grading, OCR or
 * routing query that does not want a doubt in its results should spread this.
 *
 * ```ts
 * prisma.submission.findMany({ where: { ...NOT_A_DOUBT, status: "QUEUED" } });
 * ```
 */
export const NOT_A_DOUBT = {
  paperSlug: { not: { startsWith: DOUBT_PREFIX } },
} as const satisfies Prisma.SubmissionWhereInput;

export type PostKind = "doubt" | "reply" | "report" | "action";

/** Verbs a moderator can perform. Encoded in the slug so the audit is parseable. */
export type ModerationVerb = "hide" | "remove" | "restore" | "reveal" | "dismiss";

export interface ParsedSlug {
  kind: PostKind;
  /** The post this one is about. Absent on a root doubt. */
  targetId?: string;
  verb?: ModerationVerb;
}

/** `doubt/v1` · `doubt/v1/reply/<id>` · `doubt/v1/report/<id>` · `doubt/v1/action/<verb>/<id>` */
export function buildSlug(p: ParsedSlug): string {
  if (p.kind === "doubt") return DOUBT_PREFIX;
  if (p.kind === "action") return `${DOUBT_PREFIX}/action/${p.verb}/${p.targetId}`;
  return `${DOUBT_PREFIX}/${p.kind}/${p.targetId}`;
}

export function parseSlug(slug: string | null): ParsedSlug | null {
  if (!slug || !slug.startsWith(DOUBT_PREFIX)) return null;
  const rest = slug.slice(DOUBT_PREFIX.length);
  if (rest === "") return { kind: "doubt" };
  const parts = rest.split("/").filter(Boolean);
  if (parts[0] === "reply" && parts[1]) return { kind: "reply", targetId: parts[1] };
  if (parts[0] === "report" && parts[1]) return { kind: "report", targetId: parts[1] };
  if (parts[0] === "action" && parts[1] && parts[2]) {
    return { kind: "action", verb: parts[1] as ModerationVerb, targetId: parts[2] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export type Visibility = "VISIBLE" | "HIDDEN" | "REMOVED";

/**
 * Nothing outside this module and src/lib/moderation.ts should ever see a
 * `SubmissionStatus` for a doubt. The mapping is an implementation detail of
 * the storage decision above, and reading `status === "GRADED"` as "this doubt
 * is live" at a call site is how that detail becomes permanent.
 */
const STATUS_FOR: Record<Visibility, Submission["status"]> = {
  VISIBLE: "GRADED",
  HIDDEN: "UNDER_REVIEW",
  REMOVED: "FAILED",
};

export function visibilityOf(row: Pick<Submission, "status">): Visibility {
  if (row.status === "UNDER_REVIEW") return "HIDDEN";
  if (row.status === "FAILED") return "REMOVED";
  return "VISIBLE";
}

export function statusFor(v: Visibility): Submission["status"] {
  return STATUS_FOR[v];
}

/** 0 = posted under the student's own name. 1 = posted in Shadow Mode. */
export const NAMED = 0;
export const SHADOW = 1;

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * The clock starts when a thing is written, not when it is last read.
 *
 * DPDP 2023 is a storage-limitation regime: a child's data is kept for as long
 * as the purpose needs it and then erased. These windows are that judgement,
 * made explicitly rather than by never deleting anything.
 *
 * - **Voice notes: 90 days.** A recording of a child's voice identifies them
 *   however carefully the screen says "Quiet Heron" — it is the one artefact
 *   here that survives pseudonymity intact. Its purpose (a peer or a teacher
 *   hears the question; a moderator can check a report) is served within days.
 *   90 leaves a term's worth of re-listening and then it goes.
 * - **Doubt and reply text: 180 days.** One academic term plus a margin. A
 *   student going back to last term's doubt is a real thing students do; going
 *   back to last year's is not, and a two-year-old question about periods and
 *   groups is a liability with no reader.
 * - **Moderation records: 365 days.** Deliberately the longest. A repeat-abuse
 *   pattern does not show inside one term, and this is the record that exists
 *   to protect the other children in the thread. It is the one place where the
 *   safety interest outweighs minimisation, which is why it is called out here
 *   rather than buried.
 *
 * Nothing schedules `purgeExpired()` yet — there is no job runner in this repo.
 * The deletion path exists and is tested, so scheduling it is a cron line
 * rather than a project.
 */
export const RETENTION_DAYS = {
  voiceNote: 90,
  post: 180,
  moderation: 365,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionWindowMs(kind: keyof typeof RETENTION_DAYS): number {
  return RETENTION_DAYS[kind] * DAY_MS;
}

/** When a thing written at `createdAt` becomes eligible for deletion. */
export function expiresAt(createdAt: Date, kind: keyof typeof RETENTION_DAYS): Date {
  return new Date(createdAt.getTime() + retentionWindowMs(kind));
}

export function isExpired(
  createdAt: Date,
  kind: keyof typeof RETENTION_DAYS,
  now: Date = new Date(),
): boolean {
  return expiresAt(createdAt, kind).getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Reading and writing a post
// ---------------------------------------------------------------------------

const postInclude = {
  student: { select: { id: true, displayName: true, scopeId: true, role: true } },
  answers: {
    select: {
      id: true,
      transcript: true,
      voiceNotes: {
        select: { id: true, storageKey: true, mimeType: true, durationMs: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
    take: 1,
  },
} satisfies Prisma.SubmissionInclude;

type PostRow = Prisma.SubmissionGetPayload<{ include: typeof postInclude }>;

export interface VoiceNoteView {
  id: string;
  durationMs: number;
  mimeType: string;
  /** Short-lived. Never stored — see docs/PLATFORM.md §4. */
  url: string;
  expiresAt: string;
}

export interface PostView {
  id: string;
  kind: PostKind;
  threadId: string;
  subject: string;
  classNum: number;
  text: string;
  author: Attribution;
  visibility: Visibility;
  /** Set on a doubt whose asker (or a moderator) marked it answered. */
  resolvedAt: string | null;
  voiceNote: VoiceNoteView | null;
  createdAt: string;
  /** When the platform will delete this post's text. */
  expiresAt: string;
  replyCount?: number;
  reportCount?: number;
}

function textOf(row: PostRow): string {
  return row.answers[0]?.transcript ?? "";
}

function answerIdOf(row: PostRow): string | null {
  return row.answers[0]?.id ?? null;
}

/**
 * A post's text and its voice note are written as one `Answer` child, always.
 * A doubt with no `Answer` cannot happen — the two rows go in one transaction —
 * but a half-written row from a crashed migration would read as empty rather
 * than throw, which is the right direction for a list screen.
 */
async function writePost(opts: {
  author: User;
  kind: PostKind;
  targetId?: string;
  verb?: ModerationVerb;
  subject: string;
  classNum: number;
  text: string;
  shadow: boolean;
  visibility?: Visibility;
  idempotencyKey: string;
}): Promise<{ row: PostRow; created: boolean }> {
  const data: Prisma.SubmissionUncheckedCreateInput = {
    // The author. From the session, never from a body — docs/PLATFORM.md §1.
    // Written on every post including a shadow one; this is the column that
    // makes Shadow Mode display-level rather than identity-level.
    studentId: opts.author.id,
    paperSlug: buildSlug({ kind: opts.kind, targetId: opts.targetId, verb: opts.verb }),
    subject: opts.subject,
    classNum: opts.classNum,
    idempotencyKey: opts.idempotencyKey,
    status: statusFor(opts.visibility ?? "VISIBLE"),
    pageCount: opts.shadow ? SHADOW : NAMED,
    answers: {
      create: {
        questionNumber: 0,
        maxMarks: 0,
        type: "SA",
        transcript: opts.text,
      },
    },
  };

  return createOnce({
    constraint: "idempotencyKey",
    create: () => prisma.submission.create({ data, include: postInclude }),
    // Scoped to the author, the way the unique index is. A global lookup would
    // hand one student another student's post the first time two clients
    // generated the same key — docs/PLATFORM.md §5.
    find: () =>
      prisma.submission.findUnique({
        where: {
          studentId_idempotencyKey: {
            studentId: opts.author.id,
            idempotencyKey: opts.idempotencyKey,
          },
        },
        include: postInclude,
      }),
  });
}

async function viewOf(
  row: PostRow,
  attribution: Attribution,
  opts: { withVoiceUrl: boolean },
): Promise<PostView> {
  const parsed = parseSlug(row.paperSlug) ?? { kind: "doubt" as PostKind };
  const note = row.answers[0]?.voiceNotes[0] ?? null;

  let voiceNote: VoiceNoteView | null = null;
  if (note && opts.withVoiceUrl) {
    voiceNote = {
      id: note.id,
      durationMs: note.durationMs,
      mimeType: note.mimeType,
      url: await storage.getSignedUrl(note.storageKey),
      expiresAt: expiresAt(note.createdAt, "voiceNote").toISOString(),
    };
  }

  return {
    id: row.id,
    kind: parsed.kind,
    threadId: parsed.kind === "doubt" ? row.id : (parsed.targetId ?? row.id),
    subject: row.subject,
    classNum: row.classNum,
    // A removed post keeps its row — the moderation record needs it — but its
    // text is not served to anyone again, including its author.
    text: visibilityOf(row) === "REMOVED" ? "" : textOf(row),
    author: attribution,
    visibility: visibilityOf(row),
    resolvedAt: row.gradedAt?.toISOString() ?? null,
    voiceNote: visibilityOf(row) === "REMOVED" ? null : voiceNote,
    createdAt: row.createdAt.toISOString(),
    expiresAt: expiresAt(row.createdAt, "post").toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Peer visibility
// ---------------------------------------------------------------------------

/**
 * Who can see whose doubts, in v1: **the same scope, the same class**.
 *
 * Scope because an admin — and a school — is scoped, and a doubt crossing
 * schools is a doubt no one at either school is responsible for moderating.
 * Class because a Class 9 student has no business in a Class 10 thread and the
 * age band is narrower that way. `Submission` has no `scopeId` of its own, so
 * the filter joins through the author's.
 */
function peerScope(viewer: User, classNum: number): Prisma.SubmissionWhereInput {
  return { student: { scopeId: viewer.scopeId }, classNum };
}

/** The class this user reads and writes doubts in. */
export async function classNumFor(user: User): Promise<number> {
  const profile = await prisma.studentProfile.findUnique({
    where: { userId: user.id },
    select: { classNum: true },
  });
  if (profile) return profile.classNum;
  throw new ApiError(
    "VALIDATION_FAILED",
    "Add your class to your profile before posting a doubt.",
  );
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export const MAX_DOUBT_CHARS = 2000;
export const MAX_REPLY_CHARS = 1000;

/**
 * The PRD asks for "micro-study environments (3–5 users max)". This is that
 * number, applied to the only form of it this lane builds: a doubt thread
 * admits at most five distinct people — the asker and four others.
 *
 * A small cap is not a technical limit, it is the feature. A question answered
 * in front of four classmates is a study group; the same question in front of
 * two hundred is a broadcast, and a broadcast is what the student was avoiding
 * when they turned Shadow Mode on.
 */
export const MAX_THREAD_PARTICIPANTS = 5;

export async function postDoubt(opts: {
  author: User;
  subject: string;
  text: string;
  shadow: boolean;
  idempotencyKey: string;
}): Promise<PostView> {
  const classNum = await classNumFor(opts.author);
  const { row } = await writePost({
    author: opts.author,
    kind: "doubt",
    subject: opts.subject,
    classNum,
    text: opts.text,
    shadow: opts.shadow,
    idempotencyKey: opts.idempotencyKey,
  });
  return withAttribution(row, opts.author, row.id);
}

export async function postReply(opts: {
  author: User;
  doubtId: string;
  text: string;
  shadow: boolean;
  idempotencyKey: string;
}): Promise<PostView> {
  const root = await requireReadablePost(opts.author, opts.doubtId, "doubt");
  if (visibilityOf(root) !== "VISIBLE") {
    throw new ApiError("CONFLICT", "This thread is closed to new replies.");
  }

  const participants = await threadParticipants(opts.doubtId, root.studentId);
  if (!participants.has(opts.author.id) && participants.size >= MAX_THREAD_PARTICIPANTS) {
    throw new ApiError(
      "CONFLICT",
      `This thread already has ${MAX_THREAD_PARTICIPANTS} people in it. Ask your own question and someone will pick it up.`,
    );
  }

  const { row } = await writePost({
    author: opts.author,
    kind: "reply",
    targetId: opts.doubtId,
    subject: root.subject,
    classNum: root.classNum,
    text: opts.text,
    shadow: opts.shadow,
    idempotencyKey: opts.idempotencyKey,
  });
  return withAttribution(row, opts.author, opts.doubtId);
}

async function threadParticipants(doubtId: string, asker: string): Promise<Set<string>> {
  const replies = await prisma.submission.findMany({
    where: { paperSlug: buildSlug({ kind: "reply", targetId: doubtId }) },
    select: { studentId: true },
  });
  return new Set([asker, ...replies.map((r) => r.studentId)]);
}

async function withAttribution(row: PostRow, viewer: User, threadId: string): Promise<PostView> {
  const map = await attributeThread({
    threadId,
    viewerId: viewer.id,
    authors: [
      {
        userId: row.studentId,
        displayName: row.student.displayName,
        shadow: row.pageCount === SHADOW,
      },
    ],
  });
  const attribution =
    map.get(attributionKey(row.studentId, row.pageCount === SHADOW)) ??
    { label: "A student", shadow: row.pageCount === SHADOW, isYou: false };
  return viewOf(row, attribution, { withVoiceUrl: true });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Load a post the viewer is entitled to read, or throw.
 *
 * The 403/404 here is deliberately indiscriminate: a viewer outside the scope
 * gets the same answer for a doubt that exists and one that does not. A 403
 * that distinguishes them is a membership oracle — it tells a stranger which
 * ids are real. docs/PLATFORM.md §3.
 */
export async function requireReadablePost(
  viewer: User,
  postId: string,
  expect?: PostKind,
): Promise<PostRow> {
  const row = await prisma.submission.findUnique({ where: { id: postId }, include: postInclude });
  if (!row) throw ApiError.notFound("Doubt");

  const parsed = parseSlug(row.paperSlug);
  if (!parsed) throw ApiError.notFound("Doubt");
  if (expect && parsed.kind !== expect) throw ApiError.notFound("Doubt");

  // A moderator reads inside their own scope, and nowhere else. An admin is an
  // admin *of a scope*, not of the platform — docs/PLATFORM.md §1.
  if (viewer.role === "ADMIN") {
    if (row.student.scopeId !== viewer.scopeId) throw ApiError.notFound("Doubt");
    return row;
  }

  if (row.studentId === viewer.id) return row;
  if (row.student.scopeId !== viewer.scopeId) throw ApiError.notFound("Doubt");

  // Peer visibility is a student-to-student thing in v1. An evaluator has no
  // class and no place in a doubt thread yet — see the note on
  // MAX_THREAD_PARTICIPANTS for why this surface stays small on purpose.
  if (viewer.role !== "STUDENT") throw ApiError.notFound("Doubt");

  const classNum = await classNumFor(viewer);
  if (row.classNum !== classNum) throw ApiError.notFound("Doubt");
  // A hidden or removed post is invisible to peers. Its author still sees the
  // row above, so they are not left wondering where their question went.
  if (visibilityOf(row) !== "VISIBLE") throw ApiError.notFound("Doubt");
  return row;
}

export interface DoubtListItem extends PostView {
  replyCount: number;
}

export async function listDoubts(opts: {
  viewer: User;
  subject?: string;
  /** Only this student's own doubts — the "my questions" filter. */
  mine?: boolean;
  unresolvedOnly?: boolean;
  limit?: number;
}): Promise<DoubtListItem[]> {
  const classNum = await classNumFor(opts.viewer);
  const limit = Math.min(opts.limit ?? 30, 100);

  const rows = await prisma.submission.findMany({
    where: {
      paperSlug: DOUBT_PREFIX,
      ...peerScope(opts.viewer, classNum),
      ...(opts.subject ? { subject: opts.subject } : {}),
      ...(opts.mine ? { studentId: opts.viewer.id } : {}),
      ...(opts.unresolvedOnly ? { gradedAt: null } : {}),
      // Hidden and removed doubts drop out of every peer list. The author sees
      // their own again through `readThread`.
      status: statusFor("VISIBLE"),
    },
    include: postInclude,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const counts = await prisma.submission.groupBy({
    by: ["paperSlug"],
    where: {
      paperSlug: { in: rows.map((r) => buildSlug({ kind: "reply", targetId: r.id })) },
      status: statusFor("VISIBLE"),
    },
    _count: { _all: true },
  });
  const replyCounts = new Map(counts.map((c) => [c.paperSlug, c._count._all]));

  // Each doubt is its own thread, so each row is attributed under its own id —
  // which is exactly the property that stops one student's pseudonym in this
  // list from being the same as their pseudonym in the next one.
  return Promise.all(
    rows.map(async (row) => {
      const view = await withAttribution(row, opts.viewer, row.id);
      return {
        ...view,
        replyCount: replyCounts.get(buildSlug({ kind: "reply", targetId: row.id })) ?? 0,
      };
    }),
  );
}

export interface ThreadView {
  doubt: PostView;
  replies: PostView[];
  participantCount: number;
  /** False once the thread is full or closed; the composer says why. */
  canReply: boolean;
}

export async function readThread(opts: { viewer: User; doubtId: string }): Promise<ThreadView> {
  const root = await requireReadablePost(opts.viewer, opts.doubtId, "doubt");
  const replyRows = await prisma.submission.findMany({
    where: {
      paperSlug: buildSlug({ kind: "reply", targetId: opts.doubtId }),
      ...(opts.viewer.role === "ADMIN"
        ? {}
        : { OR: [{ status: statusFor("VISIBLE") }, { studentId: opts.viewer.id }] }),
    },
    include: postInclude,
    orderBy: { createdAt: "asc" },
  });

  const all = [root, ...replyRows];
  // One attribution pass over the whole thread, so that a collision between two
  // pseudonyms is seen and broken. Doing it per-post would give two people the
  // same name with nothing to notice it.
  const attributions = await attributeThread({
    threadId: opts.doubtId,
    viewerId: opts.viewer.id,
    authors: all.map((r) => ({
      userId: r.studentId,
      displayName: r.student.displayName,
      shadow: r.pageCount === SHADOW,
    })),
  });

  const fallback = (r: PostRow): Attribution => ({
    label: "A student",
    shadow: r.pageCount === SHADOW,
    isYou: r.studentId === opts.viewer.id,
  });

  const doubt = await viewOf(
    root,
    attributions.get(attributionKey(root.studentId, root.pageCount === SHADOW)) ?? fallback(root),
    { withVoiceUrl: true },
  );
  const replies = await Promise.all(
    replyRows.map((r) =>
      viewOf(r, attributions.get(attributionKey(r.studentId, r.pageCount === SHADOW)) ?? fallback(r), {
        withVoiceUrl: true,
      }),
    ),
  );

  const participants = new Set(all.map((r) => r.studentId));
  return {
    doubt,
    replies,
    participantCount: participants.size,
    canReply:
      visibilityOf(root) === "VISIBLE" &&
      (participants.has(opts.viewer.id) || participants.size < MAX_THREAD_PARTICIPANTS),
  };
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

/**
 * Mark a doubt answered. The asker's call, or a moderator's.
 *
 * Idempotent by construction: resolving twice sets the same field to the value
 * it already has and returns the same row, so a retried POST is a no-op without
 * needing a key.
 */
export async function resolveDoubt(opts: {
  actor: User;
  doubtId: string;
  resolved: boolean;
}): Promise<PostView> {
  const row = await requireReadablePost(opts.actor, opts.doubtId, "doubt");
  if (row.studentId !== opts.actor.id && opts.actor.role !== "ADMIN") {
    throw ApiError.forbidden("Only the person who asked can close their doubt.");
  }
  if (Boolean(row.gradedAt) !== opts.resolved) {
    await prisma.submission.update({
      where: { id: opts.doubtId },
      data: { gradedAt: opts.resolved ? new Date() : null },
    });
  }
  const fresh = await prisma.submission.findUniqueOrThrow({
    where: { id: opts.doubtId },
    include: postInclude,
  });
  return withAttribution(fresh, opts.actor, opts.doubtId);
}

// ---------------------------------------------------------------------------
// Voice notes
// ---------------------------------------------------------------------------

/**
 * 90 seconds, and the database agrees: `voice_note_max_90s` is a CHECK
 * constraint on `voice_notes.durationMs`. This constant only exists so the
 * recorder can show a countdown against the same number.
 */
export const MAX_VOICE_MS = 90_000;

/**
 * Attach a recording to a post the caller wrote.
 *
 * `durationMs` is client-reported and cannot be otherwise: measuring it
 * server-side needs an audio decoder this repo does not have. It is bounded
 * anyway — by the validator, by the CHECK constraint, and, for the thing that
 * actually costs money, by the 8 MB audio ceiling in `STORAGE_POLICY`, which is
 * measured from the buffer rather than believed.
 *
 * One note per post. A second call replaces the first, object and row, rather
 * than accumulating — a student who re-records because the first take was
 * mumbled should not leave the mumbled one on the server.
 */
export async function attachVoiceNote(opts: {
  author: User;
  postId: string;
  bytes: Buffer;
  contentType: string;
  durationMs: number;
}): Promise<VoiceNoteView> {
  const row = await requireReadablePost(opts.author, opts.postId);
  if (row.studentId !== opts.author.id) {
    throw ApiError.forbidden("You can only add a recording to your own post.");
  }
  if (opts.durationMs <= 0 || opts.durationMs > MAX_VOICE_MS) {
    throw ApiError.validation([
      { path: "durationMs", message: `must be between 1 and ${MAX_VOICE_MS} milliseconds` },
    ]);
  }

  // MediaRecorder emits `audio/webm;codecs=opus`. The allowlist holds bare
  // types, so the parameters come off before it is checked — and the bare type
  // is what is stored, so nothing downstream has to re-parse it.
  const contentType = opts.contentType.split(";")[0].trim().toLowerCase();
  const allowed = STORAGE_POLICY.audio.contentTypes as readonly string[];
  if (!allowed.includes(contentType)) {
    throw new ApiError(
      "UNSUPPORTED_MEDIA_TYPE",
      `${contentType || "that file"} is not a recording we can store. Allowed: ${allowed.join(", ")}.`,
    );
  }

  const answerId = answerIdOf(row);
  if (!answerId) throw ApiError.notFound("Doubt");

  const existing = row.answers[0]?.voiceNotes ?? [];
  const noteId = crypto.randomUUID();
  const object = await storage.put({
    key: storageKeys.voiceNote(answerId, noteId, extensionFor(contentType)),
    body: opts.bytes,
    contentType,
    storageClass: "audio",
  });

  const note = await prisma.$transaction(async (tx) => {
    for (const old of existing) {
      await tx.voiceNote.delete({ where: { id: old.id } });
    }
    return tx.voiceNote.create({
      data: {
        id: noteId,
        answerId,
        // "Who recorded this". The column is named for the grading path, where
        // it is always a teacher; here it is the student, and it is the same
        // fact either way — the recording's author, recorded server-side even
        // when the post above it is in Shadow Mode.
        evaluatorId: opts.author.id,
        storageKey: object.key,
        mimeType: object.contentType,
        durationMs: opts.durationMs,
        bytes: object.bytes,
      },
    });
  });

  // Objects, after the rows. A dangling object is a cleanup job; a dangling row
  // is a player that spins forever.
  for (const old of existing) {
    await storage.delete(old.storageKey).catch(() => {});
  }

  return {
    id: note.id,
    durationMs: note.durationMs,
    mimeType: note.mimeType,
    url: await storage.getSignedUrl(note.storageKey),
    expiresAt: expiresAt(note.createdAt, "voiceNote").toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * The author's own erasure path.
 *
 * A student who regrets a question gets it gone, not hidden. The row is deleted
 * outright — `Answer` and `VoiceNote` cascade from it — and the object is
 * removed from storage. A doubt with replies keeps the replies orphaned rather
 * than deleting four other children's writing, and they stop being reachable
 * because the thread root is gone; `purgeExpired` sweeps them on their own
 * clock.
 *
 * A moderator does **not** use this. A post under moderation is removed, not
 * deleted, so the record survives the person who wrote it — see
 * src/lib/moderation.ts.
 */
export async function deleteOwnPost(opts: { actor: User; postId: string }): Promise<void> {
  const row = await prisma.submission.findUnique({ where: { id: opts.postId }, include: postInclude });
  if (!row || !parseSlug(row.paperSlug)) throw ApiError.notFound("Doubt");
  if (row.studentId !== opts.actor.id) throw ApiError.forbidden("That is not yours to delete.");

  const keys = (row.answers[0]?.voiceNotes ?? []).map((n) => n.storageKey);
  await prisma.submission.delete({ where: { id: opts.postId } });
  for (const key of keys) await storage.delete(key).catch(() => {});
}

export interface PurgeReport {
  voiceNotes: number;
  posts: number;
  moderationRecords: number;
}

/**
 * Delete everything past its retention window. Safe to re-run; nothing
 * schedules it yet.
 *
 * Order matters: voice notes first, because a post's deletion cascades its
 * notes away and would leave their objects behind with no key to find them by.
 */
export async function purgeExpired(now: Date = new Date()): Promise<PurgeReport> {
  const report: PurgeReport = { voiceNotes: 0, posts: 0, moderationRecords: 0 };

  const staleNotes = await prisma.voiceNote.findMany({
    where: {
      createdAt: { lte: new Date(now.getTime() - retentionWindowMs("voiceNote")) },
      answer: { submission: { paperSlug: { startsWith: DOUBT_PREFIX } } },
    },
    select: { id: true, storageKey: true },
  });
  for (const note of staleNotes) {
    await storage.delete(note.storageKey).catch(() => {});
    await prisma.voiceNote.delete({ where: { id: note.id } });
    report.voiceNotes += 1;
  }

  const stalePosts = await prisma.submission.findMany({
    where: {
      createdAt: { lte: new Date(now.getTime() - retentionWindowMs("post")) },
      OR: [
        { paperSlug: DOUBT_PREFIX },
        { paperSlug: { startsWith: `${DOUBT_PREFIX}/reply/` } },
      ],
    },
    select: { id: true, answers: { select: { voiceNotes: { select: { storageKey: true } } } } },
  });
  for (const post of stalePosts) {
    for (const a of post.answers) {
      for (const n of a.voiceNotes) await storage.delete(n.storageKey).catch(() => {});
    }
    await prisma.submission.delete({ where: { id: post.id } });
    report.posts += 1;
  }

  const staleModeration = await prisma.submission.findMany({
    where: {
      createdAt: { lte: new Date(now.getTime() - retentionWindowMs("moderation")) },
      OR: [
        { paperSlug: { startsWith: `${DOUBT_PREFIX}/report/` } },
        { paperSlug: { startsWith: `${DOUBT_PREFIX}/action/` } },
      ],
    },
    select: { id: true },
  });
  for (const rec of staleModeration) {
    await prisma.submission.delete({ where: { id: rec.id } });
    report.moderationRecords += 1;
  }

  return report;
}

/**
 * ## What this domain would rather have, when the schema unfreezes
 *
 * Three tables, and the overloading above disappears:
 *
 * ```prisma
 * model Doubt {
 *   id         String   @id @default(uuid()) @db.Uuid
 *   authorId   String   @db.Uuid          // NOT NULL. Always. Even in shadow.
 *   parentId   String?  @db.Uuid          // a reply points at its root
 *   scopeId    String   @db.Uuid
 *   subject    String   @db.VarChar(60)
 *   classNum   Int
 *   body       String
 *   shadow     Boolean  @default(false)   // display-level only
 *   visibility DoubtVisibility @default(VISIBLE)
 *   resolvedAt DateTime?
 *   expiresAt  DateTime                   // the retention clock, on the row
 *   idempotencyKey String @db.VarChar(64)
 *   @@unique([authorId, idempotencyKey])
 * }
 *
 * model DoubtReport { id … doubtId, reporterId, reason, handledAt  @@unique([doubtId, reporterId]) }
 * model ModerationAction { id … doubtId, moderatorId, verb, note, createdAt }
 * ```
 *
 * Plus `VoiceNote.doubtId` as a second nullable parent beside `answerId`, and
 * one CHECK that exactly one of them is set. Nothing else here changes: the
 * pseudonym derivation, the moderation surface and the retention arithmetic are
 * all independent of where the rows live.
 */
