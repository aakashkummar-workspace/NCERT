/**
 * Phase 2, step 1 — mirror the CBSE Class 10 sample question papers and their
 * marking schemes.
 *
 * cbseacademic.nic.in is under exactly the same constraint as ncert.nic.in: it
 * serves its PDFs with no Access-Control-Allow-Origin header and with
 * X-Frame-Options: SAMEORIGIN, so a browser cannot fetch them into pdf.js or
 * iframe them cross-origin. Mirroring onto our own origin is the only way the
 * in-app reader (and Phase 3's practice mode) can open them at all.
 *
 * The filenames are scraped rather than constructed. CBSE's naming is not
 * regular — `Bhoti_SQP.pdf` uses an underscore where everything else uses a
 * hyphen, `TeluguAndhra-SQP.pdf` is answered by `Telgu-MS.pdf`, and guessing
 * `Maths-Standard-SQP.pdf` returns a 624-byte HTML error page with a 200. The
 * only reliable source of a paper's URL is the index page's own <a href>.
 *
 * Rows that CBSE has commented out (`<!--<tr>...`) are withdrawn subjects and
 * are skipped, the same convention the NCERT catalogue scraper relies on.
 *
 * CBSE publishes no Class 9 sample papers: SQP_CLASSIX_2025-26.html and
 * SQP_CLASSIX.html both 404. Class 9 self-checks against the NCERT answer keys
 * fetched by fetch-extras.ts instead.
 *
 * Safe to re-run: a file whose bytes already hash to the sha256 recorded in
 * the catalogue is skipped, so an interrupted run resumes where it stopped.
 * Requests are sequential with a delay — this is a government server.
 *
 * Output: public/papers/class10/<subject-slug>/*.pdf and data/papers.catalogue.json
 *
 * It deliberately does NOT write data/papers.json. That file is hand-authored:
 * its per-question mark grids were read off the papers and verified by a human,
 * and no extractor can regenerate them. Overwriting it would silently replace
 * checked marks with guesses — the same reason 44 chapters still read
 * "Chapter N" rather than a mangled title.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fetchWithRetry, sleep, slugify } from "./lib/ncert";

const INDEX_URL = "https://cbseacademic.nic.in/SQP_CLASSX_2025-26.html";
const SITE_BASE = "https://cbseacademic.nic.in/";
const OUT_ROOT = "public/papers/class10";
const PAPERS_JSON = "data/papers.catalogue.json";
const DELAY_MS = 1000;

/**
 * Several CBSE PDFs use legacy CID font encodings; without pdf.js's cmap
 * tables extraction returns mojibake. Same options extract-titles.ts uses.
 */
const FONT_OPTS = {
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  useSystemFonts: true,
} as const;

/**
 * CBSE subject rows mapped onto the subject names in data/manifest.json, so a
 * later phase can link a paper from the chapter list. Only the subjects we
 * actually carry textbooks for appear here; the other ~30 rows (Arabic,
 * Painting, NCC, the regional languages) have no NCERT book in our manifest
 * and are recorded with no textbook subject rather than a forced guess.
 */
const NCERT_SUBJECT: Record<string, string> = {
  Science: "Science",
  "Mathematics (Basic)": "Mathematics",
  "Mathematics (Standard)": "Mathematics",
  "Social Science": "Social Science",
  "English (Language & Literature)": "English",
  "English (Communicative)": "English",
  "Hindi A": "Hindi",
  "Hindi B": "Hindi",
};

export interface Paper {
  /** Subject exactly as CBSE prints it in the index table. */
  subject: string;
  /** Route-safe form of `subject`; also the directory the PDFs live in. */
  slug: string;
  class: 10;
  /**
   * Which *edition* CBSE published, not the language the paper is written in.
   * CBSE marks a Hindi translation with a `_hi` basename suffix and nothing
   * else, so "en" here means "the unsuffixed edition". For a language subject
   * — Hindi A, Sanskrit, Urdu B — that single unsuffixed edition is of course
   * written in that language; there is no signal in the index to say so, and
   * inventing one from the subject name would be a guess.
   */
  language: "en" | "hi";
  /** Basename of the question paper PDF. */
  paperFile: string;
  /** Basename of the marking scheme, absent when CBSE published none. */
  markingSchemeFile?: string;
  /** Size and hash of the question paper. */
  bytes: number;
  sha256: string;
  /** Size and hash of the marking scheme, when there is one. */
  markingSchemeBytes?: number;
  markingSchemeSha256?: string;
  /** Read off the paper's own first page; absent when it does not say. */
  durationMinutes?: number;
  maxMarks?: number;
  /** Subject name in data/manifest.json, when we carry that textbook. */
  ncertSubject?: string;
  /** Original CBSE URLs, kept for attribution in the UI. */
  paperUrl: string;
  markingSchemeUrl?: string;
}

