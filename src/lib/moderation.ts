/**
 * The moderation surface for the doubt registry.
 *
 * ## Why this ships in the same lane as the feature
 *
 * Shadow Mode lets a 14-year-old post without their classmates seeing their
 * name. That is the whole point of it, and it is also the whole risk: the same
 * property that protects a student who is embarrassed protects a student who is
 * cruel. A reporting flow that arrives "later" never arrives, and until it does
 * the anonymity is doing only the second job.
 *
 * So this file exists at the same commit as src/lib/doubts.ts, and it does four
 * things:
 *
 * 1. **Report** — any peer who can see a post can flag it, once.
 * 2. **Queue** — everything reported, worst first, at `/moderation`, `ADMIN` only.
 * 3. **Act** — hide, remove, restore, dismiss.
 * 4. **Resolve the author** — turn a pseudonym back into a person, and record
 *    that it happened.
 *
 * The fourth is the one that makes the other three mean anything, and it is the
 * reason src/lib/shadow.ts insists that anonymity is display-level. A moderator
 * looking at "Quiet Heron said something that frightened me" can always find
 * out who Quiet Heron is. **A reveal is itself an audited action** — a written
 * record that a named adult asked for a named child's identity at a given
 * moment, for a stated reason. Identifying a minor should leave a trace, and
 * `revealAuthor` will not do it without writing one.
 *
 * ## Where the records live
 *
 * Same storage decision as src/lib/doubts.ts, which explains it: a report and a
 * moderator action are each a `Submission` authored by the person who did it,
 * discriminated by `paperSlug`.
 *
 * | this domain       | `paperSlug`                          | author is       |
 * | ----------------- | ------------------------------------ | --------------- |
 * | a report          | `doubt/v1/report/<postId>`           | the reporter    |
 * | a moderator action| `doubt/v1/action/<verb>/<postId>`    | the moderator   |
 *
 * The author column is the audit trail. It is NOT NULL and a foreign key, so
 * "who did this" is a fact the database holds rather than one we remember to
 * write.
 */
import type { Prisma, User } from "@prisma/client";
import { ApiError, createOnce } from "@/lib/api";
import prisma from "@/lib/db";
import {
  DOUBT_PREFIX,
  buildSlug,
  parseSlug,
  requireReadablePost,
  statusFor,
  visibilityOf,
  type ModerationVerb,
  type Visibility,
} from "@/lib/doubts";
import { attributeThread, attributionKey } from "@/lib/shadow";

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Why someone reported a post. Deliberately short and in plain words — this
 * list is read by a 14-year-old on a phone, under a post that has upset them.
 *
 * `SAFETY` is first and separate on purpose. A post that suggests a child is in
 * danger is not the same class of problem as a spammer, and the queue below
 * sorts it to the top rather than leaving it behind eleven off-topic flags.
 */
export const REPORT_REASONS = [
  "SAFETY",
  "BULLYING",
  "PERSONAL_INFO",
  "SPAM",
  "OFF_TOPIC",
  "OTHER",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  SAFETY: "Someone may be in danger",
  BULLYING: "Bullying or abuse",
  PERSONAL_INFO: "Shares someone's personal details",
  SPAM: "Spam or advertising",
  OFF_TOPIC: "Not about studying",
  OTHER: "Something else",
};

/**
 * Higher is sooner. `SAFETY` is two orders of magnitude clear of everything
 * else on purpose: one child saying another may be in danger must never be
 * outranked by any pile of spam flags, however large. A weight that merely
 * beats a handful of them is a weight that loses on a busy afternoon.
 */
const REASON_WEIGHT: Record<ReportReason, number> = {
  SAFETY: 10_000,
  BULLYING: 100,
  PERSONAL_INFO: 100,
  SPAM: 10,
  OFF_TOPIC: 1,
  OTHER: 1,
};

export const MAX_REPORT_CHARS = 500;
export const MAX_NOTE_CHARS = 500;

/**
 * The report body is `<REASON>` on the first line and the reporter's own words
 * after it. One field, because `Answer.transcript` is the one text column this
 * domain has, and a first-line tag is parseable without pretending the column
 * is JSON.
 */
