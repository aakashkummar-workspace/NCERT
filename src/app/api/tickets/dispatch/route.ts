/**
 * POST /api/tickets/dispatch/ — put a submission on the board.
 *
 * This is the dual engine's decision point: rostered tuition staff first, the
 * open gig network second. `decideRouting` explains itself in
 * `src/lib/queue.ts`; this route is the transaction around it.
 *
 * Three things it does that the specification being corrected did not:
 *
 * - **It is idempotent.** `EvaluationTicket.submissionId` is `@unique`, so the
 *   retry that Indian mobile networks generate for free cannot produce a second
 *   ticket and pay two tutors to mark one script. The spec's
 *   `evaluation_tickets` had no unique on anything.
 * - **Subject and class come from the submission row, not from the body.** They
 *   decide who is qualified to mark the paper. A caller who can set them can
 *   route a Class 10 Science script to whoever is idle in Maths.
 * - **It respects `hitlEnabled`.** Routing a student to a human who has not
 *   been enabled for it spends money nobody agreed to spend. An admin may
 *   override with `force`, which is a decision they make in writing.
 */
import { ApiError, createOnce, route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { decideRouting } from "@/lib/queue";

export const POST = route(
  {
    auth: "ADMIN",
    idempotent: true,
    body: v.object({
      submissionId: v.uuid(),
      priority: v.withDefault(v.int({ min: 0, max: 100 }), 0),
      /** Minutes from now. The board sorts by priority, not by this; it is what
       *  an escalation job raises priority *from*. */
      slaMinutes: v.optional(v.int({ min: 1, max: 60 * 24 * 14 })),
      force: v.withDefault(v.boolean(), false),
    }),
  },
  async ({ user, body }) => {
    const submission = await prisma.submission.findUnique({
      where: { id: body.submissionId },
      include: { student: { select: { id: true, scopeId: true, hitlEnabled: true } } },
    });
    // Deliberately the same answer for "not in your scope" as for "does not
    // exist". A 403 that distinguishes them tells a stranger which ids are real.
    if (!submission || submission.student.scopeId !== user.scopeId) {
      throw ApiError.notFound("Submission");
    }

    if (!submission.student.hitlEnabled && !body.force) {
      throw new ApiError(
        "CONFLICT",
        "That student is not enabled for human review. Pass force to route them anyway.",
      );
    }

    const decision = await decideRouting({
      scopeId: user.scopeId,
      subject: submission.subject,
      classNum: submission.classNum,
    });

    const { row, created } = await createOnce({
      constraint: "submissionId",
      create: () =>
        prisma.evaluationTicket.create({
          data: {
            submissionId: submission.id,
            // From the row, never from the request.
            subject: submission.subject,
            classNum: submission.classNum,
            priority: body.priority,
            assignedEvaluatorId: decision.assignedEvaluatorId,
            slaDueAt: body.slaMinutes
              ? new Date(Date.now() + body.slaMinutes * 60_000)
              : null,
          },
        }),
      find: () => prisma.evaluationTicket.findUnique({ where: { submissionId: submission.id } }),
    });

    if (created) {
      await prisma.submission.update({
        where: { id: submission.id },
        data: { status: "AWAITING_REVIEW" },
      });
    }

    return { ticket: row, created, routing: decision };
  },
);
