"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  deleteBook,
  listCached,
  storageEstimate,
  type CachedChapter,
} from "@/lib/offline";
import { formatBytes, getBook, slugify } from "@/lib/manifest";

interface BookGroup {
  code: string;
  title: string;
  subject: string;
  class: number;
  chapters: CachedChapter[];
  bytes: number;
}

/**
 * Read the cache and pair each entry with its book. Kept outside the component
 * so the effect below only sets state from a promise callback.
 */
async function loadGroups(): Promise<{
  groups: BookGroup[];
  estimate: { usage: number; quota: number } | null;
}> {
  const cached = await listCached();
  const byCode = new Map<string, CachedChapter[]>();
  for (const c of cached) {
    const list = byCode.get(c.code) ?? [];
    list.push(c);
    byCode.set(c.code, list);
  }

  const groups: BookGroup[] = [];
  for (const [code, chapters] of byCode) {
    const book = getBook(code);
    if (!book) continue; // cached file from an older manifest; ignore
    groups.push({
      code,
      title: book.title,
      subject: book.subject,
      class: book.class,
      chapters,
      bytes: chapters.reduce((n, c) => n + c.bytes, 0),
    });
  }
  groups.sort((a, b) => a.class - b.class || a.subject.localeCompare(b.subject));

  return { groups, estimate: await storageEstimate() };
}

export default function DownloadsManager() {
  const [groups, setGroups] = useState<BookGroup[] | null>(null);
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  // Bumped after a delete to re-read the cache.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    loadGroups()
      .then((next) => {
        if (!live) return;
        setGroups(next.groups);
        setEstimate(next.estimate);
      })
      .catch(() => {
        if (live) setGroups([]);
      });
    return () => {
      live = false;
    };
  }, [reloadToken]);

  async function onDelete(code: string) {
    await deleteBook(code);
    setReloadToken((t) => t + 1);
  }

  if (groups === null) {
    return <p className="text-sm text-ink-faint">Checking device storage…</p>;
  }

  return (
    <>
      {estimate && (
        <div className="mb-6 rounded-2xl border border-border bg-surface p-4">
          <p className="text-sm">
            <span className="font-medium">{formatBytes(estimate.usage)}</span>
            <span className="text-ink-faint"> used of {formatBytes(estimate.quota)} available</span>
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-alt">
            <div
              className="h-full rounded-full bg-accent"
              style={{
                width: `${estimate.quota ? Math.min(100, (estimate.usage / estimate.quota) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center">
          <p className="text-sm text-ink-soft">No chapters saved yet.</p>
          <p className="mt-1 text-xs text-ink-faint">
            Tap the download icon beside any chapter to keep it for offline reading.
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-accent transition-colors hover:border-accent"
          >
            Browse subjects
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li
              key={g.code}
              className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/class/${g.class}/${slugify(g.subject)}`}
                  className="block truncate font-medium hover:text-accent"
                >
                  {g.title}
                </Link>
                <p className="text-xs text-ink-faint">
                  Class {g.class} · {g.subject} · {g.chapters.length}{" "}
                  {g.chapters.length === 1 ? "chapter" : "chapters"} · {formatBytes(g.bytes)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onDelete(g.code)}
                className="min-h-11 shrink-0 rounded-lg border border-border px-4 text-xs text-ink-soft transition-colors hover:border-accent hover:text-accent"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
