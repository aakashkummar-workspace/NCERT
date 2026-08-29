"use client";

/**
 * Per-device reading state (last page, bookmarks) in IndexedDB via Dexie.
 *
 * Deliberately separate from the offline PDF cache: this is small structured
 * data that should survive even when a student deletes downloaded chapters.
 */
import Dexie, { type EntityTable } from "dexie";

export interface Progress {
  /** `${code}:${chapter}` */
  key: string;
  code: string;
  chapter: number;
  page: number;
  pageCount: number;
  updatedAt: number;
}

export interface Bookmark {
  key: string;
  code: string;
  chapter: number;
  page: number;
  createdAt: number;
}

const db = new Dexie("ncert-quick") as Dexie & {
  progress: EntityTable<Progress, "key">;
  bookmarks: EntityTable<Bookmark, "key">;
};

db.version(1).stores({
  progress: "key, code, updatedAt",
  bookmarks: "key, code, createdAt",
});

const progressKey = (code: string, chapter: number) => `${code}:${chapter}`;
const bookmarkKey = (code: string, chapter: number, page: number) =>
  `${code}:${chapter}:${page}`;

export async function saveProgress(
  code: string,
  chapter: number,
  page: number,
  pageCount: number,
): Promise<void> {
  await db.progress.put({
    key: progressKey(code, chapter),
    code,
    chapter,
    page,
    pageCount,
    updatedAt: Date.now(),
  });
}

export async function getProgress(code: string, chapter: number): Promise<Progress | undefined> {
  return db.progress.get(progressKey(code, chapter));
}

/** Most recently read chapters, newest first — powers the "Continue reading" card. */
export async function recentlyRead(limit = 5): Promise<Progress[]> {
  return db.progress.orderBy("updatedAt").reverse().limit(limit).toArray();
}

export async function toggleBookmark(
  code: string,
  chapter: number,
  page: number,
): Promise<boolean> {
  const key = bookmarkKey(code, chapter, page);
  const existing = await db.bookmarks.get(key);
  if (existing) {
    await db.bookmarks.delete(key);
    return false;
  }
  await db.bookmarks.put({ key, code, chapter, page, createdAt: Date.now() });
  return true;
}

export async function bookmarksFor(code: string, chapter: number): Promise<Bookmark[]> {
  return db.bookmarks.where("code").equals(code).filter((b) => b.chapter === chapter).toArray();
}

export async function allBookmarks(): Promise<Bookmark[]> {
  return db.bookmarks.orderBy("createdAt").reverse().toArray();
}