export interface PapersManifest {
  generatedAt: string;
  source: string;
  papers: Paper[];
}

/** One <a href> found in a table cell, classified by its `_hi` suffix. */
interface Link {
  url: string;
  file: string;
  language: "en" | "hi";
}

/** A parsed row of CBSE's index table. */
interface Row {
  subject: string;
  sqp: Link[];
  ms: Link[];
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Cell text with tags removed and the handful of entities CBSE uses decoded. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function linksIn(html: string): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(/href\s*=\s*"([^"]+\.pdf)"/gi)) {
    const url = new URL(m[1], SITE_BASE).href;
    const file = decodeURIComponent(url.split("/").pop() ?? "");
    // CBSE marks the Hindi translation with a `_hi` suffix on the basename.
    out.push({ url, file, language: /_hi\.pdf$/i.test(file) ? "hi" : "en" });
  }
  return out;
}

/**
 * Parse the index table.
 *
 * The markup is hand-maintained and not well-formed — there is a stray unclosed
 * <tr> between the Bhoti and Bhutia rows — so rows are split on the opening tag
 * and any chunk without three usable cells is dropped rather than trusted.
 */
function parseIndex(html: string): Row[] {
  // Withdrawn subjects are left in the page but wrapped in an HTML comment.
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  const rows: Row[] = [];

  for (const chunk of live.split(/<tr\b[^>]*>/i).slice(1)) {
    const body = chunk.split(/<\/tr>/i)[0];
    const cells = [...body.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    if (cells.length < 2) continue;

    const subject = cellText(cells[0]);
    if (!subject || /^subject$/i.test(subject)) continue; // header row

    const sqp = linksIn(cells[1]);
    const ms = cells.length > 2 ? linksIn(cells[2]) : [];
    if (sqp.length === 0) continue;

    rows.push({ subject, sqp, ms });
  }
  return rows;
}

/**
 * Read "Maximum Marks: 80" and "Time Allowed: 3 hours" off the paper's first
 * page.
 *
 * CBSE phrases both a dozen ways across subjects — "Max. Marks", "Maximum
 * marks:80", "Full marks :80", "Time :", "Time Allowed:" — so each is matched
 * loosely and then sanity-checked. The Hindi editions print the labels in
 * Devanagari with ASCII digits ("अंक : 80", "समय : 3 घंटे"), but the labels
 * themselves extract inconsistently from the legacy fonts, so those patterns
 * anchor on the parts that survive and require an explicit colon.
 *
 * Anything outside a plausible range is discarded and the field left absent:
 * a wrong duration on a practice timer is worse than no timer, the same rule
 * that leaves 44 chapter titles as "Chapter N".
 */
function parseHeader(text: string): { durationMinutes?: number; maxMarks?: number } {
  const out: { durationMinutes?: number; maxMarks?: number } = {};

  // "Max"/"Full" only, never a bare "Total Marks": the Gujarati paper prints
  // "Total Marks - 34" for Part A alone, which is not the paper's maximum.
  const marks =
    /(?:Max(?:imum)?\.?|Full)\s*Marks?\s*[:.\-–]?\s*(\d{1,3})/i.exec(text) ??
    // Devanagari: the label degrades to अंक / अींक / अङ्क, so match the tail of
    // the word plus a colon rather than the whole thing.
    /अ\S{0,3}क\s*[:：]\s*(\d{1,3})/.exec(text);
  if (marks) {
    const n = Number(marks[1]);
    if (n >= 10 && n <= 100) out.maxMarks = n;
  }

  // Kerning splits "hours" into "h ou rs" on the Painting paper, so the unit
  // is matched letter by letter with optional gaps.
  const hours =
    /Time\s*(?:Allowed|Duration)?\s*[:.\-–]?\s*(\d(?:\.\d)?|\d\s*½)\s*(?:H\s*o\s*u\s*r\s*s?|Hrs?)/i.exec(text) ??
    // Devanagari: "3 घंटे" / "3 घींटे" — घ, optional matras, ट is specific to घंटा.
    /(\d(?:\.\d)?)\s*घ\S{0,3}ट/.exec(text);
  const mins = /Time\s*(?:Allowed|Duration)?\s*[:.\-–]?\s*(\d{2,3})\s*(?:Minutes?|Mins?)/i.exec(text);
  let minutes: number | undefined;
  if (hours) minutes = Math.round(parseFloat(hours[1].replace(/\s*½/, ".5")) * 60);
  else if (mins) minutes = Number(mins[1]);
  if (minutes !== undefined && minutes >= 30 && minutes <= 300) out.durationMinutes = minutes;

  return out;
}

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

async function firstPageText(pdfjs: Pdfjs, path: string): Promise<string> {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
    ...FONT_OPTS,
  }).promise;
  try {
    const tc = await (await doc.getPage(1)).getTextContent();
    return tc.items
      .map((i) => ("str" in i ? i.str : ""))
      .join(" ")
      .replace(/\s+/g, " ");
  } finally {
    await doc.destroy();
  }
}

