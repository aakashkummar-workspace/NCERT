"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Up to ninety seconds of spoken feedback, on **one question**.
 *
 * Not on the script. `VoiceNote.answerId` is a foreign key to `Answer` for the
 * same reason the marks are: a single recording hanging off the whole paper
 * cannot be played beside question 27, which is exactly where a student needs
 * to hear "you had the formula, you just never substituted into it".
 *
 * ## The cap is enforced three times, deliberately
 *
 * The recorder stops itself at 90 s; the upload route rejects a longer
 * `durationMs`; and `voice_note_max_90s` is a CHECK constraint in the database.
 * The first is a courtesy, the second is the API contract, and the third is the
 * one that is actually true — a client can be modified and a route can be
 * called directly.
 *
 * ## Transcription says what it is
 *
 * The transcript appears beneath the note when there is one. When no
 * transcription provider is configured the component says so in plain words and
 * shows nothing where a transcript would be. It never renders a placeholder
 * that reads like text the evaluator spoke: a fabricated transcript under
 * somebody's name, attached to a mark they awarded, is worse than no transcript
 * at all.
 */

export type TranscriptStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

export interface VoiceNote {
  id: string;
  answerId: string;
  durationMs: number;
  mimeType: string;
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  createdAt: string;
  url: string;
}

export const MAX_DURATION_MS = 90_000;

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The first container the browser will actually give us. Safari differs. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of ["audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

export default function VoiceNoteRecorder({
  reviewId,
  answerId,
  questionNumber,
  notes,
  transcriptionAvailable,
  transcriptionMessage,
  disabled,
  onUploaded,
}: {
  reviewId: string;
  answerId: string;
  questionNumber: number;
  notes: VoiceNote[];
  transcriptionAvailable: boolean;
  transcriptionMessage: string | null;
  disabled: boolean;
  onUploaded: (note: VoiceNote) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTicking = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  useEffect(() => stopTicking, [stopTicking]);

  const upload = useCallback(
    async (blob: Blob, durationMs: number) => {
      setUploading(true);
      setError(null);
      try {
        const form = new FormData();
        form.set("answerId", answerId);
        // Clamped rather than trusted-and-rejected: a recorder that overshoots
        // the timer by 40 ms should not lose the evaluator's ninety seconds.
        form.set("durationMs", String(Math.min(MAX_DURATION_MS, Math.max(1, Math.round(durationMs)))));
        form.set("audio", blob, "note.webm");

        // Trailing slash. `trailingSlash: true` means the un-slashed path 308s,
        // and a 308 on a POST arrives with no body.
        const res = await fetch(`/api/reviews/${reviewId}/voice-notes/`, {
          method: "POST",
          body: form,
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message ?? "Upload failed.");
        onUploaded(json.voiceNote as VoiceNote);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [answerId, onUploaded, reviewId],
  );

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot record audio. Type your feedback instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was refused. Allow it in your browser, then try again.");
      return;
    }

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    chunksRef.current = [];
    startedAtRef.current = Date.now();

    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopTicking();
      setRecording(false);
      for (const track of stream.getTracks()) track.stop();
      const durationMs = Date.now() - startedAtRef.current;
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      if (blob.size > 0) void upload(blob, durationMs);
    };

    recorder.start();
    setRecording(true);
    setElapsedMs(0);
    tickRef.current = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsedMs(ms);
      // The recorder stops itself. The route and the database both check again.
      if (ms >= MAX_DURATION_MS) recorder.stop();
    }, 100);
  }, [stopTicking, upload]);

  const mine = notes.filter((n) => n.answerId === answerId);
  const remaining = Math.max(0, MAX_DURATION_MS - elapsedMs);

  return (
    <section className="border-t border-border px-4 py-3" aria-label="Voice feedback">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Voice note on Q{questionNumber}</h3>
        <span className="text-xs tabular-nums text-ink-faint">
          {recording ? `${clock(remaining)} left` : "up to 1:30"}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || uploading}
          onClick={recording ? stop : start}
          className={`min-h-11 flex-1 rounded-md border px-3 text-sm font-medium disabled:opacity-40 ${
            recording
              ? "border-rose-500/50 bg-rose-500/15 text-rose-800 dark:text-rose-300"
              : "border-border bg-surface text-ink"
          }`}
        >
          {uploading ? "Uploading…" : recording ? "Stop and save" : "Record"}
        </button>
      </div>

      {recording && (
        <div className="mt-2 h-1 overflow-hidden rounded bg-surface-alt" aria-hidden>
          <div
            className="h-full bg-accent transition-[width] duration-100"
            style={{ width: `${(elapsedMs / MAX_DURATION_MS) * 100}%` }}
          />
        </div>
      )}

      {error && <p className="mt-2 text-sm text-rose-700 dark:text-rose-300">{error}</p>}

      {!transcriptionAvailable && (
        <p className="mt-2 rounded border border-border bg-surface-alt px-2 py-1.5 text-xs text-ink-soft">
          {transcriptionMessage ??
            "No transcription provider is configured, so these notes will not be transcribed. The audio plays as recorded."}
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {mine.map((note) => (
          <li key={note.id} className="rounded-md border border-border bg-surface p-2">
            <div className="flex items-center justify-between gap-2">
              <audio controls preload="none" src={note.url} className="min-w-0 flex-1" />
              <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                {clock(note.durationMs)}
              </span>
            </div>
            <Transcript note={note} available={transcriptionAvailable} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The transcript, or an honest sentence about why there is not one. Every
 * branch here is a real state of the row; none of them invents text.
 */
function Transcript({ note, available }: { note: VoiceNote; available: boolean }) {
  if (note.transcript) {
    return <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">{note.transcript}</p>;
  }
  if (!available) {
    return (
      <p className="mt-1.5 text-xs text-ink-faint">Not transcribed — no provider is configured.</p>
    );
  }
  if (note.transcriptStatus === "PENDING" || note.transcriptStatus === "RUNNING") {
    return <p className="mt-1.5 text-xs text-ink-faint">Transcribing…</p>;
  }
  return (
    <p className="mt-1.5 text-xs text-ink-faint">
      Transcription did not complete. The recording is unaffected.
    </p>
  );
}
