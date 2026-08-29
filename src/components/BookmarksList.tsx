"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { allBookmarks, toggleBookmark, type Bookmark } from "@/lib/reading-state";
import { getBook, getChapter, slugify } from "@/lib/manifest";

interface Entry {
  bookmark: Bookmark;
  chapterTitle: string;
}

interface BookGroup {
  code: string;
  title: string;
  subject: string;
  class: number;
  entries: Entry[];
}

/**
 * Read every bookmark and pair it with its book and chapter. Kept outside the
 * component so the effect below only sets state from a promise callback.
 */
async function loadGroups(): Promise<BookGroup[]> {
  const byCode = new Map<string, Bookmark[]>();
  for (const b of await allBookmarks()) {
    const list = byCode.get(b.code) ?? [];
    list.push(b);
    byCode.set(b.code, list);
  }

  const groups: BookGroup[] = [];
  for (const [code, marks] of byCode) {
    const book = getBook(code);
    if (!book) continue; // bookmark from an older manifest; ignore

    const entries: Entry[] = [];
    for (const bookmark of marks) {
      const chapter = getChapter(code, bookmark.chapter);
      if (!chapter) continue;
      entries.push({ bookmark, chapterTitle: chapter.title });
    }
    if (entries.length === 0) continue;

    // Reading order within a book, rather than the newest-first order the
    // database returns — a student scanning a book wants it front to back.
    entries.sort(
      (a, b) => a.bookmark.chapter - b.bookmark.chapter || a.bookmark.page - b.bookmark.page,
    );

    groups.push({
      code,
      title: book.title,
      subject: book.subject,
      class: book.class,
      entries,
    });
  }
  groups.sort((a, b) => a.class - b.class || a.subject.localeCompare(b.subject));

  return groups;
}

export default function BookmarksList() {
  const [groups, setGroups] = useState<BookGroup[] | null>(null);
  // Bumped after a removal to re-read the database.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    loadGroups()
      .then((next) => {
        if (live) setGroups(next);
      })
      .catch(() => {
        if (live) setGroups([]);
      });
    return () => {
      live = false;
    };
  }, [reloadToken]);

  async function onRemove(mark: Bookmark) {
    // `toggleBookmark` on an existing bookmark deletes it.
    await toggleBookmark(mark.code, mark.chapter, mark.page);
    setReloadToken((t) => t + 1);
  }

  if (groups === null) {
    return <p className="text-sm text-ink-faint">Loading bookmarks…</p>;
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-ink-soft">No bookmarks yet.</p>
        <p className="mt-1 text-xs text-ink-faint">
          Tap the bookmark button while reading to save the page you are on.
        </p>
        <Link href="/" className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-accent transition-colors hover:border-accent">
          Browse subjects
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.code}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            <Link href={`/class/${g.class}/${slugify(g.subject)}`} className="hover:text-accent">
              Class {g.class} · {g.subject}
              {g.title === g.subject ? "" : ` · ${g.title}`}
            </Link>
          </h2>
          <ul className="space-y-2">
            {g.entries.map(({ bookmark, chapterTitle }) => (
              <li
                key={bookmark.key}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3"
              >
                <Link
                  href={`/read/${bookmark.code}/${bookmark.chapter}`}
                  className="min-w-0 flex-1 transition-colors hover:text-accent"
                >
                  <p className="truncate text-sm font-medium">{chapterTitle}</p>
                  <p className="text-xs tabular-nums text-ink-faint">Page {bookmark.page}</p>
                </Link>
                <button
                  type="button"
                  onClick={() => onRemove(bookmark)}
                  aria-label={`Remove bookmark on page ${bookmark.page} of ${chapterTitle}`}
                  className="min-h-11 shrink-0 rounded-lg border border-border px-4 text-xs text-ink-soft transition-colors hover:border-accent hover:text-accent"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
