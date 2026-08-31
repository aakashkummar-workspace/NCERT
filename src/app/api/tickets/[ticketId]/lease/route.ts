/**
 * POST /api/tickets/{ticketId}/lease/ — I am still working on this.
 *
 * The canvas calls this on a timer while the evaluator is actually marking, so
 * a long answer does not get swept out from under them mid-sentence. It is not
 * a heartbeat service: nothing here tracks presence, and nothing has to notice
 * an evaluator going away. The lease simply runs out.
 *
 * Scoped to the holder inside the statement rather than checked before it. If
 * the sweeper has already reclaimed the ticket, the `UPDATE` matches nothing
 * and the answer is an honest 409 — "you no longer hold this" — rather than a
 * silently extended lease on a ticket somebody else is now marking.
 */
import { ApiError, route, v } from "@/lib/api";
import { DEFAULT_LEASE_MINUTES, extendLease } from "@/lib/queue";

export const POST = route(
  {
    auth: "EVALUATOR",
    body: v.object({
      minutes: v.optional(v.int({ min: 1, max: 60 })),
    }),
  },
  async ({ user, body, params }) => {
    const ticketId = String(params.ticketId);
    const leaseExpiresAt = await extendLease(
      ticketId,
      user.id,
      body.minutes ?? DEFAULT_LEASE_MINUTES,
    );
    if (!leaseExpiresAt) {
      throw new ApiError(
        "CONFLICT",
        "Your hold on this ticket has ended. Claim it again before carrying on — someone else may be marking it now.",
      );
    }
    return { ticketId, leaseExpiresAt };
  },
);
