/**
 * GET /api/wallet/  — what the signed-in tutor has earned, and what is pending.
 *
 * There is no `?tutorId=`, no `userId` in a body, and no admin override on this
 * path. The wallet returned is the wallet of whoever holds the cookie, full
 * stop (docs/PLATFORM.md §1). An admin looking at somebody's pay uses
 * `/api/payouts/`, which is scoped to their own centre and says so.
 *
 * Any signed-in role may call it. A student simply has no wallets and gets an
 * empty list — cheaper and less surprising than a 403 that tells them a wallet
 * system exists and they are excluded from it.
 */
import { route } from "@/lib/api";
import { earningsFor, tutorWallets } from "@/lib/ledger";

export const GET = route({ auth: "any" }, async ({ user }) => {
  const wallets = await tutorWallets(user.id);

  const centres = await Promise.all(
    wallets.map(async (row) => ({
      walletId: row.wallet.id,
      centreScopeId: row.wallet.centreScopeId,
      currency: row.wallet.currency,
      balance: row.balance,
      pendingEntryCount: row.pendingEntryCount,
      // Newest first, capped. A tutor's own history is theirs to see in full,
      // but a first paint should not wait on three years of it.
      entries: (await earningsFor(row.wallet.id, { limit: 50 })).map((e) => ({
        transactionId: e.transactionId,
        amount: e.amount,
        subject: e.subject,
        classNum: e.classNum,
        pageCount: e.pageCount,
        memo: e.memo,
        createdAt: e.createdAt.toISOString(),
        settled: e.settledByTransactionId !== null,
        settledAt: e.settledAt?.toISOString() ?? null,
      })),
    })),
  );

  return {
    tutor: { id: user.id, displayName: user.displayName, role: user.role },
    wallets: centres,
  };
});