interface Stats {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
}

/**
 * Fetch one PDF unless we already hold a byte-identical copy.
 *
 * Returns the size and hash, or null if the download failed — a failure is
 * logged and the run continues, so one dead link cannot lose the whole batch.
 */
async function mirror(
  link: Link,
  dir: string,
  known: Map<string, { bytes: number; sha256: string }>,
  prefix: string,
  stats: Stats,
): Promise<{ bytes: number; sha256: string } | null> {
  const path = `${dir}/${link.file}`;
  const previous = known.get(path);

  if (existsSync(path)) {
    const buf = await readFile(path);
    const hash = sha256(buf);
    // Recorded and unchanged, or present but unrecorded (papers.json rebuilt).
    if (!previous || previous.sha256 === hash) {
      stats.skipped++;
      stats.bytes += buf.byteLength;
      console.log(`${prefix}  ${previous ? "skip" : "adopt"} (${mb(buf.byteLength)})`);
      return { bytes: buf.byteLength, sha256: hash };
    }
  }

  try {
    const res = await fetchWithRetry(link.url);
    if (res.status === 404) {
      stats.failed++;
      console.log(`${prefix}  MISSING (404) ${link.url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());

    // CBSE answers a bad path with an HTML error page under a 200 status, so
    // the magic bytes are the only trustworthy check that this is a PDF.
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      stats.failed++;
      console.log(`${prefix}  NOT A PDF (${buf.byteLength} bytes)`);
      return null;
    }

    await writeFile(path, buf);
    stats.downloaded++;
    stats.bytes += buf.byteLength;
    console.log(`${prefix}  ok (${mb(buf.byteLength)})`);
    return { bytes: buf.byteLength, sha256: sha256(buf) };
  } catch (err) {
    stats.failed++;
    console.log(`${prefix}  FAILED ${(err as Error).message}`);
    return null;
  } finally {
    await sleep(DELAY_MS);
  }
}

async function main() {
  console.log(`Fetching ${INDEX_URL} ...`);
  const html = await (await fetchWithRetry(INDEX_URL)).text();
  console.log(`  ${html.length.toLocaleString()} bytes`);

  const rows = parseIndex(html);
  const linkCount = rows.reduce((n, r) => n + r.sqp.length + r.ms.length, 0);
  console.log(`  ${rows.length} subject rows, ${linkCount} live PDF links`);

  // Previous run's hashes, keyed by output path, so re-runs can skip.
  const known = new Map<string, { bytes: number; sha256: string }>();
  if (existsSync(PAPERS_JSON)) {
    const prev = JSON.parse(await readFile(PAPERS_JSON, "utf8")) as PapersManifest;
    for (const p of prev.papers) {
      const dir = `${OUT_ROOT}/${p.slug}`;
      known.set(`${dir}/${p.paperFile}`, { bytes: p.bytes, sha256: p.sha256 });
      if (p.markingSchemeFile && p.markingSchemeSha256) {
        known.set(`${dir}/${p.markingSchemeFile}`, {
          bytes: p.markingSchemeBytes ?? 0,
          sha256: p.markingSchemeSha256,
        });
      }
    }
  }

  const stats: Stats = { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
  const papers: Paper[] = [];
  let done = 0;

  const save = () =>
    writeFile(
      PAPERS_JSON,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          source: INDEX_URL,
          papers: [...papers].sort(
            (a, b) => a.subject.localeCompare(b.subject) || a.language.localeCompare(b.language),
          ),
        } satisfies PapersManifest,
        null,
        2,
      ),
    );

  for (const row of rows) {
    const slug = slugify(row.subject);
    const dir = `${OUT_ROOT}/${slug}`;
    await mkdir(dir, { recursive: true });
    console.log(`\n[${slug}] ${row.subject}`);

    // A row carries one paper per language; the marking scheme in the same
    // language is its pair. MathsStandard, for one, has a Hindi paper but only
    // an English scheme, so the pairing is by language and may come up empty.
    for (const paper of row.sqp) {
      done++;
      const prefix = `  ${String(done).padStart(3)}/${linkCount} ${paper.file}`;
      const got = await mirror(paper, dir, known, prefix, stats);
      if (!got) continue;

      const scheme = row.ms.find((m) => m.language === paper.language);
      let schemeGot: { bytes: number; sha256: string } | null = null;
      if (scheme) {
        done++;
        schemeGot = await mirror(
          scheme,
          dir,
          known,
          `  ${String(done).padStart(3)}/${linkCount} ${scheme.file}`,
          stats,
        );
      } else {
        console.log(`      no marking scheme published for the ${paper.language} paper`);
      }

      papers.push({
        subject: row.subject,
        slug,
        class: 10,
        language: paper.language,
        paperFile: paper.file,
        ...(scheme && schemeGot
          ? {
              markingSchemeFile: scheme.file,
              markingSchemeBytes: schemeGot.bytes,
              markingSchemeSha256: schemeGot.sha256,
              markingSchemeUrl: scheme.url,
            }
          : {}),
        bytes: got.bytes,
        sha256: got.sha256,
        ...(NCERT_SUBJECT[row.subject] ? { ncertSubject: NCERT_SUBJECT[row.subject] } : {}),
        paperUrl: paper.url,
      });
    }
    await save();
  }

  // Duration and marks come off the paper itself; do it in one pass at the end
  // so an interrupted download never leaves papers.json half-annotated.
  console.log(`\nReading duration and marks off ${papers.length} papers ...`);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let annotated = 0;
  for (const p of papers) {
    const path = `${OUT_ROOT}/${p.slug}/${p.paperFile}`;
    if (!existsSync(path)) continue;
    try {
      const header = parseHeader(await firstPageText(pdfjs, path));
      if (header.maxMarks !== undefined) p.maxMarks = header.maxMarks;
      if (header.durationMinutes !== undefined) p.durationMinutes = header.durationMinutes;
      if (header.maxMarks !== undefined || header.durationMinutes !== undefined) annotated++;
    } catch {
      // A PDF pdf.js cannot open is not a reason to fail the run; the paper is
      // still mirrored and readable, it just has no timer metadata.
    }
  }
  await save();

  const withScheme = papers.filter((p) => p.markingSchemeFile).length;
  console.log(`\n=== done ===`);
  console.log(`downloaded:      ${stats.downloaded}`);
  console.log(`skipped:         ${stats.skipped}`);
  console.log(`failed:          ${stats.failed}`);
  console.log(`total size:      ${mb(stats.bytes)}`);
  console.log(`papers:          ${papers.length} (${papers.filter((p) => p.language === "hi").length} Hindi)`);
  console.log(`with scheme:     ${withScheme}`);
  console.log(`without scheme:  ${papers.length - withScheme}`);
  console.log(`marks/duration:  ${annotated}`);
  console.log(`linked to a textbook subject: ${papers.filter((p) => p.ncertSubject).length}`);
  console.log(`\nWrote ${PAPERS_JSON}`);
  if (stats.failed > 0) console.log(`Re-run to retry the ${stats.failed} failed file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
