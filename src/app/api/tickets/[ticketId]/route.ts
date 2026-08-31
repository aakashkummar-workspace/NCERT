/**
 * GET /api/tickets/{ticketId}/ — everything the grading canvas draws.
 *
 * One request, because the canvas is a split screen and a half-loaded split
 * screen is worse than a spinner: an evaluator who sees the scan before the
 * rubric starts forming an opinion without it.
 *
 * The payload is deliberately the same for every evaluator type. A school
 * teacher, an internal tutor and a freelance marker get byte-identical JSON for
 * the same ticket; the PRD's "the grading interface must be identical for
 * internal tutors and school teachers" is only true if the data behind it is,
 * and a role-shaped payload is how two interfaces grow out of one component.
 * What a role changes is `permissions` below — what you may *do* — never what
 * you see.
 *
 * Page URLs are minted here, at read time, and never stored: `storageKey` is an
 * object key and a pre-signed URL is a dead link by tomorrow. The signature is
 * not the authorisation — `ticketForUser` already established that this person
 * has business seeing this script, which is the check PLATFORM §4 asks every
 * lane that hands out a URL to apply before it does.
 */
import { route } from "@/lib/api";
import prisma from "@/lib/db";
import { ticketForUser } from "@/lib/queue";
import { checklistFor, gradeChainFor, transcriptionProvider } from "@/lib/review";
import storage from "@/lib/storage";

export const GET = route({ auth: ["EVALUATOR", "ADMIN"] }, async ({ user, params }) => {
  const ticketId = String(params.ticketId);
  const { ticket, holdsLease } = await ticketForUser(ticketId, user);

  const submission = await prisma.submission.findUnique({
    where: { id: ticket.submissionId },
    include: {
      pages: { orderBy: { pageIndex: "asc" } },
      answers: {
        orderBy: { questionNumber: "asc" },
        include: {
          pages: { orderBy: { ordinal: "asc" } },
          voiceNotes: { orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  if (!submission) throw new Error(`Ticket ${ticketId} has no submission`);

  const pages = await Promise.all(
    submission.pages.map(async (p) => ({
      id: p.id,
      pageIndex: p.pageIndex,
      contentType: p.contentType,
      widthPx: p.widthPx,
      heightPx: p.heightPx,
      ocrStatus: p.ocrStatus,
      /** 15 minutes. Do not store it; ask again. */
      url: await storage.getSignedUrl(p.storageKey),
    })),
  );

  const answers = await Promise.all(
    submission.answers.map(async (a) => ({
      id: a.id,
      questionNumber: a.questionNumber,
      maxMarks: Number(a.maxMarks),
      type: a.type,
      transcript: a.transcript,
      pageIds: a.pages.map((ap) => ap.submissionPageId),
      checklist: await checklistFor(a.id),
      /** The full chain, so the canvas can show "AI: 3/5 → your teacher: 4/5". */
      grades: await gradeChainFor(a.id),
      voiceNotes: await Promise.all(
        a.voiceNotes.map(async (n) => ({
          id: n.id,
          evaluatorId: n.evaluatorId,
          durationMs: n.durationMs,
          mimeType: n.mimeType,
          transcript: n.transcript,
          transcriptLang: n.transcriptLang,
          transcriptStatus: n.transcriptStatus,
          createdAt: n.createdAt.toISOString(),
          url: await storage.getSignedUrl(n.storageKey),
        })),
      ),
    })),
  );

  const myReview = await prisma.evaluatorReview.findFirst({
    where: { ticketId: ticket.id, evaluatorId: user.id, submittedAt: null },
    orderBy: { startedAt: "desc" },
  });

  return {
    ticket,
    submission: {
      id: submission.id,
      paperSlug: submission.paperSlug,
      subject: submission.subject,
      classNum: submission.classNum,
      status: submission.status,
      capturedAt: submission.capturedAt,
    },
    pages,
    answers,
    review: myReview,
    /**
     * What this session may do. The canvas renders the same layout regardless
     * and disables what is not permitted — a read-only evaluator sees the marks
     * and the boxes exactly where a marking one does.
     */
    permissions: {
      canAnnotate: holdsLease,
      canGrade: holdsLease,
      canRecordVoiceNote: holdsLease,
      canRelease: holdsLease,
      readOnlyReason: holdsLease
        ? null
        : user.role === "ADMIN"
          ? "You are viewing this as an administrator."
          : "You are not holding this ticket, so you can read it but not change it.",
    },
    transcription: {
      provider: transcriptionProvider(),
      available: transcriptionProvider() !== null,
    },
  };
});
