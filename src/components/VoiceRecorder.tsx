"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Hold-to-talk. The point of it is that a student can say "why does the
 * denominator become n minus one" in four seconds instead of typing a formula
 * on a phone keyboard.
 *
 * ## Three things this gets right on purpose
 *
 * **A refused microphone is not a dead end.** Permission denial is the normal
 * case, not an error: a shared family phone, a school tablet with the mic
 * disabled, a browser that has already been told no. The recorder collapses to
 * one calm line and the composer around it stays exactly as usable as it was.
 * A student who will not or cannot record must never be worse off than one who
 * has no microphone button at all.
 *
 * **The cap is visible before it bites.** 90 seconds, counted down on screen,
 * and the last ten are called out. Recording stops itself at zero and keeps
 * what was said rather than discarding it — a student who hits the limit
 * mid-sentence still has the sentence.
 *
 * **Nothing is live.** This records to a blob, which the composer uploads. No
 * peer connection, no stream, no room. Children are not put on an open
 * microphone with each other on the strength of moderation that reads things
 * afterwards; see the header of src/app/api/doubts/[id]/voice/route.ts.
 */

/** Matches `MAX_VOICE_MS` in src/lib/doubts.ts and the `voice_note_max_90s` CHECK. */
const MAX_MS = 90_000;
const WARN_MS = 10_000;

export interface Recording {
  blob: Blob;
  durationMs: number;
  url: string;
}

type Phase = "idle" | "asking" | "recording" | "ready" | "denied";

/**
 * Whether this browser can record at all — a capability of the platform, so it
 * is read as an external store rather than discovered in an effect. The server
 * snapshot is `true` so the prerendered HTML carries the button and a phone
 * that can record never has to wait a frame for it; a browser that cannot
 * corrects itself on the first client render.
 */
const noSubscription = () => () => {};

function useRecordingSupported(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(pickMimeType()),
    () => true,
  );
}

/** Prefer Opus; a phone that cannot make one gets whatever it can. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

function seconds(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`;
}

export default function VoiceRecorder({
  recording,
  onChange,
  disabled = false,
}: {
  recording: Recording | null;
  onChange: (r: Recording | null) => void;
  disabled?: boolean;
}) {
  const supported = useRecordingSupported();
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  /**
   * The `live` guard, in ref form because the things that outlive this
   * component here are a permission prompt and a `MediaRecorder.onstop`, not a
   * fetch. A student who taps back while the browser is still asking about the
   * microphone must not have a recorder built on top of a stream nobody is
   * going to stop.
   */
  const liveRef = useRef(true);

  const teardown = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    // Release the microphone the moment the recording stops. A tab that holds
    // it keeps the browser's "recording" indicator lit, which reads to a
    // student as being listened to.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      // Stops the interval and, more importantly, stops every track on the
      // stream. A tab that keeps a microphone open keeps the browser's
      // recording indicator lit, which to a student looks like being listened
      // to after they left the page.
      teardown();
    };
  }, [teardown]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  async function start() {
    if (disabled || !supported || phase === "recording") return;

    // Drop any earlier take first: one note per post, and the old object URL
    // would otherwise leak for the life of the page.
    if (recording) {
      URL.revokeObjectURL(recording.url);
      onChange(null);
    }

    setPhase("asking");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denied, dismissed, revoked mid-session, or no microphone at all. All
      // the same to the student, and all recoverable by typing — the composer
      // around this is untouched, and the "denied" branch below says so in one
      // line rather than leaving a button that silently does nothing.
      if (liveRef.current) setPhase("denied");
      return;
    }

    if (!liveRef.current) {
      // Unmounted while the permission prompt was open. Hand the microphone
      // back rather than building a recorder nothing will ever stop.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const mimeType = pickMimeType();
    streamRef.current = stream;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const durationMs = Math.min(Date.now() - startedRef.current, MAX_MS);
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      teardown();
      // `onstop` fires after the component may have gone; the take is dropped
      // rather than written into a composer that is no longer on screen.
      if (!liveRef.current) return;
      if (blob.size === 0 || durationMs < 400) {
        // A tap rather than a hold. Nothing was said; say so instead of
        // uploading 300 ms of room noise.
        setPhase("idle");
        setElapsed(0);
        return;
      }
      onChange({ blob, durationMs, url: URL.createObjectURL(blob) });
      setPhase("ready");
    };

    startedRef.current = Date.now();
    setElapsed(0);
    setPhase("recording");
    recorder.start(250);

    tickRef.current = window.setInterval(() => {
      const ms = Date.now() - startedRef.current;
      setElapsed(ms);
      // Stops itself at the cap and keeps what is already recorded.
      if (ms >= MAX_MS) stop();
    }, 100);
  }

  function discard() {
    if (recording) URL.revokeObjectURL(recording.url);
    onChange(null);
    setElapsed(0);
    setPhase("idle");
  }

  if (!supported) {
    return (
      <p className="text-xs text-ink-faint">
        This browser cannot record audio. Type your question instead.
      </p>
    );
  }

  if (phase === "denied") {
    return (
      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="text-xs leading-relaxed text-ink-soft">
          No microphone access. Type your question instead — it works just as well.
        </p>
        <button
          type="button"
          onClick={() => setPhase("idle")}
          className="mt-2 min-h-11 text-xs font-semibold text-accent"
        >
          Try the microphone again
        </button>
      </div>
    );
  }

  if (phase === "ready" && recording) {
    return (
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center gap-3">
          {/* Played from a blob URL, so nothing leaves the phone until the
              question is posted. */}
          <audio src={recording.url} controls className="h-9 min-w-0 flex-1" />
          <span className="shrink-0 text-xs tabular-nums text-ink-faint">
            {seconds(recording.durationMs)}
          </span>
        </div>
        <div className="mt-2 flex gap-4">
          <button type="button" onClick={start} className="min-h-11 text-xs font-semibold text-accent">
            Record again
          </button>
          <button type="button" onClick={discard} className="min-h-11 text-xs font-semibold text-ink-faint">
            Remove
          </button>
        </div>
      </div>
    );
  }

  const remaining = Math.max(0, MAX_MS - elapsed);
  const recordingNow = phase === "recording";

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <button
        type="button"
        disabled={disabled || phase === "asking"}
        /* Pointer events cover mouse, touch and pen with one pair of handlers.
           `onPointerLeave` matters: a thumb that slides off the button should
           end the recording, not leave it running silently. */
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={recordingNow ? stop : undefined}
        onPointerCancel={stop}
        /* Keyboard: space or enter fires click, which cannot express a hold, so
           it toggles instead. A student on a keyboard gets the same feature. */
        onClick={(e) => {
          if (e.detail !== 0) return;
          if (recordingNow) stop();
          else void start();
        }}
        className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
          recordingNow
            ? "bg-accent text-accent-ink"
            : "border border-border text-ink-soft hover:bg-surface-alt disabled:opacity-50"
        }`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {phase === "asking"
          ? "Waiting for the microphone…"
          : recordingNow
            ? `Listening — let go to stop · ${seconds(remaining)} left`
            : "Hold to record"}
      </button>

      <p
        className={`mt-2 text-xs ${
          recordingNow && remaining <= WARN_MS ? "font-semibold text-accent" : "text-ink-faint"
        }`}
        aria-live="polite"
      >
        {recordingNow && remaining <= WARN_MS
          ? `${seconds(remaining)} left`
          : "Up to 90 seconds. Say the question out loud if it is quicker than typing it."}
      </p>
    </div>
  );
}
