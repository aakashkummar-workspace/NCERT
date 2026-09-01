/**
 * POST /api/attempts/   sync a finished sitting to the server   (STUDENT)
 * GET  /api/attempts/   the caller's own sittings, newest first
 *
 * **This is the seam.** A dual-track sitting lives in IndexedDB from end to
 * end: `src/lib/test-attempts.ts` owns the clock, the marks and the
 * `WrittenHandoff` rows, and none of it has ever had an HTTP surface. A
 * photographed answer sheet lives in Postgres. Between them sat a column —
 * `Attempt.clientAttemptId`, documented in `prisma/schema.prisma` as "Dexie
 * primary key from src/lib/attempts.ts" — that nothing wrote. So a submission
 * could not name the sitting that produced it, an `Answer` could not be bound
 * to the mark-grid row it answers, a teacher's mark had no way back to
 * `/revise`, and the parent dashboard's subject trend, which is built entirely
 * from `Attempt` rows, was empty for every student on the platform.
 *
 * This route writes that row. It is the *only* thing here that is new: every
 * consumer downstream — `POST /api/submissions/` taking an `attemptId`,
 * `POST /api/submissions/{id}/answers/` resolving an `AttemptQuestion`,
 * `src/lib/review.ts` copying an awarded mark down onto it — was already
 * written and waiting.
 *
 * ## Idempotent by construction, not by header
 *
 * `@@unique([studentId, clientAttemptId])` is the key. A retry, a second tab,
 * a re-sync after a late grade and a student who pressed Finish twice all
 * upsert the *same* row: one exam cannot fork into two. That is a stronger
 * guarantee than an `Idempotency-Key` header gives — the key is the sitting
 * itself rather than a random number the client has to remember — which is why
 * this route does not demand one. §5 of docs/PLATFORM.md asks for the property,
 * not for the header.
 *
 * ## The mark grid is Section B
 *
 * `AttemptQuestion.questionNumber` is **the number the paper prints**, and it
 * is what `/answers/` looks an answer up by. Section A of a dual-track test is
 * assembled from the quiz bank and numbered 1..n by position; those numbers are
 * not the paper's and collide with Section B's. Writing them would bind a
 * photographed page to whichever bank question happened to sit at that index.
 * So the grid is the written half, and Section A reaches the server as marks
 * folded into `Attempt.totalScore` — which is the sitting's one score, exactly
 * as `scoreTest` computes it.
 *
 * ## What the server owns
 *
 * `awardedMarks` on an `AttemptQuestion` is written by the grading lane and is
 * never touched here. A re-sync carries the student's own marks up; it must not
 * be able to overwrite a teacher's.
 *
 * The student is `ctx.user`, from the session cookie. There is no `studentId`
 * in this body, per §1 of docs/PLATFORM.md.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import type { QuestionType } from "@prisma/client";
import { isUniqueViolation, route, v } from "@/lib/api";
import prisma from "@/lib/db";

const TYPES = {
  mcq: "MCQ",
  "assertion-reason": "ASSERTION_REASON",
  vsa: "VSA",
  sa: "SA",
  la: "LA",
  "case-study": "CASE_STUDY",
} as const satisfies Record<string, QuestionType>;

export const POST = route(
  {
    auth: "STUDENT",
    body: v.object({
      /** The Dexie key: `${testSlug}:${startedAt}`. Unique per student, not global. */
      clientAttemptId: v.string({ min: 1, max: 120 }),
      paperSlug: v.string({ max: 120 }),
      subject: v.string({ max: 60 }),
      classNum: v.int({ min: 9, max: 10 }),
      maxMarks: v.int({ min: 0, max: 1000 }),
      startedAt: v.date(),
      durationMs: v.int({ min: 0, max: 24 * 60 * 60 * 1000 }),
      submittedAt: v.optional(v.date()),
      status: v.enumOf(["in-progress", "submitted"] as const),
      /** The whole sitting's score — both tracks. Absent until it is finished. */
      totalScore: v.optional(v.number({ min: 0, max: 1000 })),
      /** The written half, by the paper's own printed numbers. */
      questions: v.array(
        v.object({
          questionNumber: v.int({ min: 1, max: 60 }),
          maxMarks: v.number({ min: 0, max: 30 }),
          type: v.enumOf(
            ["mcq", "assertion-reason", "vsa", "sa", "la", "case-study"] as const,
          ),
          sectionLabel: v.optional(v.string({ max: 8 })),
          topic: v.optional(v.string({ max: 60 })),
          /** What the student gave themselves. Null where nobody has scored it. */
          selfScore: v.optional(v.number({ min: 0, max: 30 })),
          /** False only where the student *said* they left it blank. */
          attempted: v.boolean(),
        }),
        { min: 0, max: 60 },
      ),
    }),
  },
  async ({ user, body }) => {
    const data = {
      paperSlug: body.paperSlug,
      subject: body.subject,
      classNum: body.classNum,
      maxMarks: body.maxMarks,
      startedAt: body.startedAt,
      durationMs: body.durationMs,
      submittedAt: body.submittedAt ?? null,
      status: body.status === "submitted" ? ("SUBMITTED" as const) : ("IN_PROGRESS" as const),
      totalScore:
        body.totalScore === undefined ? null : new Prisma.Decimal(body.totalScore.toFixed(2)),
    };

    // Upsert on the natural key. Two tabs finishing the same sitting at once
    // both take this path; the loser of the insert race gets a unique violation
    // and updates instead, which is the same end state.
    let attempt;
    let created = false;
    try {
      attempt = await prisma.attempt.create({
        data: { studentId: user.id, clientAttemptId: body.clientAttemptId, ...data },
      });
      created = true;
    } catch (err) {
      if (!isUniqueViolation(err, "clientAttemptId")) throw err;
      attempt = await prisma.attempt.update({
        where: {
          studentId_clientAttemptId: {
            studentId: user.id,
            clientAttemptId: body.clientAttemptId,
          },
        },
        data,
      });
    }

    // Deduplicated by the paper's number, because a client that sent the same
    // question twice would otherwise get a unique violation mid-loop and leave
    // half a grid behind.
    const seen = new Set<number>();
    const questions: { questionNumber: number; attemptQuestionId: string }[] = [];
    for (const q of body.questions) {
      if (seen.has(q.questionNumber)) continue;
      seen.add(q.questionNumber);
      const shared = {
        maxMarks: Math.round(q.maxMarks),
        type: TYPES[q.type],
        sectionLabel: q.sectionLabel ?? null,
        topic: q.topic ?? null,
        selfScore:
          q.selfScore === undefined ? null : new Prisma.Decimal(q.selfScore.toFixed(2)),
        attempted: q.attempted,
      };
      const row = await prisma.attemptQuestion.upsert({
        where: {
          attemptId_questionNumber: {
            attemptId: attempt.id,
            questionNumber: q.questionNumber,
          },
        },
        // `awardedMarks` is absent from both halves on purpose: it belongs to
        // the grading lane, and a re-sync must not overwrite a teacher's mark
        // with the student's own.
        create: { attemptId: attempt.id, questionNumber: q.questionNumber, ...shared },
        update: shared,
        select: { id: true, questionNumber: true },
      });
      questions.push({ questionNumber: row.questionNumber, attemptQuestionId: row.id });
    }

    return NextResponse.json(
      {
        attemptId: attempt.id,
        clientAttemptId: attempt.clientAttemptId,
        created,
        questions,
      },
      { status: created ? 201 : 200 },
    );
  },
);

