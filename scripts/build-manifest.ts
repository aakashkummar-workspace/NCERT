/**
 * Phase 0, step 2 — turn the raw catalogue into the app's manifest.
 *
 * NCERT's site labels chapters generically ("Chapter 1", "Chapter 2") and
 * publishes no chapter titles anywhere, so titles start as placeholders and are
 * filled in later by scripts/extract-titles.ts, which reads them out of the
 * downloaded PDFs. Re-running this script preserves any titles already found.
 *
 * Input:  data/catalogue.raw.json
 * Output: data/manifest.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  chapterFile,
  mediumOf,
  slugify,
  type Book,
  type Chapter,
  type Manifest,
  type RawBook,
} from "./lib/ncert";

/** Subjects the app ships. Everything else (Urdu, Sanskrit, Vocational...) is out of scope for v1. */
const CORE_SUBJECTS = new Set([
  "English",
  "Hindi",
  "Mathematics",
  "Science",
  "Social Science",
]);

/**
 * The app is English-medium, so we take English-medium books for every subject
 * — except Hindi, whose textbooks are Hindi by nature.
 */
function inScope(b: RawBook): boolean {
  if (b.class !== 9 && b.class !== 10) return false;
  if (b.withdrawn) return false;
  if (!CORE_SUBJECTS.has(b.subject)) return false;
  const medium = mediumOf(b.code);
  return medium === "en" || b.subject === "Hindi";
}

async function main() {
  const raw = JSON.parse(await readFile("data/catalogue.raw.json", "utf8")) as {
    generatedAt: string;
    source: string;
    books: RawBook[];
  };

  /*
   * Carry forward everything a previous run established: extracted titles and,
   * just as importantly, the download bookkeeping (bytes / sha256). Dropping
   * those would make fetch-pdfs re-download all 509 MB and blank the file sizes
   * shown next to every chapter.
   */
  const previous = new Map<string, Chapter>();
  if (existsSync("data/manifest.json")) {
    const prev = JSON.parse(await readFile("data/manifest.json", "utf8")) as Manifest;
    for (const b of prev.books) {
      for (const c of b.chapters) previous.set(`${b.code}:${c.n}`, c);
    }
  }

  const books: Book[] = raw.books.filter(inScope).map((b) => ({
    code: b.code,
    class: b.class as 9 | 10,
    subject: b.subject,
    medium: mediumOf(b.code),
    title: b.title.trim(),
    chapters: Array.from({ length: b.chapterCount }, (_, i) => {
      const n = i + 1;
      const prev = previous.get(`${b.code}:${n}`);
      return {
        n,
        title: prev?.title ?? `Chapter ${n}`,
        file: chapterFile(b.code, n),
        bytes: prev?.bytes,
        originalBytes: prev?.originalBytes,
        sha256: prev?.sha256,
      };
    }),
  }));

  books.sort(
    (a, b) => a.class - b.class || a.subject.localeCompare(b.subject) || a.code.localeCompare(b.code),
  );

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    source: raw.source,
    books,
  };
  await writeFile("data/manifest.json", JSON.stringify(manifest, null, 2));

  const chapters = books.reduce((n, b) => n + b.chapters.length, 0);
  console.log(`Books:    ${books.length}`);
  console.log(`Chapters: ${chapters}\n`);
  for (const cls of [9, 10] as const) {
    console.log(`Class ${cls}:`);
    for (const b of books.filter((x) => x.class === cls)) {
      console.log(
        `  ${b.code.padEnd(7)} ${b.medium}  ${String(b.chapters.length).padStart(2)}ch  ${slugify(b.subject).padEnd(15)} ${b.title}`,
      );
    }
  }
  console.log(`\nWrote data/manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
