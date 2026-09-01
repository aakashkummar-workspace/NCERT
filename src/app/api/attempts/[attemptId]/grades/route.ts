/**
 * GET /api/attempts/{attemptId}/grades/   what the server knows about a sitting
 *
 * The return leg of the seam. `POST /api/attempts/` carries a finished sitting
 * up; this carries back the two things the device cannot know — that a page has
 * been photographed, and that somebody has marked it — in the shape
 * `WrittenHandoff` in `src/lib/test-attempts.ts` is written in, one entry per
 * *paper question number*, so a caller needs nothing but `handoffId(attemptId,
 * questionNumber)` to write it back.
 *
 * `attachScan()` and `attachGrade()` are the two writers that contract names,
 * and until now nothing in `src/` called either. `src/lib/handoff-sync.ts` is
 * the caller; this is what it reads.
 *
 * ## The current mark, not every mark
 *
 * Grading is append-only: an AI draft a teacher overrode is still a row. The
 * highest revision is the current verdict — equivalently the row nothing
 * supersedes, and `@@unique([answerId, revision])` plus the unique on
 * `supersedesId` mean the two definitions cannot disagree. Only that one is
 * returned. The chain itself is on the results screen, where it belongs: a
 * revision card wants the mark that stands, and showing a student a superseded
 * one on a phone would be a second, contradictory answer to "what did I get".
 *
 * Nothing here takes a student id from anywhere: the attempt is looked up by
 * `{ id, studentId: user.id }`, so an attempt that is not the caller's own is
 * indistinguishable from one that does not exist — a 404, never a 403, exactly
 * as `src/app/api/submissions/access.ts` argues.
 */
import { ApiError, route } from "@/lib/api";
import prisma from "@/lib/db";

/** Prisma's verdicts, in the words data/rubrics.schema.md uses. */
const OUTCOME = {
  HIT: "hit",
  PARTIAL: "partial",
  MISS: "miss",
  UNMARKED: "unmarked",
} as const;

export const GET = route({ auth: "STUDENT" }, async ({ user, params }) => {
  const raw = params.attemptId;
  const attemptId = Array.isArray(raw) ? raw[0] : raw;
  if (!attemptId) throw ApiError.notFound("Attempt");

  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, studentId: user.id },
    select: { id: true, clientAttemptId: true },
  });
  if (!attempt) throw ApiError.notFound("Attempt");

  const answers = await prisma.answer.findMany({
    where: {
      attemptQuestion: { attemptId: attempt.id },
      // Belt and braces. The join above already implies it, and stating it
      // means a mis-bound row can never hand one student another's mark.
      submission: { studentId: user.id },
    },
    select: {
      id: true,
      questionNumber: true,
      maxMarks: true,
      gradingResults: {
        orderBy: { revision: "desc" },
        take: 1,
        select: {
          id: true,
          source: true,
          revision: true,
          awardedMarks: true,
          maxMarks: true,
          createdAt: true,
          rubric: {
            select: { externalId: true, variant: true, needsReview: true },
          },
          criterionResults: {
            select: {
              awarded: true,
              verdict: true,
              rubricCriterion: { select: { stepId: true } },
            },
          },
        },
      },
    },
  });

  return {
    attemptId: attempt.id,
    clientAttemptId: attempt.clientAttemptId,
    questions: answers
      .sort((a, b) => a.questionNumber - b.questionNumber)
      .map((answer) => {
        const [current] = answer.gradingResults;
        return {
          questionNumber: answer.questionNumber,
          /**
           * The scan lane's opaque id, as `attachScan` wants it. It is the
           * `Answer` row — one question's worth of handwriting — rather than a
           * page, because that is the unit everything downstream grades.
           */
          scanId: answer.id,
          maxMarks: Number(answer.maxMarks),
          grade: current && {
            awarded: Number(current.awardedMarks),
            maxMarks: Number(current.maxMarks),
            gradedAt: current.createdAt.getTime(),
            revision: current.revision,
            /** `self` never appears here: the server never holds a self-report. */
            source: current.source === "HUMAN" ? ("teacher" as const) : ("rubric" as const),
            rubricId: current.rubric?.externalId ?? undefined,
            variant: current.rubric?.variant || undefined,
            needsReview: current.rubric?.needsReview ?? undefined,
            steps: current.criterionResults.map((cr) => ({
              stepId: cr.rubricCriterion.stepId,
              outcome: OUTCOME[cr.verdict],
              awarded: Number(cr.awarded),
            })),
          },
        };
      }),
  };
});
