/**
 * POST /api/tickets/{ticketId}/release/ — give it back.
 *
 * The deliberate version of what the sweeper does by timeout: "this scan is
 * unreadable", "this is not my subject after all", "my shift ends in two
 * minutes". Handing a ticket back before the lease runs out is the behaviour
 * worth encouraging, because it puts the script in front of the next evaluator
 * fifteen minutes sooner than walking away does.
 *
 * `claimCount` is not decremented — see `sweepExpiredLeases`. A ticket released
 * four times is a signal about the ticket, and erasing it hides the scan that
 * needs re-photographing behind four tutors who each look unreliable once.
 */
import { ApiError, route, v } from "@/lib/api";
import { releaseTicket } from "@/lib/queue";

export const POST = route(
  {
    auth: "EVALUATOR",
    body: v.object({
      /** Free text for the triage queue: why this went back. */
      reason: v.optional(v.string({ max: 300 })),
    }),
  },
  async ({ user, params }) => {
    const ticketId = String(params.ticketId);
    const released = await releaseTicket(ticketId, user.id);
    if (!released) {
      throw new ApiError(
        "CONFLICT",
        "You are not holding this ticket, so there is nothing to release.",
      );
    }
    return { ticketId, released: true };
  },
);
