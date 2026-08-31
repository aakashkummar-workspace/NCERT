/**
 * POST /api/doubts/<id>/report/  — flag a post for a moderator.
 *
 * On every doubt and every reply, for every reader, from the first commit this
 * feature exists in. A reporting flow that ships later than the anonymity it
 * moderates is a reporting flow that ships after the first incident.
 *
 * No `Idempotency-Key` header, on purpose: the key is derived server-side from
 * the reporter and the post, because "this person reports this post" is already
 * unique and a client-chosen key would let one student file eleven reports on
 * one post and push it up a queue that sorts by count. src/lib/moderation.ts.
 */
import { ApiError, route, v } from "@/lib/api";
import { MAX_REPORT_CHARS, REPORT_REASONS, reportPost } from "@/lib/moderation";

export const POST = route(
  {
    auth: "STUDENT",
    body: v.object({
      reason: v.enumOf(REPORT_REASONS),
      detail: v.withDefault(v.string({ max: MAX_REPORT_CHARS }), ""),
    }),
  },
  async ({ user, body, params }) => {
    const id = params.id;
    if (typeof id !== "string") throw ApiError.notFound("Doubt");
    const result = await reportPost({
      reporter: user,
      postId: id,
      reason: body.reason,
      detail: body.detail,
    });
    // `created: false` means they had already reported it. The client says
    // "thanks, we already have this" rather than pretending it is new — a
    // student who reports twice deserves to know the first one landed.
    return result;
  },
);
