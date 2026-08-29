/**
 * Typed access to the mirrored past-paper archive.
 *
 * These are CBSE past-year question papers for Class 9 and 10, mirrored as page
 * *image scans* by scripts/fetch-pyqs.ts. They differ from the sample papers in
 * lib/papers.ts in three ways that matter to every caller: there is no text
 * layer, there is no marking scheme, and the source is a third-party aggregator
 * rather than CBSE. Nothing here can be searched or auto-graded, and the UI must
 * not imply the papers are endorsed.
 *
 * The JSON is written incrementally by a long download and does not exist at all
 * on a fresh clone, so this module treats an absent or half-written file as an
 * empty archive rather than a build failure.
 */
import pyqsJson from "@data/pyqs.json";

export interface PyqPage {
  file: string;
  bytes: number;
  sha256: string;
}

export interface Pyq {
  id: string;
  class: 9 | 10;
  year: number;
  category: string;
  subject: string;
  /** True for the five subjects this app carries textbooks for. */
  core: boolean;
  variant?: string;
  title: string;
  rawSlug: string;
  /** The aggregator page this was mirrored from; shown for provenance. */
  sourceUrl: string;
  pages: PyqPage[];
  bytes: number;
}

interface PyqsFile {
  source: string;
  fetchedAt: string;
  note: string;
  papers: Pyq[];
}

/**
 * A paper mid-download can be in the file with an empty `pages` array, and the
 * whole file can be missing. Filter to papers that actually have pages on disk,
 * so no route is ever generated for something a student cannot open.
 */
function load(): Pyq[] {
  const file = pyqsJson as Partial<PyqsFile> | null;
  const papers = Array.isArray(file?.papers) ? file.papers : [];
  return papers.filter((p): p is Pyq => Boolean(p?.id && p.pages?.length));
}

export const pyqs: Pyq[] = load();

/** Fixed order so a student looking for Science never scrolls past 40 vocational subjects. */
const CORE_ORDER = ["Mathematics", "Science", "Social Science", "English", "Hindi"];

/** Newest first, then subject, then variant — a stable listing between renders. */
function sortPapers(list: Pyq[]): Pyq[] {
  return [...list].sort(
    (a, b) =>
      b.year - a.year ||
      a.subject.localeCompare(b.subject) ||
      (a.variant ?? "").localeCompare(b.variant ?? ""),
  );
}

export function allPyqs(): Pyq[] {
  return sortPapers(pyqs);
}

export function getPyq(id: string): Pyq | undefined {
  return pyqs.find((p) => p.id === id);
}

export function pyqsFor(filter: {
  class?: 9 | 10;
  year?: number;
  subject?: string;
  core?: boolean;
}): Pyq[] {
  return sortPapers(
    pyqs.filter(
      (p) =>
        (filter.class === undefined || p.class === filter.class) &&
        (filter.year === undefined || p.year === filter.year) &&
        (filter.subject === undefined || p.subject === filter.subject) &&
        (filter.core === undefined || p.core === filter.core),
    ),
  );
}

/** Descending, so the most recent paper is the default choice. */
export function pyqYears(cls?: 9 | 10): number[] {
  const years = new Set(pyqs.filter((p) => cls === undefined || p.class === cls).map((p) => p.year));
  return [...years].sort((a, b) => b - a);
}

export function pyqSubjects(cls?: 9 | 10): string[] {
  const subjects = new Set(
    pyqs.filter((p) => cls === undefined || p.class === cls).map((p) => p.subject),
  );
  const rest = [...subjects].filter((s) => !CORE_ORDER.includes(s)).sort();
  return [...CORE_ORDER.filter((s) => subjects.has(s)), ...rest];
}

export function pageUrl(page: PyqPage): string {
  return `/pyqs/${page.file}`;
}

export function pyqCount(): number {
  return pyqs.length;
}

/** "1.2 MB" — same phrasing as the chapter list, so sizes read consistently. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
