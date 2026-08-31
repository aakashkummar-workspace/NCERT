/**
 * GET /api/submissions/{id}/   everything the results screen draws.
 *
 * One request, because the screen is one screen: the scan, the spans over it,
 * the rubric checklist beside it, and **the marking scheme's own words** for
 * every line of that checklist. Reading the scheme is an exam skill in itself,
 * and printing it is what makes a wrong grade arguable rather than
 * authoritative — a student who can see what the mark was for can say "but I
 * did write that".
 *
 * `unmarkedMarks` is returned separately from `awardedMarks` and is not folded
 * into either. "You scored 3 out of 5" and "of the 4 marks anyone has checked,
 * you scored 3" are different claims, and only the second is true when a
 * diagram step is waiting for a person.
 */
import { route } from "@/lib/api";
import prisma from "@/lib/db";
import storage from "@/lib/storage";
import { criterionHalves, fromHalves, loadRubric, type LoadedCriterion } from "@/lib/rubric-load";
import { param, requireVisibleSubmission } from "../access";

/** The scheme's own words, as a tree the UI can render beside the scan. */
function schemeLines(criteria: LoadedCriterion[]): unknown[] {
  return criteria.map((c) => ({
    criterionId: c.id,
    stepId: c.stepId,
    kind: c.kind,
    awardFor: c.awardFor,
    branchLabel: c.branchLabel,
    marks: fromHalves(criterionHalves(c)),
    chooseAtLeast: c.chooseAtLeast,
    marksEach: c.marksEach,
    unitRequired: c.unitRequired,
    unitAccepted: c.unitAccepted,
    labels: c.labels,
    tags: c.tags,
    tagDemands: c.tagDemands,
    autoGradable: c.autoGradable,
    partialRules: c.partialRules.map((p) => ({ reason: p.reason, award: p.award, note: p.note })),
    children: schemeLines(c.children),
  }));
}

export const GET = route({ auth: "any" }, async ({ user, params }) => {
  const submissionId = param(params, "id");
  await requireVisibleSubmission(user, submissionId);

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      pages: { orderBy: { pageIndex: "asc" } },
      answers: {
        orderBy: { questionNumber: "asc" },
        include: {
          pages: { orderBy: { ordinal: "asc" } },
          gradingResults: {
            orderBy: { revision: "desc" },
            include: {
              criterionResults: {
                include: {
                  rubricCriterion: { select: { id: true, stepId: true, kind: true, awardFor: true } },
                  partialRule: { select: { reason: true, award: true, note: true } },
                },
              },
              highlights: true,
              evaluator: { select: { id: true, displayName: true } },
            },
          },
        },
      },
    },
  });
  if (!submission) return { submission: null };

  const pageUrls = new Map<string, string>();
  for (const page of submission.pages) {
    // Signed at read time. Fifteen minutes, and never stored on a row.
    pageUrls.set(page.id, await storage.getSignedUrl(page.storageKey));
  }

  const answers = [];
  for (const answer of submission.answers) {
    const [current, ...superseded] = answer.gradingResults;
    const rubric = current?.rubricId ? await loadRubric(current.rubricId) : null;

    // Marks nobody has judged. Read off the criterion results rather than
    // stored, because the number only means anything against this rubric.
    let unmarkedMarks = 0;
    if (current && rubric) {
      const byId = new Map(rubric.criteria.map((c) => [c.id, c]));
      for (const cr of current.criterionResults) {
        if (cr.verdict !== "UNMARKED") continue;
        const criterion = byId.get(cr.rubricCriterionId);
        if (criterion) unmarkedMarks += fromHalves(criterionHalves(criterion));
      }
    }

    answers.push({
      answerId: answer.id,
      questionNumber: answer.questionNumber,
      maxMarks: Number(answer.maxMarks),
      type: answer.type,
      transcript: answer.transcript,
      pages: answer.pages.map((p) => ({ submissionPageId: p.submissionPageId, ordinal: p.ordinal })),
      rubric: rubric && {
        id: rubric.id,
        externalId: rubric.externalId,
        prompt: rubric.prompt,
        maxMarks: rubric.maxMarks,
        ordering: rubric.ordering,
        acceptEquivalentWording: rubric.acceptEquivalentWording,
        // The flag the student is entitled to see: it is why a step they got
        // wrong is showing as unmarked rather than red.
        needsReview: rubric.needsReview,
        reviewNotes: rubric.reviewNotes,
        schemeFile: rubric.schemeFile,
        schemePage: rubric.schemePage,
        scheme: schemeLines(rubric.criteria),
      },
      grade: current && {
        id: current.id,
        source: current.source,
        revision: current.revision,
        awardedMarks: Number(current.awardedMarks),
        maxMarks: Number(current.maxMarks),
        unmarkedCount: current.unmarkedCount,
        unmarkedMarks,
        /** What the student may honestly be told they were marked out of. */
        checkedMarks: Number(current.maxMarks) - unmarkedMarks,
        confidence: current.confidence,
        modelName: current.modelName,
        evaluator: current.evaluator?.displayName ?? null,
        comment: current.comment,
        createdAt: current.createdAt,
        criteria: current.criterionResults.map((cr) => ({
          /** The CriterionResult row. A highlight span points at this, not at the criterion. */
          resultId: cr.id,
          criterionId: cr.rubricCriterionId,
          stepId: cr.rubricCriterion.stepId,
          kind: cr.rubricCriterion.kind,
          /** The marking scheme's own words. Always shown, never paraphrased. */
          awardFor: cr.rubricCriterion.awardFor,
          verdict: cr.verdict,
          awarded: Number(cr.awarded),
          unmarkedReason: cr.unmarkedReason,
          partialReason: cr.partialRule?.reason ?? null,
          partialNote: cr.partialRule?.note ?? null,
          note: cr.note,
        })),
        highlights: current.highlights.map((h) => ({
          id: h.id,
          criterionResultId: h.criterionResultId,
          submissionPageId: h.submissionPageId,
          color: h.color,
          x: Number(h.x),
          y: Number(h.y),
          width: Number(h.width),
          height: Number(h.height),
          transcriptStart: h.transcriptStart,
          transcriptEnd: h.transcriptEnd,
          label: h.label,
        })),
      },
      // Every earlier verdict, so "AI: 3/5 -> your teacher: 4/5" is a fact on
      // the page rather than a mark that silently changed.
      history: superseded.map((g) => ({
        id: g.id,
        source: g.source,
        revision: g.revision,
        awardedMarks: Number(g.awardedMarks),
        maxMarks: Number(g.maxMarks),
        unmarkedCount: g.unmarkedCount,
        evaluator: g.evaluator?.displayName ?? null,
        createdAt: g.createdAt,
      })),
    });
  }

  return {
    submission: {
      id: submission.id,
      paperSlug: submission.paperSlug,
      subject: submission.subject,
      classNum: submission.classNum,
      status: submission.status,
      pageCount: submission.pageCount,
      failureReason: submission.failureReason,
      capturedAt: submission.capturedAt,
      gradedAt: submission.gradedAt,
      createdAt: submission.createdAt,
      pages: submission.pages.map((p) => ({
        id: p.id,
        pageIndex: p.pageIndex,
        contentType: p.contentType,
        widthPx: p.widthPx,
        heightPx: p.heightPx,
        url: pageUrls.get(p.id) ?? null,
      })),
      answers,
    },
  };
});
