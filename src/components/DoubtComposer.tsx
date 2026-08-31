"use client";

import { useRef, useState } from "react";
import ShadowToggle from "./ShadowToggle";
import VoiceRecorder, { type Recording } from "./VoiceRecorder";
import { readShadowPreference } from "@/lib/shadow";
// Type-only. TypeScript erases these, so the server module — and the Prisma
// client inside it — never reaches the browser bundle.
import type { PostView } from "@/lib/doubts";

/**
 * Ask a question, or answer one.
 *
 * ## The copy rule
 *
 * A student opens this because something did not make sense, and they already
 * feel behind. Nothing here agrees with them about that. There is no "don't
 * worry", no "everyone finds this hard", no reassurance at all — reassurance
 * offered before it is asked for is a way of confirming that there was
 * something to be embarrassed about. The placeholder asks for the question and
 * the button posts it.
 *
 * ## Idempotency
 *
 * The key is generated once and held in a ref for the life of the attempt, so
 * a retry after a dropped connection carries the *same* key and the server
 * collapses it. A key regenerated per click would post the question twice on a
 * 2G connection that is slow rather than broken — docs/PLATFORM.md §5.
 */

export const SUBJECTS = ["Science", "Mathematics", "Social Science", "English", "Hindi"] as const;

export interface ApiFailure {
  code: string;
  message: string;
}

/** Unwraps the error envelope every route in this app shares. */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: "same-origin" });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const envelope = json as { error?: ApiFailure };
    throw new Error(envelope.error?.message ?? "Something went wrong. Try again.");
  }
  return json as T;
}

export default function DoubtComposer({
  /** Omit to post a new doubt; pass a doubt id to reply in its thread. */
  replyTo,
  onPosted,
  autoFocus = false,
}: {
  replyTo?: string;
  onPosted?: (post: PostView) => void;
  autoFocus?: boolean;
}) {
  const [subject, setSubject] = useState<string>(SUBJECTS[0]);
  const [text, setText] = useState("");
  const [shadow, setShadow] = useState<boolean>(() => readShadowPreference());
  const [recording, setRecording] = useState<Recording | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const isReply = Boolean(replyTo);
  const maxChars = isReply ? 1000 : 2000;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || text.trim().length < (isReply ? 1 : 4)) return;
    setBusy(true);
    setError(null);
    keyRef.current ??= crypto.randomUUID();

    try {
      const url = isReply ? `/api/doubts/${replyTo}/replies/` : "/api/doubts/";
      const payload = isReply
        ? { text: text.trim(), shadow }
        : { subject, text: text.trim(), shadow };

      const body = await apiFetch<{ doubt?: PostView; reply?: PostView }>(url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": keyRef.current },
        body: JSON.stringify(payload),
      });
      const post = body.doubt ?? body.reply;
      if (!post) throw new Error("The server did not return the post.");

      if (recording) {
        const form = new FormData();
        // The extension follows the recorded type; the server re-derives the
        // content type from an allowlist regardless of what this says.
        form.append("audio", recording.blob, "note.webm");
        form.append("durationMs", String(recording.durationMs));
        const withNote = await apiFetch<{ voiceNote: PostView["voiceNote"] }>(
          `/api/doubts/${post.id}/voice/`,
          { method: "POST", body: form },
        );
        post.voiceNote = withNote.voiceNote;
        URL.revokeObjectURL(recording.url);
      }

      keyRef.current = null;
      setText("");
      setRecording(null);
      onPosted?.(post);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {!isReply && (
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Subject</span>
          <select
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
          >
            {SUBJECTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="block">
        <span className="sr-only">{isReply ? "Your answer" : "Your question"}</span>
        <textarea
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value.slice(0, maxChars))}
          rows={isReply ? 3 : 5}
          placeholder={
            isReply
              ? "Answer it — or say what you would try first."
              : "What is the question? Name the chapter if you know it."
          }
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed"
        />
        <span className="mt-1 block text-right text-xs tabular-nums text-ink-faint">
          {text.length} / {maxChars}
        </span>
      </label>

      <VoiceRecorder recording={recording} onChange={setRecording} disabled={busy} />

      <ShadowToggle value={shadow} onChange={setShadow} />

      {error && (
        <p role="alert" className="text-xs font-medium text-accent">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || text.trim().length < (isReply ? 1 : 4)}
        className="min-h-11 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-40"
      >
        {busy ? "Posting…" : isReply ? "Post answer" : "Post question"}
      </button>
    </form>
  );
}
