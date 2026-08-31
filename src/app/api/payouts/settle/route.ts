/**
 * POST /api/payouts/settle/  — authorise a payout and mark the entries settled.
 *
 * This is the route that replaces `executeAdminWalletSettlement` from
 * `CBSE_EdTech_Platform_Technical_Specification.md` §3. Read that function
 * beside this one; every difference is deliberate.
 *
 *   spec                                     here
 *   ─────────────────────────────────────────────────────────────────────────
 *   `const { centerAdminId } = req.body`      `user` from the session cookie,
 *                                             re-read from `users` this request
 *   nothing checks whose wallets these are    `walletInCentre(id, user.scopeId)`
 *   `updateMany({ id: { in: transactionIds }})` a conditional INSERT whose
 *     over the caller's raw ids                 RETURNING names the rows won
 *   read-then-write, two admins both settle   `UNIQUE(earning_tx_id)`: one wins
 *   one row, one wallet, no counter-account   two balanced lines, sum zero
 *   the "immutable" row is UPDATEd            an appended payout transaction
 *   `decrement` a balance nothing increments  balance is `SUM` over the lines
 *   no idempotency at all                     `Idempotency-Key`, required
 *
 * `walletId` and `earningTransactionIds` come from the body, which is correct:
 * they are *what* is being settled, not *who* is settling. Both are filtered in
 * SQL against `user.scopeId`, so ids belonging to another centre select nothing
 * and pay nothing rather than being trusted.
 *
 * Trailing slash required — `POST /api/payouts/settle` 308s, and a 308 on a
 * POST that a client does not re-send with its body intact looks like a
 * mysterious empty request (docs/PLATFORM.md §2).
 */
import { ApiError, route, v } from "@/lib/api";
import { settlePayout, walletInCentre } from "@/lib/ledger";

export const POST = route(
  {
    auth: "ADMIN",
    idempotent: true,
    body: v.object({
      walletId: v.uuid(),
      /**
       * The entries the admin ticked. Explicit rather than "settle everything
       * pending": between rendering the checklist and pressing the button, a
       * concurrent earning can land, and "pay whatever is outstanding" would
       * silently pay a figure nobody read. The client sends what it showed.
       */
      earningTransactionIds: v.array(v.uuid(), { min: 1, max: 500 }),
      /** The admin's verification note — cheque number, UPI reference, "cash". */
      memo: v.optional(v.string({ max: 300 })),
    }),
  },
  async ({ user, body, idempotencyKey }) => {
    // Authorisation and resolution in one step. Wrong centre and no such wallet
    // are the same 403 on purpose.
    const wallet = await walletInCentre(body.walletId, user.scopeId);
    if (!wallet) throw ApiError.forbidden("You do not have access to this.");

    const result = await settlePayout({
      actor: user,
      wallet,
      earningTransactionIds: body.earningTransactionIds,
      idempotencyKey,
      memo: body.memo ?? null,
    });

    return {
      settlementTransactionId: result.settlementTransactionId,
      walletId: result.walletId,
      /** What was actually paid — the sum of the rows claimed, not of the ids sent. */
      amountPaid: result.amountPaid,
      settledTransactionIds: result.settledTransactionIds,
      /** Sent but not claimed: already settled by someone else, or not this wallet's. */
      skippedTransactionIds: result.skippedTransactionIds,
      /** False means this was a retry of a settlement that had already happened. */
      created: result.created,
      balanceAfter: result.balanceAfter,
    };
  },
);
