"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import DoubtComposer, { apiFetch } from "./DoubtComposer";
// Type-only, both of them. src/lib/moderation.ts and src/lib/doubts.ts import
// the Prisma client; `import type` is erased, so neither reaches the browser.
import type { ReportReason } from "@/lib/moderation";
import type { DoubtListItem, PostView, ThreadView } from "@/lib/doubts";

/**
 * The reasons, as words a student reads, in the order they should read them.
 *
 * Declared here rather than imported because the server module cannot be
 * bundled. The pair below keeps the two honest in both directions: `satisfies`
 * rejects a reason this list invents, and the exhaustive `Record` fails to
 * compile the moment the server adds one that has no wording yet.
 */
const REPORT_REASONS = [
  "SAFETY",
  "BULLYING",
  "PERSONAL_INFO",
  "SPAM",
  "OFF_TOPIC",
  "OTHER",
] as const satisfies readonly ReportReason[];

const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  SAFETY: "Someone may be in danger",
  BULLYING: "Bullying or abuse",
  PERSONAL_INFO: "Shares someone's personal details",
  SPAM: "Spam or advertising",
  OFF_TOPIC: "Not about studying",
  OTHER: "Something else",
};

/**
 * The doubt registry, as a student sees it.
 *
 * Two screens in one component, because they are one thing: a list of open
 * questions, and a thread when you tap into one. The thread id lives in the URL
 * query so the back button works and a link is shareable inside the class.
 *
 * ## Two deliberate absences
 *
 * **There is no ranking of people.** No answer counts beside a name, no badges,
 * no "top helper" strip. The PRD's own problem statement names public
 * leaderboards as the thing that harms these students, and a helper board is a
 * leaderboard with a kinder label — it still sorts fourteen-year-olds and shows
 * them the sort. Questions are ordered by when they were asked, and that is all
 * the ordering there is.
 *
 * **There is no follow, no profile, no message.** A pseudonym is scoped to one
 * thread and there is nothing to click on it, so it cannot become a handle. See
 * src/lib/shadow.ts.
 */

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Voice playback
// ---------------------------------------------------------------------------

/**
 * The object is served with `Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff`, which is what stops a mislabelled upload
 * from being rendered as markup in our origin. That also means an `<audio src>`
 * pointed straight at it is unreliable, so the bytes are fetched and wrapped in
 * a blob URL instead.
 *
 * The fetch can legitimately fail with a 404: `/api/dev/storage/` serves a
 * voice note to its author and to an admin in the same scope, and to nobody
 * else. A classmate therefore sees that a recording exists and cannot play it —
 * which is the intended shape of this feature, not a bug. Recordings by
 * children are heard by a moderator, not passed between children.
 */
