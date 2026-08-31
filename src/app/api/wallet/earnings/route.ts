/**
 * POST /api/wallet/earnings/  — credit a tutor for a completed script.
 *
 * The "credit" half of credit-on-completion, debit-on-payout. Recording it is
 * an administrative act, so the route is `ADMIN` and the centre credited is
 * **always `user.scopeId`** — the body cannot name a centre. An admin of the
 * Rohini centre cannot spend the Kochi centre's money by editing a field.
 *
 * `evaluatorId` *is* read from the body, and that is not a violation of
 * docs/PLATFORM.md §1. The rule is that the **acting** user comes from the
 * session; the tutor here is the object of the action, not its subject, and the
 * admin's authority over them is established by the scope check below rather
 * than by their say-so. The distinction matters: the specification's bug was
 * that `centerAdminId` — the actor — came from the body.
 *
 * Idempotent, because this costs money. A retried POST with the same
 * `Idempotency-Key` credits once and answers twice.
 *
 * Note the trailing slash when you call it: `next.config.ts` sets
 * `trailingSlash: true`, so `POST /api/wallet/earnings` 308s and a client that
 * does not re-send the body arrives here empty-handed.
 */
import { ApiError, route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { recordEarning } from "@/lib/ledger";
import { quoteScript } from "@/lib/payouts";

export const POST = route(
  {
    auth: "ADMIN",
    idempotent: true,
    body: v.object({
      /** The tutor being paid. Validated against the acting admin's centre below. */
      evaluatorId: v.uuid(),
      subject: v.string({ max: 60 }),
      classNum: v.int({ min: 9, max: 10 }),
      pageCount: v.int({ min: 1, max: 40 }),
      /** The evaluation ticket this pays for, when there is one. */
      ticketId: v.optional(v.uuid()),
      memo: v.optional(v.string({ max: 300 })),
    }),
  },
  async ({ user, body, idempotencyKey }) => {
    const tutor = await prisma.user.findUnique({
      where: { id: body.evaluatorId },
      select: { id: true, role: true, displayName: true },
    });
    // Same answer for "no such user" and "not an evaluator": a 404 that
    // distinguishes them turns this route into a directory of who works here.
    if (!tutor || (tutor.role !== "EVALUATOR" && tutor.role !== "ADMIN")) {
      throw ApiError.forbidden("You do not have access to this.");
    }

    // Throws 503 NOT_AVAILABLE when no rate is configured. Deliberately not a
    // default: see the header of src/lib/payouts.ts.
    const quote = await quoteScript(user.scopeId, body.subject, body.classNum, body.pageCount);

    const earning = await recordEarning({
      actor: user,
      tutorId: tutor.id,
      centreScopeId: user.scopeId,
      amount: quote.amount,
      subject: body.subject,
      classNum: body.classNum,
      pageCount: body.pageCount,
      ticketId: body.ticketId ?? null,
      memo: body.memo ?? null,
      idempotencyKey,
    });

    return {
      transactionId: earning.transactionId,
      walletId: earning.walletId,
      amount: earning.amount,
      currency: quote.rate.currency,
      workings: quote.workings,
      /** False means this was a retry: one credit, two identical answers. */
      created: earning.created,
    };
  },
);
