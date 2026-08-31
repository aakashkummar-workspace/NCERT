/**
 * POST /api/doubts/<id>/voice/  — attach a recording to your own post.
 *
 * `multipart/form-data`, so this route parses its own body: `route()`'s `body`
 * validator is JSON-only, and declaring one here would consume the stream
 * before the file came off it. Everything the form claims is still checked —
 * `attachVoiceNote` re-derives the content type from an allowlist and
 * `storage.put()` measures the bytes rather than believing `Content-Length`.
 *
 * ## What this is not
 *
 * It is not a voice room. There is no live audio anywhere in this lane and
 * there will not be one here: a recording is written, stored, and played back
 * later by the people entitled to it. Children are not put on a live microphone
 * with each other on the strength of a moderation queue that reads things
 * hours afterwards.
 *
 * Playback goes through `/api/dev/storage/`, which re-checks the session
 * against the object's owner. Its rule — the student themselves, or an admin in
 * the same scope — means a voice note attached to a doubt is heard by its
 * author and by a moderator, and not by the student's classmates. That falls
 * out of the existing authorisation rather than being added here, and it is the
 * behaviour this lane wants.
 */
import { ApiError, route } from "@/lib/api";
import { attachVoiceNote, MAX_VOICE_MS } from "@/lib/doubts";
import { STORAGE_POLICY } from "@/lib/storage";

export const POST = route({ auth: "STUDENT" }, async ({ req, user, params }) => {
  const id = params.id;
  if (typeof id !== "string") throw ApiError.notFound("Doubt");

  // A cheap first gate so a 40 MB upload on a metered connection is refused at
  // the header rather than after it has all arrived. The real limit is measured
  // from the buffer in storage.put(); this only saves the bytes.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > STORAGE_POLICY.audio.maxBytes * 1.1) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `That recording is too long to send. The limit is ${MAX_VOICE_MS / 1000} seconds.`,
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw ApiError.validation([{ path: "", message: "expected a multipart form upload" }]);
  }

  const file = form.get("audio");
  if (!(file instanceof File)) {
    throw ApiError.validation([{ path: "audio", message: "is required" }]);
  }
  const durationMs = Number(form.get("durationMs"));
  if (!Number.isFinite(durationMs)) {
    throw ApiError.validation([{ path: "durationMs", message: "must be a number" }]);
  }

  const voiceNote = await attachVoiceNote({
    author: user,
    postId: id,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    durationMs: Math.round(durationMs),
  });
  return { voiceNote };
});
