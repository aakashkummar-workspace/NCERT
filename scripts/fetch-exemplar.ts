/**
 * Mirror NCERT's *Exemplar Problems* books for Class 9 and Class 10.
 *
 * Why these books exist in this repo at all
 * ----------------------------------------
 * CBSE runs no Class 9 board exam, so there are no national Class 9 question
 * papers and no national marking schemes. The Exemplar Problems series is the
 * only official NCERT publication that pairs Class 9 questions with worked
 * answers, which makes it the one realistic answer-key source for Class 9.
 *
 * The book codes are NOT the textbook codes. They follow the same
 * [class][medium] prefix as the textbooks (i = IX, j = X; e = English) but
 * then use `ep` for "exemplar problems" and a book number for the subject:
 *
 *     ieep1  Class 9  Science          15 units
 *     ieep2  Class 9  Mathematics      15 units (unit 15 = Design of the Question Paper)
 *     jeep1  Class 10 Science          16 units
 *     jeep2  Class 10 Mathematics      13 units
 *
 * A chapter file is `<code><NN>.pdf`, exactly as for the textbooks.
 *
 * Mirroring, not linking, for the same reason as scripts/fetch-pdfs.ts:
 * ncert.nic.in sends no Access-Control-Allow-Origin and X-Frame-Options:
 * SAMEORIGIN, so a browser cannot fetch or iframe these cross-origin. Every
 * mirrored file records the official ncert.nic.in URL it came from, so
 * attribution and takedown stay possible — see PERMISSIONS.md.
 *
 * Safe to re-run: a file whose sha256 already matches what data/exemplar.json
 * recorded is skipped, so an interrupted run resumes where it stopped.
 * Requests are sequential with a delay; this is a government server.
 *
 *     npx tsx scripts/fetch-exemplar.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { BASE, chapterFile, fetchWithRetry, mediumOf, sleep, type Medium } from "./lib/ncert";

const CATALOGUE_URL = `${BASE}/exemplar-problems.php`;
const OUT_ROOT = "public/exemplar";
const MANIFEST = "data/exemplar.json";
const DELAY_MS = 1000;

/**
 * Directories NCERT has served exemplar chapter PDFs from. The site has moved
 * its e-content between paths before, so rather than hard-code one, the first
 * chapter of each book probes these in order and the winner is reused for the
 * rest of that book.
 */
const PDF_DIRS = ["textbook/pdf", "exemplar/pdf", "pdf/publication/exemplarproblem"] as const;

/**
 * The directory that actually serves exemplar PDFs, confirmed against the live
 * site: `pdf/publication/exemplarproblem/classIX/mathematics/ieep201.pdf`.
 *
 * The generic entries above are kept as fallbacks — NCERT has moved its
 * e-content before — but none of them resolve on their own, because the real
 * path is segmented by class and subject. Probing only the unsegmented form is
 * why an earlier run reported every unit missing while the files were there.
 *
 * The class segment is a Roman numeral and the subject is lowercased.
 */
function dirsFor(book: { class: 9 | 10; subject: string }): readonly string[] {
  const cls = book.class === 9 ? "classIX" : "classX";
  const subject = book.subject.toLowerCase();
  return [`pdf/publication/exemplarproblem/${cls}/${subject}`, ...PDF_DIRS];
}

/**
 * Back matter NCERT publishes as its own file rather than as a numbered unit.
 * The Science exemplar chapters carry questions only — their answers live in a
 * separate section — so finding these matters more than it does for Maths,
 * whose chapters already interleave "Sample Question … Solution :" pairs.
 * Both suffixes are probed once per book and simply skipped when absent.
 */
const EXTRAS = [
  { name: "answers", suffix: "an" },
  { name: "prelims", suffix: "ps" },
] as const;

/** How far past the declared unit count to probe before giving up. */
const EXTRA_UNIT_PROBES = 3;

/**
 * ncert.nic.in goes down for hours at a time. A missing *file* is a 404 and is
 * expected; a run of files that produce no response at all means the host is
 * unreachable, and there is nothing to gain from spending four minutes of
 * retries and timeouts on each of the remaining sixty. Stop, keep the manifest
 * that was built, and say so.
 */
const OFFLINE_AFTER = 3;

export interface ExemplarFile {
  /** Basename of the PDF, e.g. "ieep101.pdf" */
  file: string;
  /** Path the app serves it from */
  path: string;
  /** The official NCERT URL this file was mirrored from */
  sourceUrl: string;
  bytes?: number;
  sha256?: string;
}

export interface ExemplarChapter extends ExemplarFile {
  n: number;
  title: string;
}

