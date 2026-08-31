/**
 * Phase 2, step 1 — mirror every CBSE Class 10 sample question paper and
 * marking scheme, for every session CBSE still publishes.
 *
 * cbseacademic.nic.in is under exactly the same constraint as ncert.nic.in: it
 * serves its PDFs with no Access-Control-Allow-Origin header and with
 * X-Frame-Options: SAMEORIGIN, so a browser cannot fetch them into pdf.js or
 * iframe them cross-origin. Mirroring onto our own origin is the only way the
 * in-app reader and practice mode can open them at all.
 *
 * WHERE THE PAPERS LIVE
 * ---------------------
 * The current session is linked from the home page, but every prior session is
 * reachable only from sqp_archive.html, and the URL pattern changes mid-history:
 * SQP_CLASSX_2015_16.html … SQP_CLASSX_2019_20.html use underscores, and
 * SQP_CLASSX_2020-21.html onwards use a hyphen. Guessing one form for all of
 * them silently loses six sessions, so SESSIONS below is the archive page's own
 * list, transcribed. CBSE's "Additional Practice Questions" — a second full
 * paper plus marking scheme, published for Class X in 2022-23 and 2023-24 — are
 * on a third page again, additionalPQ.html, whose session is encoded only in
 * the href (`.../ClassX_2023_24/Science-PQ.pdf`).
 *
 * CBSE publishes nothing equivalent for Class 9: there is no board exam, and
 * SQP_CLASSIX_*.html, qbclass9.html and the archive page all have no Class IX
 * entry. Class 9 self-checks against the NCERT answer keys instead.
 *
 * The filenames are scraped rather than constructed. CBSE's naming is not
 * regular — `Sci_SQP_II_X.pdf` in 2016-17 became `Science_SQP.pdf` in 2017-18
 * and `Science-SQP.pdf` in 2020-21, some names carry spaces and ampersands, and
 * guessing `Maths-Standard-SQP.pdf` returns a 624-byte HTML error page under a
 * 200. The only reliable source of a paper's URL is the index page's own
 * <a href>. Rows CBSE has commented out (`<!--<tr>...`) are withdrawn subjects
 * and are skipped, the same convention the NCERT catalogue scraper relies on.
 *
 * WHAT IT WRITES
 * --------------
 *   public/papers/<slug>-sqp.pdf, -ms.pdf   the mirror the app serves
 *   data/cbse/index/<session>.html          cached index pages
 *   data/cbse/catalogue.json                every row CBSE lists, fetched or not
 *   data/papers.json                        the app's manifest, merged
 *
 * data/papers.json is *merged*, never rewritten. Its three original entries
 * carry per-question mark grids that a human read off the paper; those fields
 * are copied through untouched and only the derived ones (bytes, sha256, source
 * URLs) are filled in. A wrong mark grid is worse than none, so a paper whose
 * grid cannot be derived and checked is published with `sections: []` and
 * `sectionsDerived: false` rather than a plausible guess — the same rule that
 * leaves 44 chapters titled "Chapter N".
 *
 * Safe to re-run: a mirrored file whose bytes already hash to the sha256
 * recorded in data/papers.json is never re-fetched, so an interrupted run
 * resumes where it stopped. Requests are sequential with a delay — this is a
 * government server, not a CDN.
 *
 *   npx tsx scripts/fetch-papers.ts              mirror and read
 *   npx tsx scripts/fetch-papers.ts --refresh    re-fetch the index pages too
 *   npx tsx scripts/fetch-papers.ts --explain <slug>…   why a grid came out
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fetchWithRetry, sleep, slugify } from "./lib/ncert";

const SITE_BASE = "https://cbseacademic.nic.in/";
const ARCHIVE_URL = `${SITE_BASE}sqp_archive.html`;
const OUT_DIR = "public/papers";
const INDEX_CACHE = "data/cbse/index";
const CATALOGUE_JSON = "data/cbse/catalogue.json";
const PAPERS_JSON = "data/papers.json";
const DELAY_MS = 1000;

/**
 * Transcribed from sqp_archive.html. The session label is ours (hyphenated,
 * matching the existing data/papers.json entries); the path is CBSE's, and the
 * two disagree before 2020-21 — that mismatch is the whole reason this is a
 * table rather than a template string.
 */
const SESSIONS: { session: string; path: string }[] = [
  { session: "2015-16", path: "SQP_CLASSX_2015_16.html" },
  { session: "2016-17", path: "SQP_CLASSX_2016_17.html" },
  { session: "2017-18", path: "SQP_CLASSX_2017_18.html" },
  { session: "2018-19", path: "SQP_CLASSX_2018_19.html" },
  { session: "2019-20", path: "SQP_CLASSX_2019_20.html" },
  { session: "2020-21", path: "SQP_CLASSX_2020-21.html" },
  { session: "2021-22", path: "SQP_CLASSX_2021-22.html" },
  { session: "2022-23", path: "SQP_CLASSX_2022-23.html" },
  { session: "2023-24", path: "SQP_CLASSX_2023-24.html" },
  { session: "2024-25", path: "SQP_CLASSX_2024-25.html" },
  { session: "2025-26", path: "SQP_CLASSX_2025-26.html" },
];

const APQ_PATH = "additionalPQ.html";

/**
 * The subjects this product is for. CBSE lists ~40 rows a session — Bhoti,
 * Carnatic Music (Percussion), Retail, NCC — and none of them has an NCERT
 * textbook in data/manifest.json, so mirroring them would cost bandwidth and
 * shelf space for papers no one here can revise from.
 *
 * `subject` is the canonical spelling; CBSE's own varies ("English (Language &
 * Literature)" vs "English Language & Literature") and the slug must not.
 */
const CORE: { match: RegExp; subject: string; ncertSubject: string }[] = [
  { match: /^science$/, subject: "Science", ncertSubject: "Science" },
  { match: /^mathematics$/, subject: "Mathematics", ncertSubject: "Mathematics" },
  { match: /^mathematics\s*\(\s*basic\s*\)$/, subject: "Mathematics (Basic)", ncertSubject: "Mathematics" },
  { match: /^mathematics\s*\(\s*standard\s*\)$/, subject: "Mathematics (Standard)", ncertSubject: "Mathematics" },
  { match: /^social\s*science$/, subject: "Social Science", ncertSubject: "Social Science" },
  {
    match: /^english\s*\(?\s*language\s*&\s*literature\s*\)?$/,
    subject: "English (Language & Literature)",
    ncertSubject: "English",
  },
];

/**
 * Rows that look core but are a different paper: the Hindi translation, the
 * adapted paper for visually impaired candidates, and English Communicative
 * (a separate elective CBSE withdrew after 2019-20). Each would collide with,
 * or be mistaken for, the paper we do carry.
 */
