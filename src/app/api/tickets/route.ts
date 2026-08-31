/**
 * GET /api/tickets/ — the master bulletin board.
 *
 * One board, two engines. A rostered tuition tutor and a freelance marker see
 * the same list rendered by the same component; what differs is which rows are
 * on it, and that difference comes from the session and the evaluator's own
 * profile, never from a query parameter. The PRD's "the grading interface must
 * be identical for internal tutors and school teachers" starts here: if the
 * board were a different endpoint per evaluator type, the canvas would be a
 * different component per evaluator type by the end of the quarter.
 *
 * An evaluator sees:
 *   - `mine`      — tickets they are holding, with the lease clock on each.
 *   - `available` — tickets they could claim right now: their subjects, their
 *                   classes, unassigned or assigned to them.
 * An admin sees the whole board **for their own scope**, which is the nil UUID
 * for everyone today and will not be forever.
 */
import { route } from "@/lib/api";
import prisma from "@/lib/db";
import {
  evaluatorContext,
  ineligibleReason,
  INELIGIBLE_MESSAGE,
  OPEN_TICKET_STATUSES,
} from "@/lib/queue";
import type { Prisma } from "@prisma/client";

const TICKET_CARD = {
  id: true,
  submissionId: true,
  subject: true,
  classNum: true,
  priority: true,
  status: true,
  assignedEvaluatorId: true,
  claimedById: true,
  claimedAt: true,
  leaseExpiresAt: true,
  claimCount: true,
  slaDueAt: true,
  createdAt: true,
  submission: {
    select: {
      id: true,
      paperSlug: true,
      pageCount: true,
      status: true,
      capturedAt: true,
      // Never the student's name or phone. An evaluator marks a script, not a
      // person, and a name on the card is a thumb on the scale.
      _count: { select: { answers: true } },
    },
  },
} satisfies Prisma.EvaluationTicketSelect;

export const GET = route({ auth: ["EVALUATOR", "ADMIN"] }, async ({ user }) => {
  // Every query is filtered through the submission's student to this scope.
  // It is the nil UUID for everyone right now; the query that forgets is the
  // one that shows one school another school's marks the day it is not.
  const inScope = { submission: { student: { scopeId: user.scopeId } } };

  if (user.role === "ADMIN") {
    const tickets = await prisma.evaluationTicket.findMany({
      where: inScope,
      orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "asc" }],
      take: 200,
      select: TICKET_CARD,
    });
    return { view: "ADMIN" as const, tickets };
  }

  const ctx = await evaluatorContext(user);
  const refused = ineligibleReason(ctx);

  const mine = await prisma.evaluationTicket.findMany({
    where: { ...inScope, claimedById: user.id, status: { in: [...OPEN_TICKET_STATUSES] } },
    orderBy: [{ leaseExpiresAt: "asc" }],
    select: TICKET_CARD,
  });

  // The same predicate the claim statement uses, minus the row lock: what this
  // evaluator would get if they pressed the button. Showing a board whose rows
  // the claim would then refuse is how an evaluator learns not to trust it.
  const available = ctx.qualifications.length
    ? await prisma.evaluationTicket.findMany({
        where: {
          ...inScope,
          status: "PENDING",
          claimedAt: null,
          OR: ctx.qualifications.map((q) => ({ subject: q.subject, classNum: q.classNum })),
          AND: [{ OR: [{ assignedEvaluatorId: null }, { assignedEvaluatorId: user.id }] }],
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        take: 100,
        select: TICKET_CARD,
      })
    : [];

  return {
    view: "EVALUATOR" as const,
    evaluator: {
      evaluatorType: ctx.profile.evaluatorType,
      activeForRouting: ctx.profile.activeForRouting,
      maxConcurrent: ctx.profile.maxConcurrent,
      openTickets: ctx.openTickets,
      onShift: ctx.onShift,
      shift: ctx.shift,
      qualifications: ctx.qualifications,
      /** Non-null means the claim button is disabled, and says why. */
      canClaim: refused === null,
      refusedReason: refused,
      refusedMessage: refused ? INELIGIBLE_MESSAGE[refused] : null,
    },
    mine,
    available,
  };
});