export interface ExemplarExtra extends ExemplarFile {
  name: string;
}

export interface ExemplarBook {
  code: string;
  class: 9 | 10;
  subject: string;
  medium: Medium;
  title: string;
  /**
   * "inline" — every unit interleaves worked solutions with its questions.
   * "back-matter" — units are questions only; answers ship separately.
   */
  solutions: "inline" | "back-matter";
  chapters: ExemplarChapter[];
  extras: ExemplarExtra[];
}

export interface ExemplarManifest {
  generatedAt: string;
  source: string;
  books: ExemplarBook[];
}

interface Target {
  code: string;
  class: 9 | 10;
  subject: string;
  title: string;
  solutions: "inline" | "back-matter";
  /**
   * Unit count and titles as printed in the books themselves. NCERT publishes
   * no chapter titles, so these were read off the PDFs — the same position
   * data/title-overrides.json holds for the textbooks. The live catalogue
   * overrides the count when it can be reached; the titles always win, because
   * a curated title beats an extracted one.
   */
  units: string[];
}

const TARGETS: Target[] = [
  {
    code: "ieep1",
    class: 9,
    subject: "Science",
    title: "Exemplar Problems — Science",
    solutions: "back-matter",
    units: [
      "Matter in Our Surroundings",
      "Is Matter Around Us Pure",
      "Atoms and Molecules",
      "Structure of the Atom",
      "The Fundamental Unit of Life",
      "Tissues",
      "Diversity in Living Organisms",
      "Motion",
      "Force and Laws of Motion",
      "Gravitation",
      "Work and Energy",
      "Sound",
      "Why Do We Fall Ill",
      "Natural Resources",
      "Improvement in Food Resources",
    ],
  },
  {
    code: "ieep2",
    class: 9,
    subject: "Mathematics",
    title: "Exemplar Problems — Mathematics",
    solutions: "inline",
    units: [
      "Number Systems",
      "Polynomials",
      "Coordinate Geometry",
      "Linear Equations in Two Variables",
      "Introduction to Euclid's Geometry",
      "Lines and Angles",
      "Triangles",
      "Quadrilaterals",
      "Areas of Parallelograms and Triangles",
      "Circles",
      "Constructions",
      "Heron's Formula",
      "Surface Areas and Volumes",
      "Statistics and Probability",
      "Design of the Question Paper, Set I",
    ],
  },
  {
    code: "jeep1",
    class: 10,
    subject: "Science",
    title: "Exemplar Problems — Science",
    solutions: "back-matter",
    units: [
      "Chemical Reactions and Equations",
      "Acids, Bases and Salts",
      "Metals and Non-metals",
      "Carbon and its Compounds",
      "Periodic Classification of Elements",
      "Life Processes",
      "Control and Coordination",
      "How do Organisms Reproduce?",
      "Heredity and Evolution",
      "Light – Reflection and Refraction",
      "The Human Eye and the Colourful World",
      "Electricity",
      "Magnetic Effects of Electric Current",
      "Sources of Energy",
      "Our Environment",
      "Management of Natural Resources",
    ],
  },
  {
    code: "jeep2",
    class: 10,
    subject: "Mathematics",
    title: "Exemplar Problems — Mathematics",
    solutions: "inline",
    units: [
      "Real Numbers",
      "Polynomials",
      "Pair of Linear Equations in Two Variables",
      "Quadratic Equations",
      "Arithmetic Progressions",
      "Triangles",
      "Coordinate Geometry",
      "Introduction to Trigonometry and its Applications",
      "Circles",
      "Constructions",
      "Area Related to Circles",
      "Surface Areas and Volumes",
      "Statistics and Probability",
    ],
  },
];

/**
 * Every book option on an NCERT cascade page is a line like
 *   document.test.tbook.options[1].value="exemplar-problems.php?jeep1=1-16"
 * The page name and the range's first number vary between sections of the
 * site, so only the code and the unit count are pinned down here.
 */
const OPTION_RE = /options\[\d+\]\.value\s*=\s*"[^"?]*\?([a-z0-9]+)=\d+-(\d+)"/g;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isPdf(buf: Buffer): boolean {
  // NCERT answers some bad codes with an HTML error page under a 200.
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Read the declared unit count for each exemplar book off NCERT's own
 * catalogue page. Returns an empty map if the page cannot be reached, in which
 * case the counts recorded in TARGETS are used instead.
 */