const NOT_CORE = /visually\s*impaired|\(\s*hindi\s*\)|communicative/i;

/** Several CBSE PDFs use legacy CID fonts; without cmaps extraction is mojibake. */
const FONT_OPTS = {
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  useSystemFonts: true,
} as const;

// --------------------------------------------------------------------------
// data/papers.json — shape shared with src/lib/papers.ts
// --------------------------------------------------------------------------

export type QuestionType = "mcq" | "assertion-reason" | "vsa" | "sa" | "la" | "case-study";

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
  class: 10;
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
  paperSha256?: string;
  schemeSha256?: string;
  /** "sqp" for a sample paper, "apq" for an Additional Practice Questions set. */
  kind?: "sqp" | "apq";
  /** Set when CBSE split the year into two term exams (2021-22 only). */
  term?: 1 | 2;
  /** Where the SQP itself came from, for attribution in the UI. */
  paperUrl?: string;
  schemeUrl?: string;
  /** NCERT subject in data/manifest.json, so a chapter can link to a paper. */
  ncertSubject?: string;
  /**
   * How `sections` was arrived at. Absent means a human read the grid off the
   * paper and checked it, and this script will not touch it. `true` means this
   * script derived and balanced it, and will re-derive it on the next run.
   * `false` means no reading balanced: the paper is still worth mirroring, its
   * marking scheme being the only published answer key for it, but it cannot be
   * self-scored and `sections` is left empty rather than guessed.
   */
  sectionsDerived?: boolean;
  sections: PaperSection[];
}

export interface PapersManifest {
  source: string;
  session: string;
  sessions: string[];
  generatedAt: string;
  papers: Paper[];
}

/** One (session, subject) cell of the matrix, whether or not we fetched it. */
interface CatalogueRow {
  session: string;
  kind: "sqp" | "apq";
  subject: string;
  core: boolean;
  fetched: boolean;
  sqpUrl?: string;
  msUrl?: string;
  note?: string;
}

// --------------------------------------------------------------------------
// index scraping
// --------------------------------------------------------------------------

/** One <a href="…pdf"> found in a table cell. */
interface Link {
  url: string;
  file: string;
}

interface Row {
  subject: string;
  /** Cell pairs: [sqp, ms] per variant. One normally, two in 2021-22. */
  pairs: { sqp: Link[]; ms: Link[] }[];
}

/**
 * How a row's cells map onto (paper, scheme) pairs.
 *
 * The session pages give each a column of its own — Subject | SQP | MS, doubled
 * in 2021-22 for the two terms. additionalPQ.html instead puts both links in one
 * cell and uses the columns for Set 1 and Set 2, so reading it the same way
 * would pair Set 1's paper with Set 2's scheme.
 */
type Pairing = "columns" | "cells";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Subject text reduced to the form CORE matches against. */
function normaliseSubject(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function linksIn(html: string, base: string): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(/href\s*=\s*"([^"]+\.pdf)"/gi)) {
    const url = new URL(m[1].replace(/ /g, "%20"), base).href;
    const file = decodeURIComponent(url.split("/").pop() ?? "");
    // CBSE marks the Hindi translation with a `_hi` suffix and nothing else.
    // The app carries one edition per paper, so the translation is skipped.
    if (/_hi\.pdf$/i.test(file)) continue;
    out.push({ url, file });
  }
  return out;
}

/**
 * Parse an index table into subject rows.
 *
 * The markup is hand-maintained and not well-formed — 2025-26 has a stray
 * unclosed <tr> between the Bhoti and Bhutia rows — so rows are split on the
 * opening tag and any chunk without two usable cells is dropped rather than
 * trusted. Cells after the first come in (paper, scheme) pairs: one pair in a
 * normal year, two in 2021-22 when CBSE examined the year in two terms.
 */
function parseIndex(html: string, base: string, pairing: Pairing = "columns"): Row[] {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  const rows: Row[] = [];

  for (const chunk of live.split(/<tr\b[^>]*>/i).slice(1)) {
    const body = chunk.split(/<\/tr>/i)[0];
    const cells = [...body.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    if (cells.length < 2) continue;

    const subject = cellText(cells[0]);
    if (!subject || /^(subject|class\s+[IXV]+)$/i.test(subject)) continue;

    const pairs: { sqp: Link[]; ms: Link[] }[] = [];
    if (pairing === "cells") {
      for (const cell of cells.slice(1)) {
        const links = linksIn(cell, base);
        if (links.length) pairs.push({ sqp: [links[0]], ms: links.slice(1) });
      }
    } else {
      for (let i = 1; i < cells.length; i += 2) {
        const sqp = linksIn(cells[i], base);
        const ms = i + 1 < cells.length ? linksIn(cells[i + 1], base) : [];
        if (sqp.length) pairs.push({ sqp, ms });
      }
    }
    if (!pairs.length) continue;

    rows.push({ subject, pairs });
  }
  return rows;
}

/**
 * Fetch an index page, caching it under data/cbse/index/.
 *
 * Cached, because re-deriving mark grids means re-running this script and there
 * is no reason to pull twelve pages off a government server each time. CBSE
 * does add subjects to the current session's page after publishing it, so
 * `--refresh` re-fetches them all.
 */
async function indexHtml(name: string, url: string): Promise<string> {
  const path = `${INDEX_CACHE}/${name}.html`;
  if (existsSync(path) && !process.argv.includes("--refresh")) return readFile(path, "utf8");
  const html = await (await fetchWithRetry(url)).text();
  await writeFile(path, html);
  await sleep(DELAY_MS);
  return html;
}

// --------------------------------------------------------------------------
// PDF text: laid-out lines, so the marks column can be told from the body
// --------------------------------------------------------------------------

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** One positioned run of text, as pdf.js emits it. */
interface Item {
  s: string;
  /** Left edge and width in PDF units. */
  x: number;
  w: number;
}

/** One visual line of a page, its items kept in left-to-right order. */
interface Line {
  page: number;
  /** Page width, so a gutter can be expressed as a fraction. */
  pageWidth: number;
  text: string;
  items: Item[];
}

/**
 * Reconstruct a paper's lines from pdf.js text items, keeping x-positions.
 *
 * Reading `getTextContent()` as a flat string loses the one thing these papers
 * encode positionally: CBSE prints each question's mark value in a narrow
 * right-hand column and its number in a narrow left-hand one, and both are
 * separate text runs that the content stream can emit anywhere. Their column is
 * an x-coordinate, not a position in the text, so the coordinate is what gets
 * kept.
 */
async function pageLines(pdfjs: Pdfjs, path: string): Promise<Line[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(path)), ...FONT_OPTS })
    .promise;
  const lines: Line[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const pageWidth = page.getViewport({ scale: 1 }).width;
      const items = (await page.getTextContent()).items
        .flatMap((i) =>
          "str" in i && i.str.trim()
            ? [{ s: i.str.trim(), x: i.transform[4] as number, y: i.transform[5] as number, w: i.width }]
            : [],
        )
        .sort((a, b) => b.y - a.y || a.x - b.x);

      // Cluster into lines: the baselines of one printed row agree to within a
      // few PDF units, while the next row is a whole line-height away.
      let bucket: typeof items = [];
      const flush = () => {
        if (!bucket.length) return;
        const ordered = [...bucket].sort((a, b) => a.x - b.x);
        lines.push({
          page: p,
          pageWidth,
          text: ordered.map((i) => i.s).join(" "),
          items: ordered.map(({ s, x, w }) => ({ s, x, w })),
        });
        bucket = [];
      };
      for (const it of items) {
        if (bucket.length && Math.abs(bucket[0].y - it.y) > 4) flush();
        bucket.push(it);
      }
      flush();
    }
  } finally {
    await doc.destroy();
  }
  return lines;
}

