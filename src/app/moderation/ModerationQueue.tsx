"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/components/DoubtComposer";
// Type-only: src/lib/moderation.ts imports the Prisma client and is erased here.
import type { AuditEntry, QueueItem, ResolvedAuthor } from "@/lib/moderation";

/**
 * The moderator queue.
 *
 * ## What a moderator sees before they ask, and what they must ask for
 *
 * The list shows the post, the reports on it, and the *pseudonym* — never the
 * name. Identity is one button away and that button writes a record: who asked,
 * about which post, when, and the reason they typed. A queue that printed real
 * names would have resolved every child's identity to every moderator who ever
 * scrolled past, and there is no audit trail that can be assembled out of
 * glances.
 *
 * The gate here is cosmetic; the real one is `requireUser("ADMIN")` on every
 * route this calls, re-read from the database per request. A student who types
 * this URL gets an empty screen and a 403 from the API behind it.
 */

const VERBS = [
  { verb: "hide", label: "Hide", hint: "Off the class list while you decide. Reversible." },
  { verb: "remove", label: "Remove", hint: "Gone for good. The record stays." },
  { verb: "restore", label: "Restore", hint: "Put it back — the report was wrong." },
  { verb: "dismiss", label: "Dismiss reports", hint: "Nothing wrong with the post." },
] as const;

function Card({ item, onDone }: { item: QueueItem; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [author, setAuthor] = useState<ResolvedAuthor | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealReason, setRevealReason] = useState("");

  const safety = item.reports.some((r) => r.reason === "SAFETY");

  async function act(verb: (typeof VERBS)[number]["verb"]) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/moderation/${item.postId}/`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ verb, note }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through.");
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const body = await apiFetch<{ author: ResolvedAuthor }>(
        `/api/moderation/${item.postId}/author/`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ reason: revealReason }),
        },
      );
      setAuthor(body.author);
      setRevealing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve that author.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={`rounded-xl border bg-surface p-4 ${
        safety ? "border-accent" : "border-border"
      }`}
    >
      {safety && (
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent">
          Someone may be in danger — read this one first
        </p>
      )}

      <p className="text-xs text-ink-faint">
        {item.subject} · Class {item.classNum} · {item.kind} · {item.visibility.toLowerCase()}
      </p>
      <p className="mt-1 text-xs">
        <span className="font-semibold text-ink-soft">{item.authorLabel}</span>
        {item.authorShadow && <span className="text-ink-faint"> · shadow</span>}
      </p>
      <p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-alt p-2 text-sm leading-relaxed">
        {item.text}
      </p>

      <ul className="mt-3 space-y-1">
        {item.reports.map((r) => (
          <li key={r.id} className="text-xs text-ink-soft">
            <span className="font-semibold">{r.reasonLabel}</span>
            {r.detail && <span className="text-ink-faint"> — {r.detail}</span>}
            {r.handledAt && <span className="text-ink-faint"> (already handled)</span>}
          </li>
        ))}
      </ul>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 500))}
        rows={2}
        placeholder="What you decided, and why (goes in the record)"
        className="mt-3 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs"
      />

      <div className="mt-2 flex flex-wrap gap-2">
        {VERBS.map((v) => (
          <button
            key={v.verb}
            type="button"
            title={v.hint}
            disabled={busy}
            onClick={() => act(v.verb)}
            className="min-h-11 rounded-lg border border-border px-3 text-xs font-semibold text-ink-soft disabled:opacity-40"
          >
            {v.label}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={async () => setAudit(
            (await apiFetch<{ audit: AuditEntry[] }>(`/api/moderation/${item.postId}/`)).audit,
          )}
          className="min-h-11 text-xs font-semibold text-ink-faint"
        >
          History
        </button>
      </div>

      {/* Resolving a minor's identity. Deliberately awkward: a reason has to be
          typed, and typing it writes the record before the name is read. */}
      <div className="mt-3 border-t border-border pt-3">
        {author ? (
          <p className="text-xs">
            <span className="font-semibold">{author.displayName ?? "Unnamed"}</span>
            <span className="text-ink-faint">
              {" "}
              · {author.role.toLowerCase()}
              {author.classNum ? ` · Class ${author.classNum}` : ""}
              {author.pseudonym ? ` · posts here as ${author.pseudonym}` : ""}
            </span>
            <span className="mt-1 block text-ink-faint">
              Recorded against your name at {new Date(author.revealedAt).toLocaleString()}.
            </span>
          </p>
        ) : revealing ? (
          <div>
            <label className="block text-xs font-semibold">
              Why do you need to identify this student?
              <input
                value={revealReason}
                onChange={(e) => setRevealReason(e.target.value.slice(0, 500))}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs font-normal"
              />
            </label>
            <div className="mt-2 flex gap-4">
              <button
                type="button"
                disabled={busy || revealReason.trim().length < 4}
                onClick={reveal}
                className="min-h-11 text-xs font-semibold text-accent disabled:opacity-40"
              >
                Resolve author
              </button>
              <button
                type="button"
                onClick={() => setRevealing(false)}
                className="min-h-11 text-xs text-ink-faint"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRevealing(true)}
            className="min-h-11 text-xs font-semibold text-ink-faint hover:text-ink-soft"
          >
            Resolve author — this is recorded
          </button>
        )}
      </div>

      {audit && (
        <ul className="mt-3 space-y-1 border-t border-border pt-3">
          {audit.length === 0 && <li className="text-xs text-ink-faint">Nothing yet.</li>}
          {audit.map((a) => (
            <li key={a.id} className="text-xs text-ink-faint">
              <span className="font-semibold text-ink-soft">{a.verb}</span> by{" "}
              {a.moderatorName ?? a.moderatorId} · {new Date(a.at).toLocaleString()}
              {a.note && ` — ${a.note}`}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-xs font-medium text-accent">{error}</p>}
    </article>
  );
}

export default function ModerationQueue() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    return apiFetch<{ items: QueueItem[] }>("/api/moderation/queue/")
      .then((body) => {
        setItems(body.items);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not load the queue.");
        setItems([]);
      });
  }, []);

  useEffect(() => {
    let live = true;
    apiFetch<{ items: QueueItem[] }>("/api/moderation/queue/")
      .then((body) => {
        if (live) setItems(body.items);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "Could not load the queue.");
        setItems([]);
      });
    return () => {
      live = false;
    };
  }, []);

  if (error) return <p className="text-sm text-ink-faint">{error}</p>;
  if (items === null) return <p className="text-sm text-ink-faint">Loading…</p>;
  if (items.length === 0) return <p className="text-sm text-ink-faint">Nothing reported.</p>;

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Card key={item.postId} item={item} onDone={load} />
      ))}
    </div>
  );
}
