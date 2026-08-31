/**
 * POST /api/submissions/{id}/answers/   say which pages hold which question
 *
 * The unit everything downstream grades, highlights and talks over is one
 * question's worth of handwriting — not one page. `AnswerPage` is a real
 * many-to-many because question 31 spills onto the next sheet and that sheet
 * also starts 32, and a model told "here is page 4" instead of "here are the
 * two pages of question 31" marks the wrong thing.
 *
 * Idempotent per answer through `@@unique([submissionId, questionNumber])`
 * rather than through the header: this is one call that writes several rows,
 * and a retry must reconcile each of them, not the batch.
 */
import { ApiError, createOnce, route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { param, requireOwnSubmission } from "../../access";

export const POST = route(
  {
    auth: "STUDENT",
    body: v.object({
      answers: v.array(
        v.object({
          /** The number the paper prints, not a position in a list. */
          questionNumber: v.int({ min: 1, max: 60 }),
          maxMarks: v.number({ min: 0.5, max: 30 }),
          type: v.enumOf(["mcq", "assertion-reason", "vsa", "sa", "la", "case-study"] as const),
          /** Page indexes this answer occupies, in reading order. */
          pageIndexes: v.array(v.int({ min: 0, max: 39 }), { min: 1, max: 8 }),
        }),
        { min: 1, max: 40 },
      ),
    }),
  },
  async ({ user, body, params }) => {
    const submissionId = param(params, "id");
    await requireOwnSubmission(user, submissionId);

    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { attemptId: true },
    });

    const pages = await prisma.submissionPage.findMany({
      where: { submissionId },
      select: { id: true, pageIndex: true },
    });
    const pageIdByIndex = new Map(pages.map((p) => [p.pageIndex, p.id]));

    const TYPES = {
      mcq: "MCQ",
      "assertion-reason": "ASSERTION_REASON",
      vsa: "VSA",
      sa: "SA",
      la: "LA",
      "case-study": "CASE_STUDY",
    } as const;

    const written: { answerId: string; questionNumber: number; created: boolean }[] = [];
    for (const answer of body.answers) {
      const missing = answer.pageIndexes.filter((i) => !pageIdByIndex.has(i));
      if (missing.length) {
        throw ApiError.validation([
          {
            path: `answers.q${answer.questionNumber}.pageIndexes`,
            message: `no page has been uploaded at index ${missing.join(", ")}`,
          },
        ]);
      }

      // Where the submission belongs to a timed run, the answer joins the mark
      // grid, so a grade can be copied down onto the row a results screen reads.
      let attemptQuestionId: string | null = null;
      if (submission?.attemptId) {
        const row = await prisma.attemptQuestion.findUnique({
          where: {
            attemptId_questionNumber: {
              attemptId: submission.attemptId,
              questionNumber: answer.questionNumber,
            },
          },
          select: { id: true },
        });
        attemptQuestionId = row?.id ?? null;
      }

      const { row, created } = await createOnce({
        constraint: "questionNumber",
        create: () =>
          prisma.answer.create({
            data: {
              submissionId,
              attemptQuestionId,
              questionNumber: answer.questionNumber,
              maxMarks: answer.maxMarks,
              type: TYPES[answer.type],
              pages: {
                create: answer.pageIndexes.map((pageIndex, ordinal) => ({
                  submissionPageId: pageIdByIndex.get(pageIndex) as string,
                  ordinal,
                })),
              },
            },
          }),
        find: () =>
          prisma.answer.findUnique({
            where: { submissionId_questionNumber: { submissionId, questionNumber: answer.questionNumber } },
          }),
      });

      if (!created) {
        // A retry that names a different set of pages is a correction, not a
        // duplicate: the student re-shot the page and re-declared it. Rebuild
        // the links rather than leaving the answer pointing at a deleted photo.
        await prisma.answerPage.deleteMany({ where: { answerId: row.id } });
        await prisma.answerPage.createMany({
          data: answer.pageIndexes.map((pageIndex, ordinal) => ({
            answerId: row.id,
            submissionPageId: pageIdByIndex.get(pageIndex) as string,
            ordinal,
          })),
        });
      }

      written.push({ answerId: row.id, questionNumber: row.questionNumber, created });
    }

    return { answers: written };
  },
);
