/**
 * Single access point for the generated NCERT content manifest.
 *
 * The manifest is produced by the scripts/ pipeline and imported at build time,
 * so every route can be statically generated with no runtime data fetching.
 */
import manifestJson from "@data/manifest.json";

export type Medium = "en" | "hi" | "ur" | "sa" | "other";

export interface Chapter {
  n: number;
  title: string;
  file: string;
  bytes?: number;
  originalBytes?: number;
  sha256?: string;
}

export interface Book {
  code: string;
  class: 9 | 10;
  subject: string;
  medium: Medium;
  title: string;
  legacy?: boolean;
  chapters: Chapter[];
}

export interface Manifest {
  generatedAt: string;
  source: string;
  books: Book[];
}

export const manifest = manifestJson as Manifest;

export const CLASSES = [9, 10] as const;
export type ClassNum = (typeof CLASSES)[number];

/** Fixed order so subject grids don't reshuffle between classes. */
const SUBJECT_ORDER = ["Science", "Mathematics", "Social Science", "English", "Hindi"];

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isClassNum(v: unknown): v is ClassNum {
  return v === 9 || v === 10;
}

export function booksForClass(cls: ClassNum): Book[] {
  return manifest.books.filter((b) => b.class === cls);
}

export interface Subject {
  name: string;
  slug: string;
  books: Book[];
  chapterCount: number;
}

export function subjectsForClass(cls: ClassNum): Subject[] {
  const bySubject = new Map<string, Book[]>();
  for (const b of booksForClass(cls)) {
    const list = bySubject.get(b.subject) ?? [];
    list.push(b);
    bySubject.set(b.subject, list);
  }
  return [...bySubject.entries()]
    .map(([name, books]) => ({
      name,
      slug: slugify(name),
      books,
      chapterCount: books.reduce((n, b) => n + b.chapters.length, 0),
    }))
    .sort((a, b) => {
      const ai = SUBJECT_ORDER.indexOf(a.name);
      const bi = SUBJECT_ORDER.indexOf(b.name);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.name.localeCompare(b.name);
    });
}

export function getSubject(cls: ClassNum, slug: string): Subject | undefined {
  return subjectsForClass(cls).find((s) => s.slug === slug);
}

export function getBook(code: string): Book | undefined {
  return manifest.books.find((b) => b.code === code);
}

export function getChapter(code: string, n: number): Chapter | undefined {
  return getBook(code)?.chapters.find((c) => c.n === n);
}

/** Path to the mirrored PDF on our own origin. */
export function pdfPath(code: string, file: string): string {
  return `/ncert/${code}/${file}`;
}

/** Official NCERT source for a chapter, linked from the reader for attribution. */
export function officialUrl(file: string): string {
  return `https://ncert.nic.in/textbook/pdf/${file}`;
}

/** Previous/next chapter within a book, for the reader's navigation. */
export function chapterNeighbours(code: string, n: number) {
  const book = getBook(code);
  if (!book) return { prev: undefined, next: undefined };
  return {
    prev: book.chapters.find((c) => c.n === n - 1),
    next: book.chapters.find((c) => c.n === n + 1),
  };
}

export function formatBytes(bytes?: number): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Every chapter in the manifest, used by generateStaticParams for the reader. */
export function allChapters(): { code: string; chapter: Chapter; book: Book }[] {
  return manifest.books.flatMap((book) =>
    book.chapters.map((chapter) => ({ code: book.code, chapter, book })),
  );
}
