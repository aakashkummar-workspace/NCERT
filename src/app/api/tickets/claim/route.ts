/**
 * POST /api/tickets/claim/ — take the next ticket.
 *
 * The whole route is one call into `claimNextTicket`, which is one conditional
 * `UPDATE` with `FOR UPDATE SKIP LOCKED` in its subselect. There is nothing
 * else here on purpose: every line of "check whether it is free, then take it"
 * a route adds is a window two pollers can both fit through.
 *
 * **An empty queue is a 200, not a 404.** A poller hitting this every ten
 * seconds all afternoon is the normal case, and an endpoint that answers "error"
 * to "nothing to do" trains its callers to ignore errors. `{ claimed: false }`
 * with a reason is the answer.
 *
 * There is no `evaluatorId` in the body and there is nowhere to put one. Who is
 * claiming comes from the session — see docs/PLATFORM.md §1. The specification
 * this replaces took the tutor's id as a parameter, which lets any signed-in
 * user park the entire queue under somebody else's name.
 *
 * Note the trailing slash on the path. `next.config.ts` sets
 * `trailingSlash: true`, so `POST /api/tickets/claim` 308s and a client that
 * does not re-send the body on a redirect arrives here with nothing.
 */
import { ApiError, route } from "@/lib/api";
import {
  claimNextTicket,
  evaluatorContext,
  ineligibleReason,
  INELIGIBLE_MESSAGE,
  type IneligibleReason,
} from "@/lib/queue";

export const POST = route({ auth: "EVALUATOR" }, async ({ user }) => {
  const ctx = await evaluatorContext(user);

  const refused = ineligibleReason(ctx);
  if (refused) {
    // Not an error: an off-shift tutor pressing the button is a UI state, not a
    // fault. `AT_CONCURRENCY_LIMIT` in particular is the system working.
    return {
      claimed: false,
      ticket: null,
      reason: refused,
      message: INELIGIBLE_MESSAGE[refused],
      openTickets: ctx.openTickets,
      maxConcurrent: ctx.profile.maxConcurrent,
    };
  }

  const { ticket, refused: refusedByClaim } = await claimNextTicket({
    evaluatorId: user.id,
    qualifications: ctx.qualifications,
    maxConcurrent: ctx.profile.maxConcurrent,
  });

  if (!ticket) {
    // `refusedByClaim` is set only when the atomic re-check inside the
    // transaction disagreed with the read above — the evaluator's other tab
    // claimed something in between. That is exactly the race the advisory lock
    // exists to resolve, and resolving it means telling this tab the truth.
    const reason: IneligibleReason | null = refusedByClaim;
    return {
      claimed: false,
      ticket: null,
      reason,
      message: reason ? INELIGIBLE_MESSAGE[reason] : "Nothing is waiting for you right now.",
      openTickets: ctx.openTickets,
      maxConcurrent: ctx.profile.maxConcurrent,
    };
  }

  if (!ticket.leaseExpiresAt) {
    // Cannot happen — the statement sets it — but a lease-less claim would be a
    // ticket the sweeper never reclaims, so it is worth refusing to believe in.
    throw new ApiError("INTERNAL", "Claimed ticket has no lease.");
  }

  return {
    claimed: true,
    ticket,
    reason: null,
    message: null,
    openTickets: ctx.openTickets + 1,
    maxConcurrent: ctx.profile.maxConcurrent,
  };
});
