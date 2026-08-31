/**
 * GET /api/payouts/  — every wallet this centre owes into, and what is pending.
 *
 * The clearance portal's first screen. `ADMIN` only, and scoped to
 * `user.scopeId` inside `centreWallets()` — an admin is an admin *of a centre*,
 * not of the platform, and today every B2C row sitting on the nil UUID is
 * exactly why the filter has to be written before it starts mattering.
 */
import { route } from "@/lib/api";
import { centreWallets, journalNet } from "@/lib/ledger";

export const GET = route({ auth: "ADMIN" }, async ({ user }) => {
  const wallets = await centreWallets(user.scopeId);
  return {
    centreScopeId: user.scopeId,
    wallets: wallets.map((row) => ({
      walletId: row.wallet.id,
      tutorId: row.wallet.tutorId,
      tutorName: row.tutorName,
      tutorPhone: row.tutorPhone,
      currency: row.wallet.currency,
      pendingEntryCount: row.pendingEntryCount,
      balance: row.balance,
    })),
    /**
     * The whole journal's signed sum. It is "0.00" or the ledger is broken —
     * surfaced here rather than buried in a test, so that an admin about to
     * authorise money can see the books balance before they do.
     */
    journalNet: await journalNet(),
  };
});