function encodeReport(reason: ReportReason, detail: string): string {
  return detail.trim() ? `${reason}\n${detail.trim()}` : reason;
}

function decodeReport(text: string): { reason: ReportReason; detail: string } {
  const newline = text.indexOf("\n");
  const head = (newline === -1 ? text : text.slice(0, newline)).trim();
  const reason = (REPORT_REASONS as readonly string[]).includes(head)
    ? (head as ReportReason)
    : "OTHER";
  return { reason, detail: newline === -1 ? "" : text.slice(newline + 1).trim() };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface ReportResult {
  reportId: string;
  /** False when this person had already reported this post. */
  created: boolean;
}

/**
 * Flag a post. Anyone who can read it can report it, exactly once.
 *
 * The idempotency key is **derived, not accepted**: the logical action is
 * "this user reports this post", which is already unique, and
 * `@@unique([studentId, idempotencyKey])` turns a double-tap, a retry on a
 * dropped connection, and a determined second report into the same no-op. A
 * client-supplied key would let one upset student inflate a queue position by
 * reporting the same thing eleven times, which is both a denial-of-service on
 * the moderator's attention and a way to bury a real report.
 */
export async function reportPost(opts: {
  reporter: User;
  postId: string;
  reason: ReportReason;
  detail: string;
}): Promise<ReportResult> {
  const target = await requireReadablePost(opts.reporter, opts.postId);

  // Only a doubt or a reply. Reports and moderation actions are rows in the
  // same table and are readable by peers in the same scope and class, so
  // without this a student could file a report against a moderator's own audit
  // entry — noise the queue would silently drop, and a way to make the record
  // of a decision look contested.
  const parsed = parseSlug(target.paperSlug);
  if (!parsed || (parsed.kind !== "doubt" && parsed.kind !== "reply")) {
    throw ApiError.notFound("Doubt");
  }

  if (target.studentId === opts.reporter.id) {
    throw new ApiError(
      "CONFLICT",
      "This is your own post. You can delete it instead of reporting it.",
    );
  }

  const idempotencyKey = `doubt-report:${opts.postId}`;
  const { row, created } = await createOnce({
    constraint: "idempotencyKey",
    create: () =>
      prisma.submission.create({
        data: {
          // The reporter. From the session — docs/PLATFORM.md §1.
          studentId: opts.reporter.id,
          paperSlug: buildSlug({ kind: "report", targetId: opts.postId }),
          subject: target.subject,
          classNum: target.classNum,
          idempotencyKey,
          // A report is open until a moderator deals with it; `gradedAt` is
          // when that happened. Same field, same meaning, as everywhere else
          // in this domain: "this row is finished".
          status: statusFor("VISIBLE"),
          answers: {
            create: {
              questionNumber: 0,
              maxMarks: 0,
              type: "SA",
              transcript: encodeReport(opts.reason, opts.detail),
            },
          },
        },
      }),
    find: () =>
      prisma.submission.findUnique({
        where: {
          studentId_idempotencyKey: { studentId: opts.reporter.id, idempotencyKey },
        },
      }),
  });

  return { reportId: row.id, created };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface QueuedReport {
  id: string;
  reason: ReportReason;
  reasonLabel: string;
  detail: string;
  createdAt: string;
  handledAt: string | null;
}

export interface QueueItem {
  postId: string;
  kind: "doubt" | "reply";
  threadId: string;
  subject: string;
  classNum: number;
  text: string;
  /** The pseudonym or name a peer sees. Never the real identity — see below. */
  authorLabel: string;
  authorShadow: boolean;
  visibility: Visibility;
  createdAt: string;
  reports: QueuedReport[];
  openReports: number;
  /** Sort weight; `SAFETY` dominates. */
  urgency: number;
}

/**
 * Everything reported and not yet dealt with, in the moderator's own scope.
 *
 * **The queue shows pseudonyms.** A moderator opening `/moderation` does not
 * learn who wrote what by looking; they learn it by asking, through
 * `revealAuthor`, which writes a record. Identity is available to moderation
 * always and ambient never — a queue that prints real names has resolved every
 * child's identity to every moderator who ever glanced at it, and no audit
 * trail can be built out of glances.
 */
export async function moderationQueue(opts: {
  moderator: User;
  includeHandled?: boolean;
  limit?: number;
}): Promise<QueueItem[]> {
  const limit = Math.min(opts.limit ?? 50, 200);

  const reports = await prisma.submission.findMany({
    where: {
      paperSlug: { startsWith: `${DOUBT_PREFIX}/report/` },
      ...(opts.includeHandled ? {} : { gradedAt: null }),
      // An admin is an admin *of a scope*. The reported post's author must be
      // in it — checking the reporter's scope instead would let a cross-scope
      // report drag another school's post into this queue.
      student: { scopeId: opts.moderator.scopeId },
    },
    select: {
      id: true,
      paperSlug: true,
      createdAt: true,
      gradedAt: true,
      answers: { select: { transcript: true }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
    take: limit * 4,
  });

  const byTarget = new Map<string, typeof reports>();
  for (const r of reports) {
    const parsed = parseSlug(r.paperSlug);
    if (!parsed?.targetId) continue;
    const list = byTarget.get(parsed.targetId) ?? [];
    list.push(r);
    byTarget.set(parsed.targetId, list);
  }
  if (byTarget.size === 0) return [];

  const targets = await prisma.submission.findMany({
    where: {
      id: { in: [...byTarget.keys()] },
      student: { scopeId: opts.moderator.scopeId },
    },
    select: {
      id: true,
      paperSlug: true,
      subject: true,
      classNum: true,
      status: true,
      pageCount: true,
      createdAt: true,
      studentId: true,
      student: { select: { displayName: true } },
      answers: { select: { transcript: true }, take: 1 },
    },
  });

  const items: QueueItem[] = [];
  for (const t of targets) {
    const parsed = parseSlug(t.paperSlug);
    if (!parsed || (parsed.kind !== "doubt" && parsed.kind !== "reply")) continue;

    const threadId = parsed.kind === "doubt" ? t.id : (parsed.targetId ?? t.id);
    const shadow = t.pageCount === 1;
    // Attributed under the thread the post lives in, so the label a moderator
    // sees is the same one the students in that thread see. A different name
    // here would make a report impossible to match to a message.
    const attribution = await attributeThread({
      threadId,
      viewerId: opts.moderator.id,
      authors: [{ userId: t.studentId, displayName: t.student.displayName, shadow }],
    });
    const label =
      attribution.get(attributionKey(t.studentId, shadow))?.label ?? "A student";

    const raw = byTarget.get(t.id) ?? [];
    const decoded = raw.map((r) => {
      const { reason, detail } = decodeReport(r.answers[0]?.transcript ?? "");
      return {
        id: r.id,
        reason,
        reasonLabel: REPORT_REASON_LABELS[reason],
        detail,
        createdAt: r.createdAt.toISOString(),
        handledAt: r.gradedAt?.toISOString() ?? null,
      };
    });

    const open = decoded.filter((d) => !d.handledAt);
    items.push({
      postId: t.id,
      kind: parsed.kind,
      threadId,
      subject: t.subject,
      classNum: t.classNum,
      text: t.answers[0]?.transcript ?? "",
      authorLabel: label,
      authorShadow: shadow,
      visibility: visibilityOf(t),
      createdAt: t.createdAt.toISOString(),
      reports: decoded,
      openReports: open.length,
      urgency: decoded.reduce((sum, d) => sum + REASON_WEIGHT[d.reason], 0),
    });
  }

  // Worst first, then most-reported, then oldest — a safety flag from ten
  // minutes ago outranks nine spam flags from yesterday, and among equals the
  // one that has been waiting longest goes first.
  items.sort(
    (a, b) =>
      b.urgency - a.urgency ||
      b.openReports - a.openReports ||
      a.createdAt.localeCompare(b.createdAt),
  );
  return items.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

const VISIBILITY_FOR_VERB: Partial<Record<ModerationVerb, Visibility>> = {
  hide: "HIDDEN",
  remove: "REMOVED",
  restore: "VISIBLE",
};

export interface ModerationOutcome {
  postId: string;
  verb: ModerationVerb;
  visibility: Visibility;
  actionId: string;
  created: boolean;
}

/**
 * Hide, remove, restore, or dismiss the reports on a post.
 *
 * - **hide** takes it off the peer list while a decision is made. Reversible.
 * - **remove** is the decision. The row survives — the record of what was said
 *   is the thing a repeat pattern is built from — but its text is never served
 *   again, to anyone, including its author.
 * - **restore** puts it back and is the admission that the report was wrong.
 * - **dismiss** closes the reports and changes nothing about the post.
 *
 * Every one writes an action row before it touches the post, so a crash between
 * the two leaves a record of an intent rather than an unexplained change. The
 * action row and the status change are one transaction; the record is written
 * first inside it for the same reason.
 */
export async function moderatePost(opts: {
  moderator: User;
  postId: string;
  verb: ModerationVerb;
  note: string;
  idempotencyKey: string;
}): Promise<ModerationOutcome> {
  if (opts.verb === "reveal") {
    throw ApiError.validation([
      { path: "verb", message: "use the author endpoint to resolve an author" },
    ]);
  }
  const target = await requireReadablePost(opts.moderator, opts.postId);
  const parsed = parseSlug(target.paperSlug);
  if (!parsed || (parsed.kind !== "doubt" && parsed.kind !== "reply")) {
    throw ApiError.notFound("Doubt");
  }

  const nextVisibility = VISIBILITY_FOR_VERB[opts.verb] ?? visibilityOf(target);

  const { row: action, created } = await createOnce({
    constraint: "idempotencyKey",
    create: () =>
      prisma.$transaction(async (tx) => {
        const record = await tx.submission.create({
          data: {
            // The moderator. This column is the audit trail.
            studentId: opts.moderator.id,
            paperSlug: buildSlug({ kind: "action", verb: opts.verb, targetId: opts.postId }),
            subject: target.subject,
            classNum: target.classNum,
            idempotencyKey: opts.idempotencyKey,
            status: statusFor("VISIBLE"),
            gradedAt: new Date(),
            answers: {
              create: { questionNumber: 0, maxMarks: 0, type: "SA", transcript: opts.note },
            },
          },
        });

        if (opts.verb !== "dismiss") {
          await tx.submission.update({
            where: { id: opts.postId },
            data: {
              status: statusFor(nextVisibility),
              failureReason:
                nextVisibility === "REMOVED"
                  ? `Removed by a moderator${opts.note ? `: ${opts.note}` : "."}`
                  : null,
            },
          });
        }

        // Close every open report on this post. A moderator who has looked at
        // it has looked at all of them; leaving them open would put the same
        // post back at the top of the queue for the next moderator.
        await tx.submission.updateMany({
          where: {
            paperSlug: buildSlug({ kind: "report", targetId: opts.postId }),
            gradedAt: null,
          },
          data: { gradedAt: new Date() },
        });

        return record;
      }),
    find: () =>
      prisma.submission.findUnique({
        where: {
          studentId_idempotencyKey: {
            studentId: opts.moderator.id,
            idempotencyKey: opts.idempotencyKey,
          },
        },
      }),
  });

  return { postId: opts.postId, verb: opts.verb, visibility: nextVisibility, actionId: action.id, created };
}

// ---------------------------------------------------------------------------
// Resolving an author
// ---------------------------------------------------------------------------

export interface ResolvedAuthor {
  userId: string;
  displayName: string | null;
  role: User["role"];
  classNum: number | null;
  /** The pseudonym this person wears in the thread the post is in. */
  pseudonym: string | null;
  revealedAt: string;
  actionId: string;
}

/**
 * Turn a pseudonym back into a person. `ADMIN` only, in their own scope, and
 * never silently.
 *
 * This is the function the entire safety argument in src/lib/shadow.ts rests
 * on. It is also the most dangerous one in this lane, so it is deliberately
 * awkward: it demands a written reason, it writes an audit row *before* it
 * reads the user, and it will not run without an idempotency key.
 *
 * **The phone number is not returned**, and that is a decision rather than an
 * oversight. This answers "who wrote this", which is what deciding on a report
 * needs. Reaching a child's guardian is a heavier act with a different
 * justification, and it should not fall out of clicking a button in a queue.
 */
export async function revealAuthor(opts: {
  moderator: User;
  postId: string;
  reason: string;
  idempotencyKey: string;
}): Promise<ResolvedAuthor> {
  if (opts.moderator.role !== "ADMIN") throw ApiError.forbidden();
  if (!opts.reason.trim()) {
    throw ApiError.validation([
      { path: "reason", message: "say why you need to identify this student" },
    ]);
  }

  const target = await requireReadablePost(opts.moderator, opts.postId);
  const parsed = parseSlug(target.paperSlug);
  if (!parsed) throw ApiError.notFound("Doubt");
  const threadId = parsed.kind === "doubt" ? target.id : (parsed.targetId ?? target.id);

  const { row: action } = await createOnce({
    constraint: "idempotencyKey",
    create: () =>
      prisma.submission.create({
        data: {
          studentId: opts.moderator.id,
          paperSlug: buildSlug({ kind: "action", verb: "reveal", targetId: opts.postId }),
          subject: target.subject,
          classNum: target.classNum,
          idempotencyKey: opts.idempotencyKey,
          status: statusFor("VISIBLE"),
          gradedAt: new Date(),
          answers: {
            create: { questionNumber: 0, maxMarks: 0, type: "SA", transcript: opts.reason.trim() },
          },
        },
      }),
    find: () =>
      prisma.submission.findUnique({
        where: {
          studentId_idempotencyKey: {
            studentId: opts.moderator.id,
            idempotencyKey: opts.idempotencyKey,
          },
        },
      }),
  });

  const author = await prisma.user.findUniqueOrThrow({
    where: { id: target.studentId },
    select: {
      id: true,
      displayName: true,
      role: true,
      studentProfile: { select: { classNum: true } },
    },
  });

  const shadow = target.pageCount === 1;
  const attribution = await attributeThread({
    threadId,
    viewerId: opts.moderator.id,
    authors: [{ userId: author.id, displayName: author.displayName, shadow }],
  });

  return {
    userId: author.id,
    displayName: author.displayName,
    role: author.role,
    classNum: author.studentProfile?.classNum ?? null,
    pseudonym: shadow
      ? (attribution.get(attributionKey(author.id, true))?.label ?? null)
      : null,
    revealedAt: action.createdAt.toISOString(),
    actionId: action.id,
  };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  verb: ModerationVerb;
  note: string;
  moderatorId: string;
  moderatorName: string | null;
  at: string;
}

/**
 * Everything a moderator has done to one post, oldest first. Includes every
 * reveal — a student, or a regulator, asking "who looked me up and why" gets an
 * answer from this.
 */
export async function auditTrail(opts: {
  moderator: User;
  postId: string;
}): Promise<AuditEntry[]> {
  if (opts.moderator.role !== "ADMIN") throw ApiError.forbidden();

  const where: Prisma.SubmissionWhereInput = {
    paperSlug: { startsWith: `${DOUBT_PREFIX}/action/`, endsWith: `/${opts.postId}` },
    student: { scopeId: opts.moderator.scopeId },
  };
  const rows = await prisma.submission.findMany({
    where,
    select: {
      id: true,
      paperSlug: true,
      createdAt: true,
      studentId: true,
      student: { select: { displayName: true } },
      answers: { select: { transcript: true }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.flatMap((r) => {
    const parsed = parseSlug(r.paperSlug);
    if (!parsed?.verb) return [];
    return [
      {
        id: r.id,
        verb: parsed.verb,
        note: r.answers[0]?.transcript ?? "",
        moderatorId: r.studentId,
        moderatorName: r.student.displayName,
        at: r.createdAt.toISOString(),
      },
    ];
  });
}
