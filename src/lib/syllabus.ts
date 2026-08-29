/**
 * Single access point for the generated CBSE syllabus weightage.
 *
 * Produced by scripts/build-syllabus.ts from the curriculum PDFs and imported
 * at build time, so every route can be statically generated with no runtime
 * data fetching — the same arrangement as src/lib/manifest.ts.
 *
 * Coverage is deliberately incomplete. CBSE's 2025-26 Class IX syllabus is
 * still written against the previous NCERT books, while the manifest carries
 * the new NCF ones, so most Class IX units have no chapters attached and every
 * consumer here has to cope with that. `unitsFor` returning nothing, or a unit
 * with no chapters, is a normal state and not an error.
 */
import syllabusJson from "@data/syllabus.json";
import { getBook, type Book, type ClassNum } from "./manifest";

export interface UnitBook {
  bookCode: string;
  chapters: number[];
}

export interface Unit {
  name: string;
  marks: number;
  bookCode?: string;
  chapters: number[];
  books?: UnitBook[];
  note?: string;
}

export interface SubjectSyllabus {
  class: ClassNum;
  subject: string;
  totalMarks: number;
  internalAssessment?: number;
  units: Unit[];
  source: string;
}

export interface Syllabus {
  generatedAt: string;
  subjects: SubjectSyllabus[];
}

export const syllabus = syllabusJson as Syllabus;

export function syllabusFor(cls: ClassNum, subject: string): SubjectSyllabus | undefined {
  return syllabus.subjects.find((s) => s.class === cls && s.subject === subject);
}

export function unitsFor(cls: ClassNum, subject: string): Unit[] {
  return syllabusFor(cls, subject)?.units ?? [];
}

/**
 * A unit's chapter mapping in one shape. Most units name a single book;
 * English literature spans two, and an unmapped unit names none.
 */
export function unitBooks(unit: Unit): UnitBook[] {
  if (unit.books) return unit.books;
  if (unit.bookCode && unit.chapters.length > 0) {
    return [{ bookCode: unit.bookCode, chapters: unit.chapters }];
  }
  return [];
}

export function isMapped(unit: Unit): boolean {
  return unitBooks(unit).length > 0;
}

/** The unit a chapter belongs to, for the marks label on a chapter row. */
export function unitOfChapter(cls: ClassNum, subject: string, code: string, n: number): Unit | undefined {
  return unitsFor(cls, subject).find((unit) =>
    unitBooks(unit).some((b) => b.bookCode === code && b.chapters.includes(n)),
  );
}

/**
 * Marks per chapter within a unit, so progress can be counted in marks rather
 * than in chapters. CBSE weights a unit, never a chapter, so this is an even
 * split — an honest approximation, and the only one the source supports.
 */
export function marksPerChapter(unit: Unit): number {
  const count = unitBooks(unit).reduce((n, b) => n + b.chapters.length, 0);
  return count === 0 ? 0 : unit.marks / count;
}

/** Marks a student has covered, given the chapters they have finished. */
export function marksCovered(
  cls: ClassNum,
  subject: string,
  done: (code: string, n: number) => boolean,
): number {
  return unitsFor(cls, subject).reduce((total, unit) => {
    const per = marksPerChapter(unit);
    const covered = unitBooks(unit).reduce(
      (n, b) => n + b.chapters.filter((ch) => done(b.bookCode, ch)).length,
      0,
    );
    return total + per * covered;
  }, 0);
}

export interface UnitChapterRef {
  book: Book;
  chapter: number;
  title: string;
}

/** The chapters of a unit, resolved against the manifest for display. */
export function chaptersOf(unit: Unit): UnitChapterRef[] {
  return unitBooks(unit).flatMap(({ bookCode, chapters }) => {
    const book = getBook(bookCode);
    if (!book) return [];
    return chapters.flatMap((n) => {
      const chapter = book.chapters.find((c) => c.n === n);
      return chapter ? [{ book, chapter: n, title: chapter.title }] : [];
    });
  });
}

/**
 * "chapters 1–4", or "chapters 1, 3 and 7" when they are not contiguous —
 * the label that turns a weightage number into something actionable.
 */
export function chapterRangeLabel(unit: Unit): string {
  // A unit spanning two books gets one phrase per book; merging the numbers
  // would read as "chapters 1, 1, 2, 2 …".
  return unitBooks(unit)
    .map(({ bookCode, chapters }) => {
      const label = rangeOf(chapters);
      const book = getBook(bookCode);
      return unit.books && book ? `${book.title}: ${label}` : label;
    })
    .filter(Boolean)
    .join("; ");
}

function rangeOf(chapters: number[]): string {
  if (chapters.length === 0) return "";
  const sorted = [...chapters].sort((a, b) => a - b);
  if (sorted.length === 1) return `chapter ${sorted[0]}`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  if (contiguous) return `chapters ${sorted[0]}–${sorted[sorted.length - 1]}`;
  return `chapters ${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
}

/** Units heaviest first — where a student short on time should start. */
export function unitsByWeight(cls: ClassNum, subject: string): Unit[] {
  return [...unitsFor(cls, subject)].sort((a, b) => b.marks - a.marks);
}
