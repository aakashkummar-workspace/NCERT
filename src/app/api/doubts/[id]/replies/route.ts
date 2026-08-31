/**
 * POST /api/doubts/<id>/replies/  — answer someone's doubt.
 *
 * A thread holds five people at most (src/lib/doubts.ts,
 * `MAX_THREAD_PARTICIPANTS`). The sixth gets a 409 that tells them to ask their
 * own question rather than a silent failure — a small room is the feature, not
 * a capacity limit, and the message says so.
 */
import { route, v, ApiError } from "@/lib/api";
import { postReply, MAX_REPLY_CHARS } from "@/lib/doubts";

export const POST = route(
  {
    auth: "STUDENT",
    idempotent: true,
    body: v.object({
      text: v.string({ min: 1, max: MAX_REPLY_CHARS }),
      shadow: v.withDefault(v.boolean(), false),
    }),
  },
  async ({ user, body, params, idempotencyKey }) => {
    const id = params.id;
    if (typeof id !== "string") throw ApiError.notFound("Doubt");
    const reply = await postReply({
      author: user,
      doubtId: id,
      text: body.text,
      shadow: body.shadow,
      idempotencyKey,
    });
    return { reply };
  },
);
