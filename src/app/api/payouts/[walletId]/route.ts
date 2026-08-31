/**
 * GET /api/payouts/{walletId}/  — the verification checklist for one wallet.
 *
 * What the admin ticks before authorising: every unsettled earning, line by
 * line, with the total they add up to. The portal shows exactly this and
 * nothing inferred, because "you are about to pay ₹1,240" is only trustworthy
 * if the eleven rows above it are the eleven rows the settle call will claim.
 *
 * `walletInCentre()` resolves the wallet **and** the authorisation in one
 * lookup: a wallet in another centre and a wallet that does not exist come back
 * the same way and leave here as the same 403. A 403 that distinguished them
 * would be a membership oracle telling a stranger which wallet ids are real
 * (docs/PLATFORM.md §3).
 */
import { ApiError, route } from "@/lib/api";
import { earningsFor, decimalFromPaise, paiseFromDecimal, sumPaise, walletBalance, walletInCentre } from "@/lib/ledger";
import prisma from "@/lib/db";

export const GET = route({ auth: "ADMIN" }, async ({ user, params }) => {
  const walletId = String(params.walletId ?? "");
  const wallet = await walletInCentre(walletId, user.scopeId);
  if (!wallet) throw ApiError.forbidden("You do not have access to this.");

  const [entries, balance, tutor] = await Promise.all([
    earningsFor(wallet.id, { limit: 500 }),
    walletBalance(wallet.id),
    prisma.user.findUnique({
      where: { id: wallet.tutorId },
      select: { id: true, displayName: true, phone: true, role: true },
    }),
  ]);

  const pending = entries.filter((e) => e.settledByTransactionId === null);

  return {
    wallet: {
      id: wallet.id,
      centreScopeId: wallet.centreScopeId,
      currency: wallet.currency,
    },
    tutor: tutor
      ? { id: tutor.id, displayName: tutor.displayName, phone: tutor.phone, role: tutor.role }
      : null,
    balance,
    /** The exact sum of `pendingEntries` below. Settling all of them pays this. */
    pendingTotal: decimalFromPaise(sumPaise(pending.map((e) => paiseFromDecimal(e.amount)))),
    pendingEntries: pending.map((e) => ({
      transactionId: e.transactionId,
      amount: e.amount,
      subject: e.subject,
      classNum: e.classNum,
      pageCount: e.pageCount,
      ticketId: e.ticketId,
      memo: e.memo,
      createdAt: e.createdAt.toISOString(),
    })),
    settledEntries: entries
      .filter((e) => e.settledByTransactionId !== null)
      .map((e) => ({
        transactionId: e.transactionId,
        amount: e.amount,
        subject: e.subject,
        classNum: e.classNum,
        createdAt: e.createdAt.toISOString(),
        settledByTransactionId: e.settledByTransactionId,
        settledAt: e.settledAt?.toISOString() ?? null,
      })),
  };
});
