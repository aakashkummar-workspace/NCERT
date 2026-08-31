/**
 * POST /api/reviews/{reviewId}/voice-notes/ — up to 90 seconds, per question.
 *
 * The foreign key is to `Answer`, not to the ticket. The PRD promises a voice
 * note *per question*, and one recording hanging off the whole script cannot be
 * played beside question 27 — which is where a student needs to hear "you had
 * the formula, you just never substituted into it".
 *
 * `multipart/form-data`, so this route reads `req.formData()` itself rather
 * than declaring a `body` validator: `route()`'s validator path calls
 * `req.json()`, which is the wrong reader for a file.
 *
 * ## What is pinned here and cannot be sent
 *
 * The evaluator is the session's user. The `storageKey` is built from
 * `storageKeys.voiceNote`. The byte count and the SHA-256 are measured by
 * `storage.put` from the buffer, never read from `Content-Length` — a client
 * that lies about its length lies for a reason. The content type is checked
 * against the audio allowlist, because a file claiming `audio/webm` that is
 * actually HTML is a stored-XSS delivery mechanism the moment something serves
 * it back with that type.
 *
 * `durationMs` is the one number the client genuinely knows and the server
 * cannot cheaply derive — decoding Opus server-side to count frames is not
 * worth a dependency here — so it is validated at the edge (1–90 000 ms) and
 * the `voice_note_max_90s` CHECK constraint is the backstop. A client that lies
 * about duration gets a truthful cap either way, because the audio is what it
 * is; the number only drives the progress bar.
 *
 * ## Transcription degrades honestly
 *
 * There is no transcription provider in this repo. When none is configured the
 * row is written `transcriptStatus: FAILED` with `transcript` left NULL, and
 * the response says why in words. It is emphatically **not** left `PENDING`,
 * which claims a worker is coming, and it is emphatically not filled with
 * anything generated: a fabricated transcript under an evaluator's name is a
 * sentence they did not say attached to a mark they did award.
 */
import { NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api";
import prisma from "@/lib/db";
import { heldTicket } from "@/lib/queue";
import { NO_TRANSCRIPTION_MESSAGE, transcriptionProvider } from "@/lib/review";
import storage, { extensionFor, storageKeys } from "@/lib/storage";

/** The CHECK constraint, restated so the failure is a 400 and not a bare 500. */
const MAX_DURATION_MS = 90_000;

export const POST = route({ auth: "EVALUATOR" }, async ({ user, req, params }) => {
  const reviewId = String(params.reviewId);

  const review = await prisma.evaluatorReview.findFirst({
    where: { id: reviewId, evaluatorId: user.id },
    select: { id: true, ticketId: true, submittedAt: true },
  });
  if (!review) throw ApiError.notFound("Review");
  if (review.submittedAt) {
    throw new ApiError("CONFLICT", "This review has already been submitted.");
  }
  const ticket = await heldTicket(review.ticketId, user);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Send this as multipart/form-data with an `audio` file part.",
    );
  }

  const answerId = String(form.get("answerId") ?? "");
  const durationMs = Number(form.get("durationMs"));
  const file = form.get("audio");

  const issues = [];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(answerId)) {
    issues.push({ path: "answerId", message: "must be a UUID" });
  }
  if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
    issues.push({
      path: "durationMs",
      message: `must be a whole number of milliseconds between 1 and ${MAX_DURATION_MS} — a voice note is capped at 90 seconds`,
    });
  }
  if (!(file instanceof File)) {
    issues.push({ path: "audio", message: "is required and must be a file part" });
  }
  if (issues.length) throw ApiError.validation(issues);

  const audio = file as File;

  // The answer must belong to this ticket's submission. A held ticket is not a
  // licence to attach a recording to any answer in the database.
  const answer = await prisma.answer.findFirst({
    where: { id: answerId, submissionId: ticket.submissionId },
    select: { id: true },
  });
  if (!answer) throw ApiError.notFound("Answer");

  const contentType = audio.type || "audio/webm";
  const voiceNoteId = crypto.randomUUID();

  const object = await storage.put({
    key: storageKeys.voiceNote(answer.id, voiceNoteId, extensionFor(contentType)),
    body: Buffer.from(await audio.arrayBuffer()),
    contentType,
    storageClass: "audio",
  });

  const provider = transcriptionProvider();

  const note = await prisma.voiceNote.create({
    data: {
      id: voiceNoteId,
      answerId: answer.id,
      reviewId: review.id,
      evaluatorId: user.id,
      storageKey: object.key,
      mimeType: object.contentType,
      bytes: object.bytes,
      durationMs,
      // PENDING means a worker will pick this up. It only means that when one
      // exists. See the module comment.
      transcriptStatus: provider ? "PENDING" : "FAILED",
    },
  });

  return NextResponse.json(
    {
      voiceNote: {
        id: note.id,
        answerId: note.answerId,
        durationMs: note.durationMs,
        mimeType: note.mimeType,
        bytes: note.bytes,
        transcriptStatus: note.transcriptStatus,
        transcript: note.transcript,
        createdAt: note.createdAt.toISOString(),
        url: await storage.getSignedUrl(note.storageKey),
      },
      transcription: {
        provider,
        available: provider !== null,
        message: provider
          ? "Queued for transcription. The transcript appears beneath the note when it is ready."
          : NO_TRANSCRIPTION_MESSAGE,
      },
    },
    { status: 201 },
  );
});

/** GET — the notes on this review, newest last, with fresh playback URLs. */
export const GET = route({ auth: "EVALUATOR" }, async ({ user, params }) => {
  const reviewId = String(params.reviewId);
  const review = await prisma.evaluatorReview.findFirst({
    where: { id: reviewId, evaluatorId: user.id },
    select: { id: true },
  });
  if (!review) throw ApiError.notFound("Review");

  const notes = await prisma.voiceNote.findMany({
    where: { reviewId: review.id },
    orderBy: { createdAt: "asc" },
  });

  const provider = transcriptionProvider();
  return {
    voiceNotes: await Promise.all(
      notes.map(async (n) => ({
        id: n.id,
        answerId: n.answerId,
        durationMs: n.durationMs,
        mimeType: n.mimeType,
        transcript: n.transcript,
        transcriptLang: n.transcriptLang,
        transcriptStatus: n.transcriptStatus,
        createdAt: n.createdAt.toISOString(),
        url: await storage.getSignedUrl(n.storageKey),
      })),
    ),
    transcription: {
      provider,
      available: provider !== null,
      message: provider ? null : NO_TRANSCRIPTION_MESSAGE,
    },
  };
});