/**
 * Every sitting this student has, newest first — the sittings history at
 * `/sittings/`.
 *
 * Four counts come back beside each row, and they are four genuinely different
 * states that a single "graded / not graded" flag would flatten into a lie:
 *
 *   `questions`   rows in the mark grid — the size of the paper
 *   `selfMarked`  the student marked themselves against the scheme
 *   `sent`        a photograph of that question was submitted for marking
 *   `marked`      somebody (a rubric or a teacher) awarded a mark
 *
 * A self-marked practice paper is `selfMarked > 0, sent 0, marked 0`, and that
 * is not a broken sitting — it is the normal and complete state of the flow
 * most students use. The screen says so in words rather than showing an empty
 * marks column.
 *
 * The counts are aggregated here rather than shipped as rows: fifty sittings at
 * forty questions is two thousand rows to say four numbers apiece, on a phone.
 * `answers` is counted per grid row because that is what "this question was
 * photographed" means — a `Submission` can exist with no answer declared on it.
 */
export const GET = route({ auth: "STUDENT" }, async ({ user }) => {
  const attempts = await prisma.attempt.findMany({
    where: { studentId: user.id },
    orderBy: { startedAt: "desc" },
    take: 50,
    select: {
      id: true,
      clientAttemptId: true,
      paperSlug: true,
      subject: true,
      classNum: true,
      status: true,
      maxMarks: true,
      totalScore: true,
      startedAt: true,
      submittedAt: true,
      questions: {
        select: {
          selfScore: true,
          awardedMarks: true,
          _count: { select: { answers: true } },
        },
      },
      _count: { select: { submissions: true } },
    },
  });
  return {
    attempts: attempts.map(({ questions, _count, ...a }) => ({
      ...a,
      totalScore: a.totalScore === null ? null : Number(a.totalScore),
      questions: questions.length,
      selfMarked: questions.filter((q) => q.selfScore !== null).length,
      sent: questions.filter((q) => q._count.answers > 0).length,
      marked: questions.filter((q) => q.awardedMarks !== null).length,
      submissions: _count.submissions,
    })),
  };
});
