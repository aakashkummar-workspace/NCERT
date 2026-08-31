/**
 * POST /api/reviews/ — open the canvas on a ticket you are holding.
 *
 * A review is one evaluator's pass over one ticket. It is a separate row from
 * the ticket because a ticket can be claimed, abandoned and re-claimed, and
 * each pass is its own record of who looked at what and for how long — the
 * thing an accuracy measurement is eventually computed over.
 *
 * Opening the canvas twice in two tabs must not open two passes. There is no
 * unique on `(ticketId, evaluatorId)` to lean on, so the reuse-or-create runs
 * inside a transaction that takes a row lock on the ticket first: the second
 * tab waits, then finds the first tab's review. `createOnce` does not apply
 * here — there is no constraint for it to catch.
 *
 * GET /api/reviews/ lists this evaluator's own open passes, so a tab reopened
 * after a crash finds its way back.
 */
import { route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { beginReviewOnTicket, heldTicket } from "@/lib/queue";

export const POST = route(
  {
    auth: "EVALUATOR",
    idempotent: true,
    body: v.object({ ticketId: v.uuid() }),
  },
  async ({ user, body }) => {
    // Establishes both that the ticket is visible to this user and that the
    // lease is theirs. A review by someone who is not holding the ticket is a
    // second person marking the same script.
    const ticket = await heldTicket(body.ticketId, user);

    const { review, created } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM evaluation_tickets WHERE id = ${ticket.id}::uuid FOR UPDATE`;

      const open = await tx.evaluatorReview.findFirst({
        where: { ticketId: ticket.id, evaluatorId: user.id, submittedAt: null },
        orderBy: { startedAt: "desc" },
      });
      if (open) return { review: open, created: false };

      const fresh = await tx.evaluatorReview.create({
        data: { ticketId: ticket.id, evaluatorId: user.id },
      });
      return { review: fresh, created: true };
    });

    await beginReviewOnTicket(ticket.id, user.id);

    return { review, created };
  },
);

export const GET = route({ auth: "EVALUATOR" }, async ({ user }) => {
  const reviews = await prisma.evaluatorReview.findMany({
    where: { evaluatorId: user.id, submittedAt: null },
    orderBy: { startedAt: "desc" },
    include: {
      ticket: {
        select: { id: true, subject: true, classNum: true, status: true, leaseExpiresAt: true },
      },
    },
  });
  return { reviews };
});