function VoicePlayer({ note }: { note: NonNullable<PostView["voiceNote"]> }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "blocked">("idle");
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function load() {
    setState("loading");
    try {
      const res = await fetch(note.url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      setUrl(URL.createObjectURL(blob));
      setState("ready");
    } catch {
      setState("blocked");
    }
  }

  if (state === "ready" && url) {
    return <audio src={url} controls autoPlay className="mt-2 h-9 w-full max-w-xs" />;
  }
  if (state === "blocked") {
    return (
      <p className="mt-2 text-xs text-ink-faint">
        Voice note, {Math.ceil(note.durationMs / 1000)}s — only the person who recorded it and a
        moderator can play it.
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={load}
      disabled={state === "loading"}
      className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold text-ink-soft"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M8 5v14l11-7L8 5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
      {state === "loading" ? "Loading…" : `Voice note · ${Math.ceil(note.durationMs / 1000)}s`}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Attribution and reporting
// ---------------------------------------------------------------------------

function Byline({ author, at }: { author: PostView["author"]; at: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
      <span className="font-semibold text-ink-soft">{author.isYou ? "You" : author.label}</span>
      {author.shadow && (
        <span
          className="rounded-full bg-surface-alt px-1.5 py-0.5 text-[10px] font-medium"
          /* Named plainly. A reader should know that the name they are looking
             at is a nickname, and the person behind it should know it shows. */
          title="Posted in Shadow Mode — a nickname for this thread only"
        >
          shadow
        </span>
      )}
      <span>{ago(at)}</span>
    </p>
  );
}

function ReportDialog({
  postId,
  onClose,
}: {
  postId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason>("BULLYING");
  const [detail, setDetail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function send() {
    setState("busy");
    try {
      const res = await apiFetch<{ created: boolean }>(`/api/doubts/${postId}/report/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, detail }),
      });
      setMessage(
        res.created
          ? "Sent. A moderator will look at it."
          : "You already reported this one — it is in the queue.",
      );
      setState("done");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not send that.");
      setState("error");
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-border bg-surface-alt p-3">
      {state === "done" ? (
        <div>
          <p className="text-xs text-ink-soft">{message}</p>
          <button type="button" onClick={onClose} className="mt-2 min-h-11 text-xs font-semibold text-accent">
            Close
          </button>
        </div>
      ) : (
        <>
          <p className="text-xs font-semibold">What is wrong with this post?</p>
          <div className="mt-2 space-y-1">
            {REPORT_REASONS.map((r) => (
              <label key={r} className="flex min-h-11 items-center gap-2 text-xs">
                <input
                  type="radio"
                  name={`reason-${postId}`}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                {REPORT_REASON_LABELS[r]}
              </label>
            ))}
          </div>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value.slice(0, 500))}
            rows={2}
            placeholder="Anything else the moderator should know (optional)"
            className="mt-2 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs"
          />
          {state === "error" && <p className="mt-1 text-xs text-accent">{message}</p>}
          <div className="mt-2 flex gap-4">
            <button
              type="button"
              onClick={send}
              disabled={state === "busy"}
              className="min-h-11 text-xs font-semibold text-accent disabled:opacity-40"
            >
              {state === "busy" ? "Sending…" : "Send report"}
            </button>
            <button type="button" onClick={onClose} className="min-h-11 text-xs text-ink-faint">
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PostBody({ post, onDeleted }: { post: PostView; onDeleted?: () => void }) {
  const [reporting, setReporting] = useState(false);

  return (
    <div>
      <Byline author={post.author} at={post.createdAt} />
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{post.text}</p>
      {post.voiceNote && <VoicePlayer note={post.voiceNote} />}

      <div className="mt-2 flex flex-wrap gap-4">
        {/* On every post, always. Not behind a menu, not behind a long press. */}
        {!post.author.isYou && (
          <button
            type="button"
            onClick={() => setReporting((r) => !r)}
            className="min-h-11 text-xs text-ink-faint hover:text-ink-soft"
          >
            Report
          </button>
        )}
        {post.author.isYou && onDeleted && (
          <button
            type="button"
            onClick={async () => {
              await apiFetch(`/api/doubts/${post.id}/`, { method: "DELETE" });
              onDeleted();
            }}
            className="min-h-11 text-xs text-ink-faint hover:text-ink-soft"
          >
            Delete
          </button>
        )}
      </div>

      {reporting && <ReportDialog postId={post.id} onClose={() => setReporting(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

function Thread({ doubtId, onBack }: { doubtId: string; onBack: () => void }) {
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    return apiFetch<ThreadView>(`/api/doubts/${doubtId}/`)
      .then((t) => {
        setThread(t);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not open that.");
      });
  }, [doubtId]);

  useEffect(() => {
    // The `live` flag is the pattern the rest of the app uses (see
    // RevisionQueue): a reply posted and then navigated away from must not
    // write into an unmounted thread.
    let live = true;
    apiFetch<ThreadView>(`/api/doubts/${doubtId}/`)
      .then((t) => {
        if (live) setThread(t);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : "Could not open that.");
      });
    return () => {
      live = false;
    };
  }, [doubtId]);

  if (error) return <p className="text-sm text-ink-faint">{error}</p>;
  if (!thread) return <p className="text-sm text-ink-faint">Loading…</p>;

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="min-h-11 text-xs font-semibold text-accent">
        ← All questions
      </button>

      <article className="rounded-xl border border-border bg-surface p-4">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {thread.doubt.subject}
        </p>
        <PostBody post={thread.doubt} onDeleted={onBack} />
        {thread.doubt.author.isYou && (
          <button
            type="button"
            onClick={async () => {
              await apiFetch(`/api/doubts/${doubtId}/resolve/`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ resolved: !thread.doubt.resolvedAt }),
              });
              void load();
            }}
            className="mt-3 min-h-11 rounded-lg border border-border px-3 text-xs font-semibold text-ink-soft"
          >
            {thread.doubt.resolvedAt ? "Reopen this" : "I understand it now"}
          </button>
        )}
      </article>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {thread.replies.length === 0
            ? "No answers yet"
            : `${thread.replies.length} ${thread.replies.length === 1 ? "answer" : "answers"}`}
        </h2>
        {thread.replies.map((r) => (
          <article key={r.id} className="rounded-xl border border-border bg-surface p-3">
            <PostBody post={r} onDeleted={load} />
          </article>
        ))}
      </section>

      {thread.canReply ? (
        <div className="rounded-xl border border-border bg-surface p-3">
          <DoubtComposer replyTo={doubtId} onPosted={load} />
        </div>
      ) : (
        <p className="text-xs text-ink-faint">
          {thread.doubt.resolvedAt
            ? "This one is closed."
            : `This thread has its ${thread.participantCount} people. Ask your own and someone will pick it up.`}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

type Filter = "all" | "open" | "mine";

function fetchDoubts(filter: Filter): Promise<DoubtListItem[]> {
  const q = new URLSearchParams();
  if (filter === "open") q.set("open", "1");
  if (filter === "mine") q.set("mine", "1");
  return apiFetch<{ doubts: DoubtListItem[] }>(`/api/doubts/?${q}`).then((b) => b.doubts);
}

/**
 * The open thread, read out of the URL.
 *
 * `pushState` does not fire `popstate`, so `openThread` dispatches an event of
 * its own; the browser's back and forward buttons fire the real one. Both are
 * subscribed, which is what makes Back leave a thread instead of leaving the
 * page.
 */
const LOCATION_EVENT = "ncert:doubts-navigate";

function subscribeToLocation(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(LOCATION_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(LOCATION_EVENT, onChange);
  };
}

function readThreadParam(): string | null {
  return new URLSearchParams(window.location.search).get("thread");
}

function openThread(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("thread", id);
  else url.searchParams.delete("thread");
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(LOCATION_EVENT));
}

export default function DoubtList() {
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<DoubtListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // The open thread lives in the URL, not in state. That makes the browser's
  // own back button work, makes a thread linkable inside the class, and — the
  // reason it is written this way rather than mirrored into state — means there
  // is one answer to "which thread is open" instead of two that can disagree.
  const thread = useSyncExternalStore(subscribeToLocation, readThreadParam, () => null);

  // No manual refresh: the effect below keys on `thread` and `filter`, so
  // closing a thread or changing the filter reloads on its own. Posting a
  // question opens its thread, which is the same transition.
  useEffect(() => {
    if (thread) return;
    let live = true;
    fetchDoubts(filter)
      .then((doubts) => {
        if (live) {
          setItems(doubts);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "Could not load questions.");
        setItems([]);
      });
    return () => {
      live = false;
    };
  }, [thread, filter]);

  if (thread) return <Thread doubtId={thread} onBack={() => openThread(null)} />;

  return (
    <div className="space-y-4">
      {asking ? (
        <section className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Ask a question</h2>
            <button
              type="button"
              onClick={() => setAsking(false)}
              className="min-h-11 text-xs text-ink-faint"
            >
              Cancel
            </button>
          </div>
          <DoubtComposer
            autoFocus
            onPosted={(post) => {
              setAsking(false);
              openThread(post.id);
            }}
          />
        </section>
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="min-h-11 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink"
        >
          Ask a question
        </button>
      )}

      <div className="flex gap-2">
        {(["all", "open", "mine"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`min-h-11 rounded-lg border px-3 text-xs font-semibold ${
              filter === f
                ? "border-accent bg-accent-soft text-accent"
                : "border-border text-ink-faint"
            }`}
          >
            {f === "all" ? "All" : f === "open" ? "Unanswered" : "Mine"}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-ink-faint">{error}</p>}
      {items === null && <p className="text-sm text-ink-faint">Loading…</p>}
      {items?.length === 0 && !error && (
        <p className="text-sm text-ink-faint">
          {filter === "mine" ? "You have not asked anything yet." : "Nothing here yet. Ask the first one."}
        </p>
      )}

      <ul className="space-y-2">
        {items?.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => openThread(d.id)}
              className="w-full rounded-xl border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-alt"
            >
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  {d.subject}
                </span>
                {d.resolvedAt && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">
                    answered
                  </span>
                )}
              </div>
              <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed">{d.text}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
                <span>{d.author.isYou ? "You" : d.author.label}</span>
                {d.author.shadow && <span>· shadow</span>}
                <span>· {ago(d.createdAt)}</span>
                <span>
                  · {d.replyCount} {d.replyCount === 1 ? "answer" : "answers"}
                </span>
                {d.voiceNote && <span>· voice</span>}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
