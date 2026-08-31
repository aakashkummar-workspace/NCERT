/**
 * GET  /api/wallet/rates/  — the payout rates this centre has set.
 * PUT  /api/wallet/rates/  — set or change one.
 *
 * "Subject-specific configuration", as the PRD puts it. Both are `ADMIN` and
 * both are pinned to `user.scopeId`: an admin sets their own centre's rates and
 * has no way to express any other centre, because there is no field for one.
 *
 * Amounts arrive as decimal **strings**, not JSON numbers. `{"basePerScript":
 * 30.10}` is a double before it ever reaches this code and 30.10 is not
 * representable as one; by the time a validator could object, the damage is in
 * the parse. A string crosses the wire exactly as written and
 * `paiseFromDecimal` rejects anything that is not a plain two-decimal figure.
 */
import { route, v } from "@/lib/api";
import { ratesForCentre, setRate } from "@/lib/payouts";

export const GET = route({ auth: "ADMIN" }, async ({ user }) => {
  const rates = await ratesForCentre(user.scopeId);
  return {
    centreScopeId: user.scopeId,
    rates: rates.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
  };
});

/** A decimal figure as text: "30", "30.5", "30.50". Never `1e3`, never a float. */
const money = v.string({ max: 16, pattern: /^\d{1,12}(\.\d{1,2})?$/ });

export const PUT = route(
  {
    auth: "ADMIN",
    body: v.object({
      subject: v.string({ max: 60 }),
      classNum: v.int({ min: 9, max: 10 }),
      basePerScript: money,
      perPageBooster: v.withDefault(money, "0.00"),
      complexityMultiplier: v.withDefault(money, "1.00"),
    }),
  },
  async ({ user, body }) => {
    const rate = await setRate({
      scopeId: user.scopeId,
      actorUserId: user.id,
      subject: body.subject,
      classNum: body.classNum,
      basePerScript: body.basePerScript,
      perPageBooster: body.perPageBooster,
      complexityMultiplier: body.complexityMultiplier,
    });
    return { rate: { ...rate, updatedAt: rate.updatedAt.toISOString() } };
  },
);