async function declaredUnitCounts(): Promise<{ counts: Map<string, number>; reachable: boolean }> {
  const counts = new Map<string, number>();
  try {
    const res = await fetchWithRetry(CATALOGUE_URL);
    if (!res.ok) {
      // The host answered, so the PDFs are worth trying even if this page moved.
      console.log(`  catalogue: HTTP ${res.status}, falling back to recorded unit counts`);
      return { counts, reachable: true };
    }
    const html = await res.text();
    OPTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OPTION_RE.exec(html)) !== null) counts.set(m[1], Number(m[2]));
    console.log(`  catalogue: ${html.length.toLocaleString()} bytes, ${counts.size} books listed`);
    return { counts, reachable: true };
  } catch (err) {
    // A transport-level failure means the host itself is unreachable, PDFs
    // included. Nothing is gained by then timing out on sixty more requests.
    console.log(`  catalogue: unreachable (${(err as Error).message})`);
    return { counts, reachable: false };
  }
}

/** Everything known about a file before anything has been downloaded. */
function plan(code: string, file: string, dir: string): ExemplarFile {
  return {
    file,
    path: `/exemplar/${code}/${file}`,
    sourceUrl: `${BASE}/${dir}/${file}`,
  };
}

/**
 * Build the manifest, carrying forward the download bookkeeping a previous run
 * established. Dropping bytes/sha256 would re-download everything and blank
 * the sizes the UI shows, which is the same rule data/manifest.json lives by.
 */
async function buildManifest(counts: Map<string, number>): Promise<ExemplarManifest> {
  const previous = new Map<string, ExemplarFile>();
  if (existsSync(MANIFEST)) {
    const prev = JSON.parse(await readFile(MANIFEST, "utf8")) as ExemplarManifest;
    for (const b of prev.books) {
      for (const c of b.chapters) previous.set(`${b.code}:${c.file}`, c);
      for (const e of b.extras) previous.set(`${b.code}:${e.file}`, e);
    }
  }

  const carry = <T extends ExemplarFile>(code: string, entry: T): T => {
    const prev = previous.get(`${code}:${entry.file}`);
    if (prev?.sha256) {
      entry.bytes = prev.bytes;
      entry.sha256 = prev.sha256;
    }
    return entry;
  };

  const books: ExemplarBook[] = TARGETS.map((t) => {
    const declared = counts.get(t.code) ?? t.units.length;
    if (declared !== t.units.length) {
      console.log(
        `  [${t.code}] catalogue declares ${declared} units, ${t.units.length} titles recorded`,
      );
    }
    const total = Math.max(declared, t.units.length);
    return {
      code: t.code,
      class: t.class,
      subject: t.subject,
      medium: mediumOf(t.code),
      title: t.title,
      solutions: t.solutions,
      chapters: Array.from({ length: total }, (_, i) => {
        const n = i + 1;
        const file = chapterFile(t.code, n);
        return carry(t.code, {
          n,
          title: t.units[i] ?? `Unit ${n}`,
          ...plan(t.code, file, dirsFor(t)[0]),
        });
      }),
      extras: EXTRAS.map((e) =>
        carry(t.code, {
          name: e.name,
          ...plan(t.code, `${t.code}${e.suffix}.pdf`, dirsFor(t)[0]),
        }),
      ),
    };
  });

  return { generatedAt: new Date().toISOString(), source: CATALOGUE_URL, books };
}

type Outcome = "ok" | "skip" | "adopt" | "missing" | "failed";

/**
 * Fetch one file into place. `dirs` is tried in order and the directory that
 * worked is returned, so the caller can pin it for the rest of the book
 * instead of re-probing on every chapter.
 */
async function fetchFile(
  code: string,
  entry: ExemplarFile,
  dirs: readonly string[],
): Promise<{ outcome: Outcome; dir?: string }> {
  const path = `${OUT_ROOT}/${code}/${entry.file}`;

  if (existsSync(path)) {
    const buf = await readFile(path);
    if (entry.sha256 && sha256(buf) === entry.sha256) return { outcome: "skip" };
    // Present but unrecorded (manifest rebuilt from scratch): adopt it.
    if (!entry.sha256 && isPdf(buf)) {
      entry.bytes = buf.byteLength;
      entry.sha256 = sha256(buf);
      return { outcome: "adopt" };
    }
  }

  let sawResponse = false;
  for (const dir of dirs) {
    const url = `${BASE}/${dir}/${entry.file}`;
    try {
      const res = await fetchWithRetry(url);
      if (res.status === 404) {
        sawResponse = true;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!isPdf(buf)) {
        sawResponse = true;
        continue;
      }
      await writeFile(path, buf);
      entry.sourceUrl = url;
      entry.bytes = buf.byteLength;
      entry.sha256 = sha256(buf);
      return { outcome: "ok", dir };
    } catch (err) {
      console.log(`      ${url}: ${(err as Error).message}`);
    } finally {
      await sleep(DELAY_MS);
    }
  }
  return { outcome: sawResponse ? "missing" : "failed" };
}