function flatten(lines: Line[]): string {
  return lines
    .map((l) => l.text)
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * Merge runs that print one number as several items — "30" often arrives as
 * "3" then "0" — by joining neighbours with no horizontal gap between them.
 */
function joinAdjacent(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && it.x - (last.x + last.w) < 2) {
      last.s += it.s;
      last.w = it.x + it.w - last.x;
      continue;
    }
    out.push({ ...it });
  }
  return out;
}

/**
 * The x-coordinate of the column a paper prints its per-question marks in.
 *
 * Body text also reaches into the right margin, so "anything on the right" is
 * not a column. What distinguishes the marks column is that it is a *column*:
 * dozens of bare single digits stacked at one repeated x. The modal x of those
 * digits is that column, and null means the paper has no such column at all.
 */
function marksColumn(lines: Line[]): number | null {
  const tally = new Map<number, number>();
  for (const line of lines) {
    for (const it of joinAdjacent(line.items)) {
      if (!/^[1-6]$/.test(it.s) || it.x < line.pageWidth * 0.7) continue;
      const bucket = Math.round(it.x / 4) * 4;
      tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let most = 0;
  for (const [x, n] of tally) {
    if (n > most) {
      most = n;
      best = x;
    }
  }
  return most >= 8 ? best : null;
}

// --------------------------------------------------------------------------
// header: marks, duration, subject code
// --------------------------------------------------------------------------

interface Header {
  durationMinutes?: number;
  maxMarks?: number;
  code?: string;
  questionCount?: number;
}

/**
 * Read the printed maximum, duration, subject code and question count.
 *
 * CBSE phrases each a dozen ways across subjects and decades — "Max. Marks",
 * "Maximum marks:80", "Time Allowed: 3 hours", "Time : 3 hrs", "Code no. 086",
 * "Code - 087" — so each is matched loosely and then sanity-checked. Anything
 * outside a plausible range is discarded and the field left absent: a wrong
 * duration on an exam timer is worse than no timer.
 */
function parseHeader(text: string): Header {
  const out: Header = {};

  // "Max"/"Full"/"Maximum" only, never a bare "Total Marks": some papers print
  // "Total Marks - 34" for one part alone, which is not the paper's maximum.
  // Kerning is the enemy of all of these: the 2022-23 Science paper extracts
  // its maximum as "8 0" and the 2020-21 Mathematics paper writes "Ma x.
  // Marks", so spaces are tolerated inside both the label and the number. The
  // 2018-19 and 2019-20 Science papers abbreviate the label away entirely to
  // "M.M.: 80", which is only safe to match when a separator follows.
  const marks =
    /(?:M\s*a\s*x(?:imum)?\.?|Full)\s*\.?\s*Marks?\s*[:.\-–]?\s*(\d(?:\s?\d)?(?:\s?\d)?)/i.exec(text) ??
    /\bM\.?\s*M\.?\s*[:.\-–]\s*(\d(?:\s?\d)?(?:\s?\d)?)/i.exec(text);
  if (marks) {
    const n = Number(marks[1].replace(/\s/g, ""));
    if (n >= 10 && n <= 100) out.maxMarks = n;
  }

  // Kerning splits "hours" into "h ou rs" on some papers, so the unit is
  // matched letter by letter with optional gaps. "03 Hours" and "3 hrs." and
  // "90 minutes" are all in use, and so is "Duration:" in place of "Time".
  const hours =
    /(?:Time|Duration)\s*(?:Allowed|Duration)?\s*[:.\-–]?\s*(\d{1,2}(?:\.\d)?|\d\s*½)\s*(?:H\s*o\s*u\s*r\s*s?|Hrs?)/i.exec(
      text,
    );
  const mins = /(?:Time|Duration)\s*(?:Allowed|Duration)?\s*[:.\-–]?\s*(\d{2,3})\s*(?:Minutes?|Mins?)/i.exec(
    text,
  );
  let minutes: number | undefined;
  if (hours) minutes = Math.round(parseFloat(hours[1].replace(/\s*[½½]/, ".5")) * 60);
  else if (mins) minutes = Number(mins[1]);
  if (minutes !== undefined && minutes >= 30 && minutes <= 300) out.durationMinutes = minutes;

  const code = /Code\s*(?:No\.?|Number)?\s*[:.\-–]?\s*(\d{3})\b/i.exec(text);
  if (code) out.code = code[1];

  const count =
    /(?:contains|consists\s*of|comprises\s*of|comprises|has|are)\s*(\d{1,2})\s*questions/i.exec(text);
  if (count) {
    const n = Number(count[1]);
    if (n >= 5 && n <= 60) out.questionCount = n;
  }

  return out;
}

// --------------------------------------------------------------------------
// sections: derived from the paper, then checked before it is believed
// --------------------------------------------------------------------------

/**
 * CBSE's mark-to-form convention, uniform across Class 10 since 2019-20:
 * 1 mark objective, 2 very short answer, 3 short answer, 4 case study, 5 long
 * answer. It is a mapping, not a guess — but it is only ever applied to a mark
 * value actually printed on the paper, never to invent one.
 */
function typeForMarks(marks: number): QuestionType {
  if (marks <= 1) return "mcq";
  if (marks === 2) return "vsa";
  if (marks === 3) return "sa";
  if (marks === 4) return "case-study";
  return "la";
}

/** Per-question reading before it is folded into ranges. */
interface QMark {
  n: number;
  marks: number;
  label: string;
  topic?: string;
  type: QuestionType;
}

/**
 * Fold consecutive questions sharing a section, mark value and form into the
 * contiguous ranges data/papers.json records.
 */
function toSections(qs: QMark[]): PaperSection[] {
  const out: PaperSection[] = [];
  for (const q of qs) {
    const last = out[out.length - 1];
    if (
      last &&
      last.to === q.n - 1 &&
      last.label === q.label &&
      last.topic === q.topic &&
      last.marksEach === q.marks &&
      last.type === q.type
    ) {
      last.to = q.n;
      continue;
    }
    out.push({
      label: q.label,
      ...(q.topic ? { topic: q.topic } : {}),
      from: q.n,
      to: q.n,
      marksEach: q.marks,
      type: q.type,
    });
  }
  return out;
}

/**
 * Every way a derived grid can be wrong — the same arithmetic src/lib/papers.ts
 * runs before it will score against one. A grid that does not cover 1..N once
 * each and does not total the paper's printed maximum is thrown away.
 */
function checkSections(sections: PaperSection[], questionCount: number, maxMarks: number): boolean {
  if (!sections.length) return false;
  let expected = 1;
  for (const s of [...sections].sort((a, b) => a.from - b.from)) {
    if (s.from !== expected || s.to < s.from || s.marksEach <= 0) return false;
    expected = s.to + 1;
  }
  if (expected - 1 !== questionCount) return false;
  const total = sections.reduce((sum, s) => sum + (s.to - s.from + 1) * s.marksEach, 0);
  return total === maxMarks;
}

/**
 * "Section A is Biology, Section B is Chemistry and Section C is Physics."
 *
 * A topic is the discipline a section covers, and only some papers divide
 * themselves that way. The same punctuation introduces a section's *contents* —
 * "Section B – Question no. 21 to 24 are Very Short Answer Type Questions" —
 * which is not a topic, so anything reading as a description of questions
 * rather than of a subject is dropped. An absent topic is correct for most
 * papers; a wrong one would mislabel every question in the section.
 */
const NOT_A_TOPIC = /question|answer|mark|type|based|carrying|following|section|^(?:of|the|is|from|no)$/i;

function sectionTopics(text: string): Map<string, string> {
  const topics = new Map<string, string>();
  for (const m of text.matchAll(
    /Section\s*[-–—]?\s*([A-F])\b\s*(?:is|[-–—:])\s*([A-Z][A-Za-z ]{2,24}?)(?=\s*(?:,|\.|and\b|Section\b|\(|$))/g,
  )) {
    const topic = m[2].trim().replace(/\s+/g, " ");
    if (!NOT_A_TOPIC.test(topic) && !topics.has(m[1])) topics.set(m[1], topic);
  }
  return topics;
}

/** What a paper's layout yields: one row per line, in reading order. */
interface Scan {
  /** Marks printed in the marks column on this line, if any. */
  mark?: number;
  /** Question number printed in the left gutter, if any, and its column. */
  qNumber?: number;
  qColumn?: number;
  /** Section heading this line declares, if any. */
  section?: string;
  text: string;
}

function scanLayout(lines: Line[], marksCol: number): Scan[] {
  return lines.map((line) => {
    const items = joinAdjacent(line.items);
    const row: Scan = { text: line.text };

    const mark = items.find((i) => Math.abs(i.x - marksCol) <= 6 && /^[1-6]$/.test(i.s));
    if (mark) row.mark = Number(mark.s);

    const head = /^(?:SECTION|Section)\s*[-–—:]?\s*([A-E])\b/.exec(line.text.replace(/\s+/g, " "));
    if (head) row.section = head[1];

    const lead = items[0];
    if (lead && lead.x < line.pageWidth * 0.22) {
      const q = /^Q?\.?\s*(\d{1,2})\s*[.)]?$/.exec(lead.s);
      if (q) {
        row.qNumber = Number(q[1]);
        row.qColumn = Math.round(lead.x / 6) * 6;
      }
    }
    return row;
  });
}

/**
 * Read the mark grid off the paper's own layout.
 *
 * Two independent readings are offered, because CBSE prints the grid two ways:
 *
 *   "ordinal"   the marks column has exactly one entry per question, so the
 *               n-th value down the page is question n's. True of the Science
 *               papers, where no question has sub-parts printed separately.
 *   "spanned"   questions are found first, by their numbers in the left gutter,
 *               and each takes the marks printed inside it. A case-study
 *               question prints its sub-part marks (1, 1, 2) as well as, or
 *               instead of, its total, so both the first value and the sum are
 *               offered as readings.
 *
 * Numbers in the left gutter are ambiguous — an option label ("2. A-4, B-1")
 * inside a table looks exactly like question 2 — so a run is accepted only if
 * it sits in one repeated x-column and counts 1..N in strict ascending order.
 * Every column found is tried; a wrong one produces a short or broken run and
 * is discarded by `checkSections` downstream.
 */
function gridsFromLayout(lines: Line[], count?: number): QMark[][] {
  const marksCol = marksColumn(lines);
  if (marksCol === null) return [];
  const scan = scanLayout(lines, marksCol);
  const topics = sectionTopics(flatten(lines.slice(0, 40)));
  const grids: QMark[][] = [];

  const label = (i: number): string => {
    for (let j = i; j >= 0; j--) if (scan[j].section) return scan[j].section as string;
    return "A";
  };

  const build = (spans: { n: number; from: number; to: number }[], pick: "first" | "sum") => {
    const out: QMark[] = [];
    for (const span of spans) {
      const found = scan
        .slice(span.from, span.to)
        .flatMap((r) => (r.mark === undefined ? [] : [r.mark]));
      if (!found.length) return;
      const value = pick === "first" ? found[0] : found.reduce((a, b) => a + b, 0);
      if (value < 1 || value > 6) return;
      const body = scan
        .slice(span.from, span.to)
        .map((r) => r.text)
        .join(" ");
      const lbl = label(span.from);
      out.push({
        n: span.n,
        marks: value,
        label: lbl,
        topic: topics.get(lbl),
        type:
          value === 1 && /Assertion/i.test(body) && /Reason/i.test(body)
            ? "assertion-reason"
            : typeForMarks(value),
      });
    }
    grids.push(out);
  };

  // Ordinal: one printed mark per question, in order.
  const marked = scan.flatMap((r, i) => (r.mark === undefined ? [] : [i]));
  if (count === undefined || marked.length === count) {
    build(
      marked.map((at, i) => ({ n: i + 1, from: at, to: marked[i + 1] ?? scan.length })),
      "first",
    );
  }

  // Spanned: questions located by their numbers in the left gutter. Their
  // column is tried both narrowly (one x, which separates a real question
  // number from an option label indented beside it) and across the whole
  // gutter, because the numbers drift left as they gain a digit.
  const columns = new Set(scan.flatMap((r) => (r.qColumn === undefined ? [] : [r.qColumn])));
  for (const col of [...columns, null]) {
    for (const after of [0, scan.findIndex((r) => r.section !== undefined)]) {
      if (after < 0) continue;
      const spans: { n: number; from: number; to: number }[] = [];
      scan.forEach((r, i) => {
        if (i < after) return;
        if ((col === null || r.qColumn === col) && r.qNumber === spans.length + 1) {
          spans.push({ n: r.qNumber, from: i, to: scan.length });
        }
      });
      if (!spans.length || (count !== undefined && spans.length !== count)) continue;
      for (let i = 0; i < spans.length - 1; i++) spans[i].to = spans[i + 1].from;
      build(spans, "first");
      build(spans, "sum");
    }
  }

  return grids;
}

/**
 * The General Instructions block, split into its numbered items.
 *
 * The block ends where the paper starts, at its first section heading — take a
 * fixed number of characters instead and the option labels of question 1 ("a)
 * xy b) xy 2") arrive as instructions. The heading is matched case-sensitively,
 * on "SECTION": an instruction item mentions "Section A" in prose all the time,
 * and cutting there would throw away everything the paper says about itself.
 *
 * CBSE numbers the items "1." in some years, "i." in others and "(i)" in others
 * again, and an item that is not split off carries its neighbour's mark value
 * into the reading, so all three forms are recognised.
 */
const ROMAN = "i{1,3}|iv|vi{0,3}|ix|xi{0,2}";

function instructionItems(text: string): { body: string; items: string[] } | null {
  const start = /General\s*Instructions?/i.exec(text);
  if (!start) return null;
  const from = text.slice(start.index);
  const end = /\bSECTION\s*[-–—:]?\s*A\b/.exec(from.slice(200));
  const body = from.slice(0, end ? end.index + 200 : 3500);
  const items = body.split(
    new RegExp(`(?:^|\\s)(?:\\(\\s*(?:\\d{1,2}|${ROMAN})\\s*\\)|(?:\\d{1,2}|${ROMAN})\\.)\\s+`, "gi"),
  );
  return { body, items };
}

/**
 * A mark value stated in a clause. "carrying 03 marks each" and "of 1 mark
 * each" are explicit; "(04 marks each)" states it with only a bracket, so a
 * bare "N marks" is accepted too — but only as a fallback, because a bare match
 * would otherwise prefer the "1/2/3 marks" of a case study's sub-parts to the
 * "04 marks" of the question itself.
 */
const WORD_NUMBER: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const NUMBER = `0?\\d|${Object.keys(WORD_NUMBER).join("|")}`;

function clauseMarks(text: string): number | null {
  const m =
    new RegExp(`(?:carrying|worth|each\\s*of|of)\\s*(${NUMBER})\\s*marks?`, "i").exec(text) ??
    new RegExp(`(${NUMBER})\\s*marks?\\b`, "i").exec(text);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const n = WORD_NUMBER[word] ?? Number(word);
  return n >= 1 && n <= 6 ? n : null;
}

/**
 * The form named in a clause, falling back to CBSE's mark convention.
 *
 * Order matters where a clause names two forms at once: "Section A … contains
 * multiple choice questions (MCQs), very short answer questions and assertion -
 * reason type questions" is a section of mostly MCQs, so the broadest form
 * named wins over the narrowest.
 */
function clauseType(text: string, marks: number): QuestionType {
  if (/case\s*[- ]?\s*based|case\s*[- ]?\s*stud|source\s*[- ]?\s*based|passage\s*[- ]?\s*based/i.test(text))
    return "case-study";
  if (/multiple\s*choice|\bMCQ/i.test(text)) return "mcq";
  if (/assertion/i.test(text)) return "assertion-reason";
  if (/very\s*short|\bVSA\b/i.test(text)) return "vsa";
  if (/long\s*answer|\bLA\b/i.test(text)) return "la";
  if (/short\s*answer|\bSA\b/i.test(text)) return "sa";
  return typeForMarks(marks);
}

/**
 * Read the mark grid off General Instructions that state question *ranges*.
 *
 * Most papers describe themselves exactly — "Section C contains Q.25 to Q.29
 * are Short Answer Type Questions, carrying 3 marks each" — which is a better
 * source than the layout, being prose CBSE wrote rather than a column inferred
 * from coordinates. The phrasing drifts year to year ("Question numbers 21 -
 * 25", "From questions 1 to 20", "Question no. 37 is map based"), so a range is
 * located first and the form and mark value read from the text that follows it,
 * up to wherever the next range begins.
 */
function gridFromInstructions(text: string): QMark[] | null {
  const parsed = instructionItems(text);
  if (!parsed) return null;
  const topics = sectionTopics(parsed.body);
  const byQuestion = new Map<number, QMark>();

  for (const item of parsed.items) {
    const sec = /(?:In\s+)?Section\s*[-–—]?\s*([A-F])\b/i.exec(item);
    if (!sec) continue;
    const label = sec[1].toUpperCase();
    const fallback = clauseMarks(item);

    // Ranges first, then the lone "Question no. 37 is …" that Social Science
    // uses for its single map question.
    const spans = [
      ...item.matchAll(/(\d{1,2})\s*(?:-|–|—|to)\s*(?:Q\.?\s*|no\.?\s*)?(\d{1,2})\b/gi),
      ...item.matchAll(/no\.?\s*(\d{1,2})\s*and\s*(\d{1,2})\b/gi),
      ...item.matchAll(/(?:Question|Q)\.?\s*(?:no\.?)?\s*(\d{1,2})()\s+is\b/gi),
    ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    spans.forEach((span, i) => {
      const from = Number(span[1]);
      const to = span[2] === "" ? from : Number(span[2]);
      if (from < 1 || to < from || to > 60) return;
      const after = item.slice((span.index ?? 0) + span[0].length, spans[i + 1]?.index ?? undefined);
      const marks = clauseMarks(after) ?? fallback;
      if (marks === null) return;
      for (let n = from; n <= to; n++) {
        if (!byQuestion.has(n)) {
          byQuestion.set(n, { n, marks, label, topic: topics.get(label), type: clauseType(after, marks) });
        }
      }
    });
  }

  return sequence(byQuestion);
}

/**
 * Read the mark grid off General Instructions that state question *counts*.
 *
 * The Science papers never number their sections' questions — "Section A would
 * have 16 simple/complex MCQs and 04 Assertion - Reasoning type questions
 * carrying 1 mark each" — so the ranges have to be accumulated in the order the
 * sections are declared. This is also the only reading that can supply the
 * question count for a paper whose header never prints one.
 */
function gridFromCounts(text: string): QMark[] | null {
  const parsed = instructionItems(text);
  if (!parsed) return null;
  const topics = sectionTopics(parsed.body);
  const out: QMark[] = [];
  let n = 0;

  const HAS = "would\\s*have|will\\s*have|has|have|contains?|comprises|consists\\s*of|includes?";

  for (const item of parsed.items) {
    const sec = new RegExp(`Section\\s*[-–—]?\\s*([A-F])\\b\\s*(?:${HAS})`, "i").exec(item);
    if (!sec) continue;
    const label = sec[1].toUpperCase();
    // A range-stating paper must not be read this way as well: "Questions 21 -
    // 25" would be counted as 21 questions. Only a range of *question numbers*
    // disqualifies it — "in the range of 30 to 50 words" is a word limit.
    if (/(?:questions?|Q)\.?\s*(?:nos?\.?|numbers?)?\s*\d{1,2}\s*(?:-|–|—|to)\s*\d{1,2}/i.test(item))
      return null;
    const fallback = clauseMarks(item);

    for (const clause of item.split(/\band\b/i)) {
      // "… and 04 Assertion - Reasoning type questions" continues the previous
      // clause's verb, so a clause may open with its own count. It still has to
      // be a count of *something*: " 2 marks each respectively" is the tail of
      // a case study's sub-part list, not two more questions.
      const count =
        new RegExp(`(?:${HAS})\\s*(?:of\\s*)?0?(\\d{1,2})\\b`, "i").exec(clause) ??
        (/questions?|MCQ|units?/i.test(clause)
          ? /^\s*0?(\d{1,2})\s+(?!marks?\b)\D/.exec(clause)
          : null);
      if (!count) continue;
      const total = Number(count[1]);
      if (total < 1 || total > 40) continue;
      const marks = clauseMarks(clause.slice(count.index)) ?? fallback;
      if (marks === null) continue;
      const type = clauseType(clause, marks);
      for (let i = 0; i < total; i++) {
        n++;
        out.push({ n, marks, label, topic: topics.get(label), type });
      }
    }
  }
  return out.length ? out : null;
}

/** A map of question number to reading, as a dense 1..N array, or null. */
function sequence(byQuestion: Map<number, QMark>): QMark[] | null {
  const last = Math.max(0, ...byQuestion.keys());
  if (!last) return null;
  const out: QMark[] = [];
  for (let n = 1; n <= last; n++) {
    const q = byQuestion.get(n);
    if (!q) return null;
    out.push(q);
  }
  return out;
}

/**
 * Best checked grid for a paper, or [] when no reading balances.
 *
 * Four readings are offered — the paper's stated ranges, its stated counts, and
 * the two ways its printed marks column can be attributed — and every one of
 * them has to survive `checkSections` against the maximum printed on the paper
 * before it is believed. That check is what makes this safe to run unattended:
 * a reading that mis-attributes a single mark no longer totals 80, and is
 * dropped rather than published as if it had been verified.
 */
function deriveSections(lines: Line[], header: Header): PaperSection[] {
  if (!header.maxMarks) return [];
  const text = flatten(lines);
  const count = header.questionCount;

  // "Section A consists of 20 questions of 1 mark each. Attempt any 16." The
  // 2021-22 term papers print more questions than they mark, so no contiguous
  // range of question numbers describes what a student is scored on, and a
  // reading that balances does so by coincidence. Refuse them outright.
  if (/attempt\s+any\s+\d/i.test(text)) return [];

  const candidates: QMark[][] = [];
  for (const grid of [gridFromInstructions(text), gridFromCounts(text)]) {
    if (grid) candidates.push(grid);
  }
  candidates.push(...gridsFromLayout(lines, count));

  // The printed question count is a preference, not a filter. It is itself only
  // a regex reading of the paper's prose and is sometimes wrong, and the marks
  // arithmetic in `checkSections` is the far stronger check — so a grid that
  // agrees with it is tried first, and one that disagrees is still tried.
  const ranked =
    count === undefined
      ? candidates
      : [...candidates].sort(
          (a, b) => Number(b.length === count) - Number(a.length === count),
        );

  const seen = new Set<string>();
  for (const grid of ranked) {
    const key = grid.map((q) => `${q.label}${q.marks}${q.type}`).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const sections = toSections(grid);
    if (checkSections(sections, grid.length, header.maxMarks)) return sections;
  }
  return [];
}

// --------------------------------------------------------------------------
// mirroring
// --------------------------------------------------------------------------

interface Stats {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
}

/**
 * Fetch one PDF to `OUT_DIR/<name>` unless we already hold it.
 *
 * A file already on disk is re-hashed and kept when it matches what
 * data/papers.json recorded (or when nothing was recorded and it is a valid
 * PDF), which is what makes the run resumable. A failure is logged and the run
 * continues: one dead link must not lose the batch.
 */
async function mirror(
  link: Link,
  name: string,
  known: string | undefined,
  prefix: string,
  stats: Stats,
): Promise<{ bytes: number; sha256: string } | null> {
  const path = `${OUT_DIR}/${name}`;

  if (existsSync(path)) {
    const buf = await readFile(path);
    if (buf.subarray(0, 5).toString("latin1") === "%PDF-" && (!known || known === sha256(buf))) {
      stats.skipped++;
      stats.bytes += buf.byteLength;
      console.log(`${prefix}  ${known ? "skip" : "adopt"} (${mb(buf.byteLength)})`);
      return { bytes: buf.byteLength, sha256: sha256(buf) };
    }
  }

  try {
    const res = await fetchWithRetry(link.url);
    if (res.status === 404) {
      stats.failed++;
      console.log(`${prefix}  MISSING (404)`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());

    // CBSE answers a bad path with a 624-byte HTML error page under a 200
    // status, so the magic bytes are the only trustworthy check.
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

/** A (session, subject, variant) triple resolved to two URLs. */
interface Target {
  session: string;
  subject: string;
  ncertSubject: string;
  kind: "sqp" | "apq";
  term?: 1 | 2;
  /** Distinguishes the second APQ set from the first. */
  set?: number;
  sqp: Link;
  ms?: Link;
}

function slugFor(t: Target): string {
  const parts = ["class10", slugify(t.subject), t.session];
  if (t.kind === "apq") parts.push("apq");
  if (t.set && t.set > 1) parts.push(`set${t.set}`);
  if (t.term) parts.push(`term${t.term}`);
  return parts.join("-");
}

function titleFor(t: Target): string {
  const base = t.kind === "apq" ? "Additional Practice Questions" : "Sample Question Paper";
  const suffix = t.term ? ` (Term ${t.term})` : t.set && t.set > 1 ? ` (Set ${t.set})` : "";
  return `${t.subject} — ${base}${suffix}`;
}

/** Collect the fetchable core papers from one session's index page. */
function targetsFrom(rows: Row[], session: string, cat: CatalogueRow[]): Target[] {
  const targets: Target[] = [];
  for (const row of rows) {
    const norm = normaliseSubject(row.subject);
    const core = NOT_CORE.test(row.subject) ? undefined : CORE.find((c) => c.match.test(norm));
    const multiTerm = row.pairs.length > 1;

    row.pairs.forEach((pair, i) => {
      const term = multiTerm ? ((i + 1) as 1 | 2) : undefined;
      cat.push({
        session,
        kind: "sqp",
        subject: core?.subject ?? row.subject,
        core: Boolean(core),
        fetched: Boolean(core),
        sqpUrl: pair.sqp[0]?.url,
        msUrl: pair.ms[0]?.url,
        ...(term ? { note: `Term ${term}` } : {}),
      });
      if (!core) return;
      targets.push({
        session,
        subject: core.subject,
        ncertSubject: core.ncertSubject,
        kind: "sqp",
        term,
        sqp: pair.sqp[0],
        ms: pair.ms[0],
      });
    });
  }
  return targets;
}

/**
 * Collect the core papers from additionalPQ.html.
 *
 * That page interleaves Class X and Class XII and never says which session a
 * row belongs to; the only statement of either is the href
 * (`web_material/SQP/ClassX_2023_24/Science-PQ.pdf`), so both are read from it.
 */
function apqTargetsFrom(rows: Row[], cat: CatalogueRow[]): Target[] {
  const targets: Target[] = [];
  for (const row of rows) {
    const norm = normaliseSubject(row.subject);
    const core = NOT_CORE.test(row.subject) ? undefined : CORE.find((c) => c.match.test(norm));

    row.pairs.forEach((pair, i) => {
      const dir = /Class(X|XII)_(\d{4})_(\d{2})/.exec(pair.sqp[0].url);
      if (!dir || dir[1] !== "X") return; // Class XII rows share the table
      const session = `${dir[2]}-${dir[3]}`;
      const set = i + 1;
      cat.push({
        session,
        kind: "apq",
        subject: core?.subject ?? row.subject,
        core: Boolean(core),
        fetched: Boolean(core),
        sqpUrl: pair.sqp[0].url,
        msUrl: pair.ms[0]?.url,
        ...(set > 1 ? { note: `Set ${set}` } : {}),
      });
      if (!core) return;
      targets.push({
        session,
        subject: core.subject,
        ncertSubject: core.ncertSubject,
        kind: "apq",
        set,
        sqp: pair.sqp[0],
        ms: pair.ms[0],
      });
    });
  }
  return targets;
}

// --------------------------------------------------------------------------

/**
 * `--explain <slug>` — why one paper's mark grid did or did not come out.
 *
 * Curating a grid by hand costs an hour a paper, so it is worth knowing whether
 * the reading failed on the question count, the marks column, or the arithmetic
 * before reaching for the PDF. Prints nothing the run itself relies on.
 */
async function explain(slug: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const path = `${OUT_DIR}/${slug}-sqp.pdf`;
  const lines = await pageLines(pdfjs, path);
  const flat = flatten(lines);
  const header = parseHeader(flat.slice(0, 4000));
  console.log(`${slug}`);
  console.log(`  header:       ${JSON.stringify(header)}`);
  const col = marksColumn(lines);
  console.log(`  marks column: ${col}`);
  if (col !== null) {
    const scan = scanLayout(lines, col);
    const cols = new Map<number, number[]>();
    for (const r of scan) {
      if (r.qColumn === undefined || r.qNumber === undefined) continue;
      cols.set(r.qColumn, [...(cols.get(r.qColumn) ?? []), r.qNumber]);
    }
    console.log(`  marks in column: ${scan.filter((r) => r.mark !== undefined).length}`);
    for (const [x, ns] of cols) console.log(`  gutter x=${x}: ${ns.join(",")}`);
  }
  if (!header.maxMarks) {
    console.log(`  first 600 chars: ${flat.slice(0, 600)}`);
    return;
  }
  const grids = [
    ["ranges", gridFromInstructions(flat)] as const,
    ["counts", gridFromCounts(flat)] as const,
    ...gridsFromLayout(lines, header.questionCount).map((g, i) => [`layout ${i}`, g] as const),
  ];
  for (const [name, grid] of grids) {
    if (!grid) {
      console.log(`  ${name}: no reading`);
      continue;
    }
    const total = grid.reduce((n, q) => n + q.marks, 0);
    const sections = toSections(grid);
    console.log(
      `  ${name}: ${grid.length} questions, ${total} marks, ` +
        `${checkSections(sections, grid.length, header.maxMarks) ? "balances" : "REJECTED"} ` +
        `— ${sections.map((s) => `${s.label}:${s.from}-${s.to}@${s.marksEach}${s.type[0]}`).join(" ")}`,
    );
  }
}

async function main() {
  const explainAt = process.argv.indexOf("--explain");
  if (explainAt !== -1) {
    for (const slug of process.argv.slice(explainAt + 1)) await explain(slug);
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(INDEX_CACHE, { recursive: true });

  // Existing entries carry hand-checked mark grids. They are the starting point
  // and are never overwritten, only completed.
  const previous = new Map<string, Paper>();
  if (existsSync(PAPERS_JSON)) {
    const prev = JSON.parse(await readFile(PAPERS_JSON, "utf8")) as PapersManifest;
    for (const p of prev.papers) previous.set(p.slug, p);
  }

  const catalogue: CatalogueRow[] = [];
  const targets: Target[] = [];

  for (const s of SESSIONS) {
    const url = `${SITE_BASE}${s.path}`;
    const html = await indexHtml(s.session, url);
    const rows = parseIndex(html, url);
    const found = targetsFrom(rows, s.session, catalogue);
    console.log(`${s.session}: ${rows.length} subject rows, ${found.length} core papers`);
    targets.push(...found);
  }

  const apqUrl = `${SITE_BASE}${APQ_PATH}`;
  const apqRows = parseIndex(await indexHtml("additionalPQ", apqUrl), apqUrl, "cells");
  const apq = apqTargetsFrom(apqRows, catalogue);
  console.log(`additional practice: ${apqRows.length} rows, ${apq.length} core Class X papers`);
  targets.push(...apq);

  const stats: Stats = { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
  const papers: Paper[] = [];
  let done = 0;

  const save = async () => {
    const merged = new Map(papers.map((p) => [p.slug, p]));
    for (const [slug, p] of previous) if (!merged.has(slug)) merged.set(slug, p);
    const all = [...merged.values()].sort(
      (a, b) => b.session.localeCompare(a.session) || a.slug.localeCompare(b.slug),
    );
    await writeFile(
      PAPERS_JSON,
      `${JSON.stringify(
        {
          source: ARCHIVE_URL,
          session: all[0]?.session ?? "2025-26",
          sessions: [...new Set(all.map((p) => p.session))].sort().reverse(),
          generatedAt: new Date().toISOString(),
          papers: all,
        } satisfies PapersManifest,
        null,
        2,
      )}\n`,
    );
  };

  /**
   * A previous entry whose mark grid a human curated. Everything else this
   * script wrote about a paper it is free to write again — but a hand-checked
   * grid, and the marks and duration that were checked alongside it, are the
   * one thing it must never overwrite.
   */
  const curated = (slug: string): Paper | undefined => {
    const old = previous.get(slug);
    return old && old.sections.length > 0 && old.sectionsDerived !== true ? old : undefined;
  };

  console.log(`\nMirroring ${targets.length} papers ...`);
  for (const t of targets) {
    const slug = slugFor(t);
    const old = curated(slug);
    done++;
    const prefix = `  ${String(done).padStart(3)}/${targets.length} ${slug}`;
    const held = previous.get(slug);

    const paperGot = await mirror(t.sqp, `${slug}-sqp.pdf`, held?.paperSha256, `${prefix} sqp`, stats);
    if (!paperGot) continue;

    let schemeGot: { bytes: number; sha256: string } | null = null;
    if (t.ms) {
      schemeGot = await mirror(t.ms, `${slug}-ms.pdf`, held?.schemeSha256, `${prefix} ms `, stats);
    } else {
      console.log(`${prefix} ms   none published`);
    }

    papers.push({
      slug,
      class: 10,
      subject: t.subject,
      ...(old?.code ? { code: old.code } : {}),
      title: old?.title ?? titleFor(t),
      session: t.session,
      durationMinutes: old?.durationMinutes ?? 0,
      maxMarks: old?.maxMarks ?? 0,
      questionCount: old?.questionCount ?? 0,
      paperFile: `${slug}-sqp.pdf`,
      schemeFile: schemeGot ? `${slug}-ms.pdf` : "",
      paperBytes: paperGot.bytes,
      paperSha256: paperGot.sha256,
      ...(schemeGot ? { schemeBytes: schemeGot.bytes, schemeSha256: schemeGot.sha256 } : {}),
      kind: t.kind,
      ...(t.term ? { term: t.term } : {}),
      paperUrl: t.sqp.url,
      ...(t.ms ? { schemeUrl: t.ms.url } : {}),
      ncertSubject: t.ncertSubject,
      sections: old?.sections ?? [],
      ...(old ? {} : { sectionsDerived: false }),
    });
    await save();
  }

  // Marks, duration and the question grid come off the paper itself. Done in
  // one pass at the end so an interrupted download never leaves data/papers.json
  // half-annotated.
  console.log(`\nReading ${papers.length} papers ...`);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const noText: string[] = [];
  let derived = 0;

  for (const p of papers) {
    const path = `${OUT_DIR}/${p.paperFile}`;
    if (!existsSync(path)) continue;
    try {
      const lines = await pageLines(pdfjs, path);
      const flat = flatten(lines);
      if (flat.replace(/[^A-Za-z]/g, "").length < 200) noText.push(p.paperFile);

      const header = parseHeader(flat.slice(0, 4000));
      if (!p.code && header.code) p.code = header.code;
      if (!p.maxMarks && header.maxMarks) p.maxMarks = header.maxMarks;
      if (!p.durationMinutes && header.durationMinutes) p.durationMinutes = header.durationMinutes;
      if (!p.questionCount && header.questionCount) p.questionCount = header.questionCount;

      // A hand-checked grid is authoritative; never re-derive over one.
      if (curated(p.slug)) {
        derived++;
        continue;
      }
      const sections = deriveSections(lines, {
        ...header,
        maxMarks: p.maxMarks || header.maxMarks,
        questionCount: p.questionCount || header.questionCount,
      });
      if (sections.length) {
        p.sections = sections;
        p.questionCount = sections[sections.length - 1].to;
        p.sectionsDerived = true;
        derived++;
      }
    } catch (err) {
      console.log(`  ${p.paperFile}: unreadable (${(err as Error).message})`);
      noText.push(p.paperFile);
    }
  }

  // A marking scheme with no text layer is a scan: still worth mirroring, but
  // nothing downstream can search or extract an answer key from it.
  console.log(`\nChecking marking schemes for a text layer ...`);
  for (const p of papers) {
    if (!p.schemeFile) continue;
    const path = `${OUT_DIR}/${p.schemeFile}`;
    if (!existsSync(path)) continue;
    try {
      const flat = flatten(await pageLines(pdfjs, path));
      if (flat.replace(/[^A-Za-z]/g, "").length < 200) noText.push(p.schemeFile);
    } catch {
      noText.push(p.schemeFile);
    }
  }

  await save();
  await writeFile(
    CATALOGUE_JSON,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: ARCHIVE_URL,
        note: "Every Class 10 row CBSE publishes, core or not. `fetched` marks the ones mirrored into public/papers.",
        rows: catalogue,
      },
      null,
      2,
    )}\n`,
  );

  const scored = papers.filter((p) => p.sections.length);
  const questions = scored.reduce(
    (n, p) => n + p.sections.reduce((m, s) => m + (s.to - s.from + 1), 0),
    0,
  );

  console.log(`\n=== done ===`);
  console.log(`downloaded:       ${stats.downloaded}`);
  console.log(`skipped:          ${stats.skipped}`);
  console.log(`failed:           ${stats.failed}`);
  console.log(`total size:       ${mb(stats.bytes)}`);
  console.log(`papers:           ${papers.length}`);
  console.log(`with a scheme:    ${papers.filter((p) => p.schemeFile).length}`);
  console.log(`with a mark grid: ${derived} (${questions} questions)`);
  console.log(`catalogue rows:   ${catalogue.length}`);
  if (noText.length) {
    console.log(`\nno text layer (image-only scans), ${noText.length}:`);
    for (const f of noText) console.log(`  ${f}`);
  }
  const ungraded = papers.filter((p) => !p.sections.length).map((p) => p.slug);
  if (ungraded.length) {
    console.log(`\nno derivable mark grid, ${ungraded.length}:`);
    for (const s of ungraded) console.log(`  ${s}`);
  }
  if (stats.failed) console.log(`\nRe-run to retry the ${stats.failed} failed file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
