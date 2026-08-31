/**
 * Single access point for the CBSE sample papers used by practice mode.
 *
 * Unlike data/manifest.json this file is hand-authored, because the thing it
 * records — how many marks each question carries — is printed only inside the
 * PDFs, in a different layout per subject. Every entry was read off the paper
 * and its marking scheme and checked against `validatePaper` below. A wrong
 * mark grid is worse than no paper at all: someone scoring themselves against
 * it would learn the wrong thing, so a paper that does not verify is left out
 * rather than guessed at.
 *
 * The PDFs are mirrored under public/papers/ for the same reason the chapters
 * are: cbseacademic.nic.in sends no Access-Control-Allow-Origin, so pdf.js
 * cannot fetch them cross-origin.
 *
 * Most entries now come from scripts/fetch-papers.ts, which mirrors every paper
 * CBSE publishes and derives the mark grid from the paper's own section table.
 * That derivation does not always land: for a paper whose sections are stated in
 * prose, or split by passage rather than by marks, the script writes
 * `sectionsDerived: false` and an empty `sections` rather than a grid it cannot
 * stand behind. Those papers are still worth reading — the paper and its scheme
 * are intact — but they cannot be self-scored here, so `isScorable` sends them
 * to a read-only screen with no clock. See src/app/practice/[slug]/page.tsx.
 *
 * CBSE publishes no Class 9 sample papers, so every entry is Class 10.
 */
import papersJson from "@data/papers.json";

export type QuestionType = "mcq" | "assertion-reason" | "vsa" | "sa" | "la" | "case-study";

/**
 * A contiguous run of question numbers sharing one mark value and one form.
 * `label` is the section the paper itself prints (A–E); `topic` is what that
 * section covers when the paper divides by subject rather than by marks —
 * Science splits into Biology/Chemistry/Physics, Social Science into the four
 * disciplines, Mathematics not at all.
 */
export interface PaperSection {
  label: string;
  topic?: string;
  from: number;
  to: number;
  marksEach: number;
  type: QuestionType;
}

export interface Paper {
  slug: string;
  class: 9 | 10;
  subject: string;
  code?: string;
  title: string;
  session: string;
  durationMinutes: number;
  maxMarks: number;
  questionCount: number;
  paperFile: string;
  schemeFile: string;
  paperBytes?: number;
  schemeBytes?: number;
  sections: PaperSection[];
  /**
   * False when the pipeline could not read a trustworthy mark grid off the
   * paper; `sections` is then empty. Absent on the three hand-curated papers,
   * which predate the harvest and were read off the PDF by a person — so the
   * test is `=== false`, never `!sections.length`. A paper that genuinely has
   * no sections is a different thing from one whose sections are unknown.
   */
  sectionsDerived?: boolean;
}

export interface PapersManifest {
  source: string;
  session: string;
  papers: Paper[];
}

/** One row of the scoring grid: a section expanded to its question numbers. */
export interface PaperQuestion {
  n: number;
  maxMarks: number;
  type: QuestionType;
  section: string;
  topic?: string;
}

// The JSON import widens literal types (`10` -> number, `"mcq"` -> string) and
// entries are structurally heterogeneous, since `topic` is omitted rather than
// nulled. The double assertion is what that costs; validatePaper is the real
// guarantee, and scripts/ has no hand in producing this file.
export const papersManifest = papersJson as unknown as PapersManifest;

export const papers: Paper[] = papersManifest.papers;

/** Stable order: by class, then subject, so lists do not reshuffle. */
export function allPapers(): Paper[] {
  return [...papers].sort((a, b) => a.class - b.class || a.subject.localeCompare(b.subject));
}

export function getPaper(slug: string): Paper | undefined {
  return papers.find((p) => p.slug === slug);
}

export function papersForClass(cls: 9 | 10): Paper[] {
  return allPapers().filter((p) => p.class === cls);
}

/**
 * Whether this paper can be sat and marked, or only read.
 *
 * A timed attempt is worth nothing without a mark grid to score against, so a
 * paper the pipeline could not derive one for offers neither. Everything the
 * scoring UI needs hangs off this one answer.
 */
export function isScorable(paper: Paper): boolean {
  return paper.sectionsDerived !== false;
}

/** Sections expanded to one entry per question, ascending — the scoring grid. */
export function questionsFor(paper: Paper): PaperQuestion[] {
  return [...paper.sections]
    .sort((a, b) => a.from - b.from)
    .flatMap((s) =>
      Array.from({ length: s.to - s.from + 1 }, (_, i) => ({
        n: s.from + i,
        maxMarks: s.marksEach,
        type: s.type,
        section: s.label,
        topic: s.topic,
      })),
    );
}

/** Path to the mirrored question paper on our own origin. */
export function paperPdfPath(paper: Paper): string {
  return `/papers/${paper.paperFile}`;
}

/** Path to the mirrored marking scheme, kept locked until the attempt ends. */
export function schemePdfPath(paper: Paper): string {
  return `/papers/${paper.schemeFile}`;
}

/**
 * Every way a paper's mark grid can be wrong, as human-readable messages;
 * `[]` means sound. Run against all three papers by scripts/smoke checks — a
 * section table that does not add up must never reach the scoring UI.
 */
export function validatePaper(paper: Paper): string[] {
  // A paper with no derived grid has nothing to check; it never reaches the
  // scoring UI, and reporting "sections cover 1-0" for all 36 of them would
  // bury a real fault in a paper that does.
  if (!isScorable(paper)) return [];

  const problems: string[] = [];
  const sections = [...paper.sections].sort((a, b) => a.from - b.from);

  let expected = 1;
  for (const s of sections) {
    if (s.to < s.from) problems.push(`section ${s.label} ${s.from}-${s.to} runs backwards`);
    if (s.marksEach <= 0) problems.push(`section ${s.label} ${s.from}-${s.to} carries no marks`);
    if (s.from !== expected) {
      problems.push(
        s.from < expected
          ? `question ${s.from} is covered by two sections`
          : `questions ${expected}-${s.from - 1} are covered by no section`,
      );
    }
    expected = Math.max(expected, s.to + 1);
  }

  const last = expected - 1;
  if (last !== paper.questionCount) {
    problems.push(`sections cover 1-${last}, but the paper has ${paper.questionCount} questions`);
  }

  const total = sections.reduce((sum, s) => sum + (s.to - s.from + 1) * s.marksEach, 0);
  if (total !== paper.maxMarks) {
    problems.push(`sections total ${total} marks, but the paper is out of ${paper.maxMarks}`);
  }

  return problems;
}

/** "3 hours", "1 hr 30 min" — the label beside the exam timer. */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hour${h > 1 ? "s" : ""}`;
  return `${m} min`;
}