async function main() {
  console.log(`Reading ${CATALOGUE_URL} ...`);
  const { counts, reachable } = await declaredUnitCounts();

  const manifest = await buildManifest(counts);
  const save = () => writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
  await save();

  const tally = { ok: 0, skip: 0, adopt: 0, missing: 0, failed: 0 };
  let bytesTotal = 0;

  // Circuit breaker — see OFFLINE_AFTER.
  let consecutiveFailures = 0;
  let offline = !reachable;
  const breaker = (outcome: Outcome) => {
    consecutiveFailures = outcome === "failed" ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= OFFLINE_AFTER) offline = true;
  };
  const record = (outcome: Outcome) => {
    tally[outcome]++;
    breaker(outcome);
  };

  for (const book of manifest.books) {
    if (offline) break;
    await mkdir(`${OUT_ROOT}/${book.code}`, { recursive: true });
    console.log(
      `\n[${book.code}] Class ${book.class} ${book.subject} — ${book.chapters.length} units, solutions ${book.solutions}`,
    );

    // Pinned once the first chapter reveals which directory NCERT serves from.
    let dirs: readonly string[] = dirsFor(book);

    for (const ch of book.chapters) {
      if (offline) break;
      const { outcome, dir } = await fetchFile(book.code, ch, dirs);
      if (dir) dirs = [dir];
      record(outcome);
      if (ch.bytes) bytesTotal += ch.bytes;
      const size = ch.bytes ? ` (${mb(ch.bytes)})` : "";
      console.log(`  ${String(ch.n).padStart(2)} ${ch.file}  ${outcome}${size}  ${ch.title}`);
      if (outcome === "ok" || outcome === "adopt") await save();
    }
    if (offline) break;

    /*
     * NCERT sometimes ships a unit the catalogue does not count (the second
     * "Design of the Question Paper" set, for instance). Probe just past the
     * end until one comes back 404.
     */
    for (let i = 0; i < EXTRA_UNIT_PROBES; i++) {
      const n = book.chapters.length + 1;
      const file = chapterFile(book.code, n);
      const candidate: ExemplarChapter = { n, title: `Unit ${n}`, ...plan(book.code, file, dirs[0]) };
      const { outcome } = await fetchFile(book.code, candidate, dirs);
      // A 404 here is the expected end of the book, not a missing file.
      if (outcome !== "ok" && outcome !== "adopt") {
        breaker(outcome);
        break;
      }
      book.chapters.push(candidate);
      bytesTotal += candidate.bytes ?? 0;
      record(outcome);
      console.log(`  ${String(n).padStart(2)} ${file}  ${outcome} (undeclared unit)`);
      await save();
    }
    if (offline) break;

    // Back matter: answers and prelims. Absent for most books; that is fine.
    const found: ExemplarExtra[] = [];
    for (const extra of book.extras) {
      if (offline) break;
      const { outcome } = await fetchFile(book.code, extra, dirs);
      breaker(outcome);
      if (outcome === "ok" || outcome === "adopt" || outcome === "skip") {
        found.push(extra);
        bytesTotal += extra.bytes ?? 0;
        tally[outcome]++;
        console.log(`     ${extra.file}  ${outcome}  [${extra.name}]`);
      } else {
        console.log(`     ${extra.file}  none  [${extra.name}]`);
      }
    }
    // Keep the planned entries when the run was cut short, so a resumed run
    // still knows to look for them.
    if (!offline) book.extras = found;
    await save();
  }

  await save();

  console.log(`\n=== done ===`);
  console.log(`downloaded: ${tally.ok}`);
  console.log(`skipped:    ${tally.skip}`);
  console.log(`adopted:    ${tally.adopt}`);
  console.log(`absent:     ${tally.missing}`);
  console.log(`failed:     ${tally.failed}`);
  console.log(`total size: ${mb(bytesTotal)}`);
  console.log(`\nWrote ${MANIFEST}`);
  if (offline) {
    console.log(`\nStopped: ${BASE} is not answering. No file was mirrored.`);
    console.log(`The manifest is written and every file already present is recorded;`);
    console.log(`re-run when the host is back and it will resume where it stopped.`);
    process.exitCode = 1;
  } else if (tally.failed > 0) {
    console.log(`\n${tally.failed} file(s) could not be reached. Re-run to retry them.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
