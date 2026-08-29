/**
 * Phase 1, step 2 — turn the CBSE curriculum PDFs into data/syllabus.json.
 *
 * A student working chapters 1 -> 13 in order is optimising nothing. The
 * curriculum documents say what each unit is actually worth in the board exam,
 * and that number is what the app needs in order to rank chapters by marks
 * instead of by position.
 *
 * Two problems have to be solved here:
 *
 *   1. The weightage lives in a table (Unit | Unit Name | Marks) and CBSE ships
 *      it as a PDF. Flattened page text keeps the reading order of those tables
 *      well enough to parse, but words are routinely split mid-token
 *      ("COORDINA TE GEOMETRY", "COURSE S TRUCTURE"), so every anchor and every
 *      comparison here is whitespace-insensitive rather than literal.
 *
 *   2. A unit is not a chapter. CBSE names units thematically ("Effects of
 *      Current") and lists the topics inside them; NCERT names chapters
 *      ("Electricity", "Magnetic Effects of Electric Current"). Chapters are
 *      therefore matched against the *body* of each unit: first by exact
 *      topic-title match, and only then by a weighted token overlap that has to
 *      produce a clear single winner.
 *
 * Nothing is guessed. A unit whose marks cannot be read is dropped, a chapter
 * that does not clearly belong to one unit is left unmapped, and both are
 * reported at the end — the same rule that leaves 44 chapter titles as
 * "Chapter N" rather than inventing them. The per-subject summary also checks
 * the extracted marks against the total the document itself states.
 *
 *   npx tsx scripts/build-syllabus.ts            # normal run
 *   npx tsx scripts/build-syllabus.ts --verbose  # show every mapping decision
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Book, Manifest } from "./lib/ncert";

const CURRICULUM_DIR = "data/curriculum";
const OUT = "data/syllabus.json";
const BASE = "https://cbseacademic.nic.in/web_material/CurriculumMain26/Sec";

const VERBOSE = process.argv.includes("--verbose");

/**
 * Several CBSE PDFs use legacy CID font encodings. Without pdf.js's cmap
 * tables and standard font data, extraction returns mojibake for them.
 */
const FONT_OPTS = {
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  useSystemFonts: true,
} as const;

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** A unit that spans more than one book, e.g. English literature. */
export interface UnitBook {
  bookCode: string;
  chapters: number[];
}

export interface Unit {
  /** Unit name as printed in the curriculum document. */
  name: string;
  /** Marks the annual/board examination allots to this unit. */
  marks: number;
  /** Set when the unit maps onto exactly one book in data/manifest.json. */
  bookCode?: string;
  /** Chapter numbers within `bookCode`. Empty when the unit could not be mapped. */
  chapters: number[];
  /** Set instead of `bookCode`/`chapters` when a unit covers several books. */
  books?: UnitBook[];
  /** Why a mapping is missing or partial, when that needs saying. */
  note?: string;
}

export interface SubjectSyllabus {
  class: 9 | 10;
  subject: string;
  /** Theory marks, as stated by the document where it states one. */
  totalMarks: number;
  internalAssessment?: number;
  units: Unit[];
  /** URL of the curriculum PDF these numbers were read out of. */
  source: string;
}

export interface Syllabus {
  generatedAt: string;
  subjects: SubjectSyllabus[];
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

/**
 * How each curriculum document is laid out. CBSE does not use one format:
 *
 *   "units"   — a roman-numbered course-structure table (Science, Mathematics).
 *   "sst"     — four disciplines of 20 marks each, one NCERT book per discipline.
 *   "english" — skill sections (Reading / Writing / Literature), not chapters.
 *
 * Every document covers both Class IX and Class X. Subject names must match
 * data/manifest.json exactly so the app can join the two.
 */
interface Source {
  file: string;
  subject: string;
  layout: "units" | "sst" | "english";
}

const SOURCES: Source[] = [
  { file: "Science_Sec_2025-26.pdf", subject: "Science", layout: "units" },
  { file: "Maths_Sec_2025-26.pdf", subject: "Mathematics", layout: "units" },
  { file: "Social_Science_Sec_2025-26.pdf", subject: "Social Science", layout: "sst" },
  { file: "English_LL_2025-26.pdf", subject: "English", layout: "english" },
];

/** The four disciplines a Social Science paper is split into, in paper order. */
const SST_DISCIPLINES = ["History", "Geography", "Political Science", "Economics"];

const ROMANS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The several dash characters CBSE mixes into headings, plus the ASCII one. */
const DASH = "[\\u2010-\\u2015-]";

/** Whitespace and dashes: what may sit between two characters of one word. */
const GAP = "[\\s\\u2010-\\u2015-]*";

/**
 * Regex source matching `word` even when the PDF broke it apart, which happens
 * constantly in these documents: "COURSE S TRUCTURE", "CLASS – IX", "Weightag e".
 * Pass the word with its spaces already removed.
 */
function loose(word: string): string {
  return word.split("").map(escapeRe).join(GAP);
}

/**
 * Comparison key for a title: letters and digits only. Dropping the spaces is
 * what makes "REAL NUMBER S" and "Real Numbers", or "Metals and Non - metals"
 * and "Metals and Non-metals", compare equal without any guessing.
 */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Tidy a unit name for display. CBSE sets Mathematics unit names in full caps
 * and Science's in title case; the caps ones are converted so the app shows one
 * consistent style. Fragments left by the PDF's word splitting ("COORDINA TE")
 * are rejoined first — a fragment is a short run that is not a real word.
 */
const CAPS_WORDS = new Set(["and", "of", "in", "to", "the", "a", "an", "for", "its", "with"]);

function tidyUnitName(raw: string): string {
  let s = squash(raw).replace(/^[-–—:\s]+|[-–—:\s]+$/g, "");
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length > 2 && letters === letters.toUpperCase()) {
    // All caps: rejoin split fragments, then convert to title case.
    const parts = s.split(" ");
    const joined: string[] = [];
    for (const part of parts) {
      const word = part.toLowerCase().replace(/[^a-z]/g, "");
      if (joined.length > 0 && word.length > 0 && word.length < 4 && !CAPS_WORDS.has(word)) {
        joined[joined.length - 1] += part;
      } else {
        joined.push(part);
      }
    }
    s = joined
      .join(" ")
      .toLowerCase()
      .split(" ")
      .map((w, i) => (i > 0 && CAPS_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");
  }
  return s;
}

// ---------------------------------------------------------------------------
// PDF text
// ---------------------------------------------------------------------------

/**
 * Read every page of a curriculum PDF as one flattened string.
 *
 * pdf.js transfers (detaches) the buffer it is handed, so the document is
 * opened once and every page is read from that same instance.
 */
async function pdfText(path: string): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(path));
  const doc = await pdfjs.getDocument({ data, ...FONT_OPTS }).promise;
  try {
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
      pages.push(tc.items.map((i) => ("str" in i ? i.str : "")).join(" "));
    }
    return squash(pages.join("\n"));
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Locating a class within a document
// ---------------------------------------------------------------------------

/**
 * Anchor marking where a class's syllabus starts. `X` never matches inside
 * `IX` because the gap between characters may only be spaces and dashes, so
 * "CLASS IX" cannot be read as "CLASS ...X".
 */
function classAnchor(layout: Source["layout"], roman: "IX" | "X"): RegExp {
  const cls = `${loose("CLASS")}${GAP}${roman}\\b`;
  switch (layout) {
    case "units":
      // "COURSE STRUCTURE CLASS IX", "COURSE STRUCTURE CLASS –X"
      return new RegExp(`${loose("COURSESTRUCTURE")}${GAP}${cls}`, "i");
    case "sst":
      // "CLASS IX ( 2025 - 26 ) COURSE STRUCTURE"
      return new RegExp(`${cls}[\\s\\S]{0,40}?${loose("COURSESTRUCTURE")}`, "i");
    case "english":
      // "CLASS – X ( 2025 - 26 ) SECTION - WISE WEIGHTAGE Sections Weightage"
      return new RegExp(`${cls}[\\s\\S]{0,60}?${loose("Sections")}`, "i");
  }
}

/** The slice of the document belonging to one class, or null if not found. */
function classRegion(text: string, layout: Source["layout"], cls: 9 | 10): string | null {
  const nine = text.search(classAnchor(layout, "IX"));
  const tenRe = classAnchor(layout, "X");
  const after = nine >= 0 ? nine + 1 : 0;
  const tenRel = text.slice(after).search(tenRe);
  const ten = tenRel >= 0 ? after + tenRel : -1;

  if (cls === 9) return nine >= 0 ? text.slice(nine, ten >= 0 ? ten : undefined) : null;
  return ten >= 0 ? text.slice(ten) : null;
}

// ---------------------------------------------------------------------------
// Weightage tables
// ---------------------------------------------------------------------------

interface RawUnit {
  name: string;
  marks: number;
  /** Book title printed beside the unit, where the document prints one (SST). */
  bookTitle?: string;
}

/**
 * Parse a roman-numbered course-structure table:
 *
 *   Unit No. Unit Marks I Chemical Substances - Nature and Behaviour 25 II ...
 *
 * The rows are walked by their roman numerals in sequence rather than by one
 * big regex, so a unit name containing a number or a dash cannot derail it.
 * Each row's marks are the integer immediately before the next numeral.
 */
function parseUnitTable(region: string): RawUnit[] {
  const header = /Unit\s*(?:No\.?|s)?\s*(?:Unit\s*)?(?:Name\s*)?Marks/i.exec(region);
  if (!header) return [];
  const tail = region.slice(header.index + header[0].length);

  // Everything before the printed "Total" is table; after it is prose that
  // also contains roman numerals.
  const totalAt = tail.search(/\bTotal\b/i);
  if (totalAt < 0) return [];

  const at = (roman: string, from: number): number => {
    const rel = tail.slice(from, totalAt).search(new RegExp(`\\b${roman}\\b`));
    return rel < 0 ? -1 : from + rel;
  };

  const rows: RawUnit[] = [];
  let cursor = 0;
  for (let i = 0; i < ROMANS.length; i++) {
    const start = at(ROMANS[i], cursor);
    if (start < 0) break;
    const nextStart = i + 1 < ROMANS.length ? at(ROMANS[i + 1], start + ROMANS[i].length) : -1;
    const end = nextStart >= 0 ? nextStart : totalAt;

    const row = tail.slice(start + ROMANS[i].length, end);
    const cells = /^(.*?)\s+(\d{1,3})\s*$/.exec(squash(row));
    if (!cells) break;
    rows.push({ name: tidyUnitName(cells[1]), marks: Number(cells[2]) });

    if (nextStart < 0) break;
    cursor = nextStart;
  }
  return rows;
}

/**
 * Parse the Social Science course structure, which has no unit table: the paper
 * is four disciplines, each with its own NCERT book and its own marks. Every
 * variant CBSE uses — "Marks - 20", "20 Marks", "(Democratic Politics - II) 20"
 * — puts the marks in the first standalone one- or two-digit number after the
 * discipline name, so that is what is read. Whatever sits in between is the
 * book title, and is used to find the book in the manifest.
 */
function parseSstDisciplines(region: string): RawUnit[] {
  const rows: RawUnit[] = [];
  for (const discipline of SST_DISCIPLINES) {
    const head = new RegExp(`\\b${loose(discipline.replace(/\s/g, ""))}\\b`, "i").exec(region);
    if (!head) continue;
    const window = region.slice(head.index + head[0].length, head.index + head[0].length + 120);
    const marks = /(?:^|[^\d])(\d{1,2})(?!\d)/.exec(window);
    if (!marks) continue;
    const title = window
      .slice(0, marks.index + marks[0].length - marks[1].length)
      .replace(/[()]/g, " ")
      .replace(/\bMarks\b/gi, " ");
    rows.push({
      name: discipline,
      marks: Number(marks[1]),
      bookTitle: squash(title).replace(/^[-–—\s]+|[-–—\s]+$/g, ""),
    });
  }
  return rows;
}

/**
 * Parse the English section-wise weightage table:
 *
 *   Sections Weightage A Reading Skills 20 Marks B Writing Skills and Grammar 20 Marks ...
 *
 * English is weighted by skill, not by text, so only the literature section
 * corresponds to anything in the manifest.
 */
function parseEnglishSections(region: string): RawUnit[] {
  const rows: RawUnit[] = [];
  for (const letter of ["A", "B", "C", "D", "E"]) {
    const re = new RegExp(`\\b${letter}\\s+([A-Za-z][^\\d]{3,60}?)\\s+(\\d{1,2})\\s*${loose("Marks")}`, "i");
    const m = re.exec(region);
    if (!m) break;
    rows.push({ name: squash(m[1]), marks: Number(m[2]) });
  }
  return rows;
}

/**
 * The theory total the document prints, when it prints one. Only a plausible
 * paper total is accepted: several of these documents print "Marks - 20" for a
 * single component long before they print the paper total, and reading that as
 * the total would silently turn the verification check into a lie.
 */
function statedTotal(region: string): number | undefined {
  for (const re of [/\bTotal\s+(\d{2,3})\b/i, /Max\.?\s*Marks\s*:?\s*(\d{2,3})/i]) {
    const m = re.exec(region);
    const value = m ? Number(m[1]) : 0;
    if (value >= 50 && value <= 100) return value;
  }
  return undefined;
}

/**
 * Internal assessment marks. Written loosely because the phrase itself gets
 * split by the PDF ("Inter nal Assessment"), and looked for in two shapes: the
 * course-structure row, and the sentence English uses instead of a row.
 */
function statedInternal(region: string): number | undefined {
  const phrase = loose("InternalAssessment");
  for (const re of [
    new RegExp(`${phrase}\\s*:?\\s*(\\d{1,3})\\b`, "i"),
    new RegExp(`${phrase}\\s+of\\s+(\\d{1,3})\\s*marks`, "i"),
  ]) {
    const m = re.exec(region);
    if (m) return Number(m[1]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Unit bodies — the text a chapter is matched against
// ---------------------------------------------------------------------------

/**
 * Headings that end a unit's text. The back matter is obvious; "Theme:" is
 * less so — Science prints the theme line for the *next* unit before that
 * unit's heading, so it and everything after it belong to the unit that follows.
 */
const BODY_END = new RegExp(
  [
    "\\bTheme\\s*:",
    loose("PRACTICALS"),
    loose("LISTOFEXPERIMENTS"),
    loose("QUESTIONPAPERDESIGN"),
    loose("PRESCRIBEDBOOKS"),
    loose("PRESCRIBEDTEXTBOOKS"),
    loose("INTERNALASSESSMENT"),
  ].join("|"),
  "i",
);

/**
 * The detail section for each unit — everything under "Unit III: Natural
 * Phenomena" up to the next unit. Mathematics numbers its first unit in arabic
 * ("Unit 1 : Number Systems") and the rest in roman, so both are accepted.
 * The trailing colon is what separates a real heading from the "Unit - III"
 * cross-references in the practicals list.
 */
function unitBodies(region: string, names: string[]): string[] {
  /** Where the heading starts, and where the text under it starts. */
  const heads: number[] = [];
  const starts: number[] = [];

  for (let i = 0; i < names.length; i++) {
    const re = new RegExp(`Unit${GAP}(?:${ROMANS[i]}|${i + 1})\\s*[:.]`, "i");
    const m = re.exec(region);
    if (!m) {
      heads.push(-1);
      starts.push(-1);
      continue;
    }
    // The unit's own name repeats after the heading. Skipping it keeps the
    // first real topic title at the start of the body, which is what makes
    // "Life processes:" recognisable as a topic rather than a tail fragment.
    let start = m.index + m[0].length;
    const nameRe = new RegExp(`^\\s*${loose(key(names[i]))}`, "i");
    const after = nameRe.exec(region.slice(start));
    if (after) start += after[0].length;
    heads.push(m.index);
    starts.push(start);
  }

  return starts.map((start, i) => {
    if (start < 0) return "";
    // Stop at the *heading* of the next unit, not at its text: the heading
    // carries that unit's name, and leaving it here would file "Coordinate
    // Geometry" under whichever unit happens to precede it.
    let end = region.length;
    for (let j = i + 1; j < names.length; j++) {
      if (heads[j] > start) {
        end = heads[j];
        break;
      }
    }
    const rest = region.slice(start, end);
    const stop = rest.search(BODY_END);
    return stop >= 0 ? rest.slice(0, stop) : rest;
  });
}

/**
 * Topic titles listed inside a unit body. Two shapes cover both documents:
 * Mathematics prints them in caps ("2 . CIRCLES"), Science ends them with a
 * colon ("Acids, B ases and S alts:"). A chapter title that matches one of
 * these exactly is the strongest signal available and is trusted over any
 * amount of word overlap.
 */
function topicKeys(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/\b[A-Z][A-Z’'&-]+(?![a-z])(?:\s+[A-Z][A-Z’'&-]*(?![a-z]))*/g)) {
    out.add(key(m[0]));
  }
  for (const m of body.matchAll(/([A-Z][^.:;]{2,70}?)\s*:/g)) {
    out.add(key(m[1]));
  }
  out.delete("");
  return out;
}

// ---------------------------------------------------------------------------
// Mapping chapters onto units
// ---------------------------------------------------------------------------

const STOP = new Set([
  "the", "and", "for", "its", "with", "from", "how", "why", "what", "our", "are",
  "does", "get", "you", "your", "their", "them", "about", "into", "than", "that",
  "this", "these", "those", "some", "more", "most", "other", "using", "use",
  "introduction", "chapter", "unit", "part",
]);

/** Six characters is enough to bridge "electricity" and "electric current". */
function stem(token: string): string {
  return token.slice(0, 6);
}

function contentTokens(s: string): string[] {
  const seen = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOP.has(w)) seen.add(w);
  }
  return [...seen];
}

interface Decision {
  unit: number;
  reason: string;
}

/**
 * A chapter needs a clear winner (this much ahead of the runner-up) and, when
 * only one word of its title matched, that word has to be long enough to mean
 * something. Without the length rule "Reproduction: How Life Continues" lands
 * in the Class IX living-world unit on the strength of the word "life" alone,
 * even though the 2025-26 syllabus does not contain reproduction at all.
 */
const MIN_LEAD = 1.5;
const MIN_LONE_TOKEN = 5;

/**
 * Decide which unit a chapter belongs to.
 *
 * An exact topic-title match wins outright. Otherwise every distinctive word of
 * the chapter title votes, weighted by how many units it appears in, and the
 * winner has to be clearly ahead of the runner-up on evidence worth trusting.
 * Anything else is left unmapped — a chapter filed under the wrong unit would
 * tell a student to study the wrong thing.
 */
function assignUnit(title: string, bodies: string[], topics: Set<string>[]): Decision | null {
  const k = key(title);
  const exact = topics.map((t, i) => (t.has(k) ? i : -1)).filter((i) => i >= 0);
  if (exact.length === 1) return { unit: exact[0], reason: "exact topic title" };

  const tokens = contentTokens(title);
  const hits = bodies.map((body) => {
    const found = new Set<string>();
    for (const t of tokens) {
      if (new RegExp(`\\b${stem(t)}`, "i").test(body)) found.add(t);
    }
    return found;
  });

  const df = new Map<string, number>();
  for (const t of tokens) {
    df.set(t, hits.filter((h) => h.has(t)).length);
  }

  const ranked = hits
    .map((found, i) => ({
      i,
      found,
      score: [...found].reduce((n, t) => n + 1 / (df.get(t) ?? 1), 0),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const runnerUp = ranked[1]?.score ?? 0;
  if (!best || best.score === 0) return null;
  if (runnerUp > 0 && best.score < runnerUp * MIN_LEAD) return null;

  const lone = best.found.size === 1 ? [...best.found][0] : null;
  if (lone && lone.length < MIN_LONE_TOKEN) return null;

  return {
    unit: best.i,
    reason: `${[...best.found].join("+")} (${best.score.toFixed(2)} vs ${runnerUp.toFixed(2)})`,
  };
}

// ---------------------------------------------------------------------------
// Matching manifest books against titles printed in the curriculum
// ---------------------------------------------------------------------------

/** Words in a manifest book title that say nothing about which book it is. */
const TITLE_NOISE = new Set(["part", "supp", "suppl", "supplementary", "reader", "book", "bhag"]);

function bookTokens(book: Book): string[] {
  return contentTokens(book.title).filter((t) => !TITLE_NOISE.has(t));
}

function overlap(book: Book, haystack: string): { ratio: number; matched: number } {
  const tokens = bookTokens(book);
  if (tokens.length === 0) return { ratio: 0, matched: 0 };
  const matched = tokens.filter((t) => new RegExp(`\\b${stem(t)}`, "i").test(haystack)).length;
  return { ratio: matched / tokens.length, matched };
}

/**
 * The one book a printed title refers to. "India and the Contemporary World -
 * II" also contains every word of "Contemporary India", so the candidates are
 * ranked and a winner is only accepted when it is strictly ahead.
 */
function matchBook(haystack: string, candidates: Book[]): Book | null {
  const ranked = candidates
    .map((book) => ({ book, ...overlap(book, haystack) }))
    .sort((a, b) => b.ratio - a.ratio || b.matched - a.matched);
  const best = ranked[0];
  if (!best || best.ratio < 0.6 || best.matched < 1) return null;
  const next = ranked[1];
  if (next && next.ratio === best.ratio && next.matched === best.matched) return null;
  return best.book;
}

/** Every book named in a prescribed-books list; English sets two at a time. */
function matchBooks(haystack: string, candidates: Book[]): Book[] {
  return candidates.filter((book) => {
    const { ratio, matched } = overlap(book, haystack);
    return ratio >= 0.5 && matched >= 2;
  });
}

// ---------------------------------------------------------------------------
// Building one subject
// ---------------------------------------------------------------------------

interface Report {
  cls: 9 | 10;
  subject: string;
  ok: boolean;
  detail: string;
  units: number;
  sum: number;
  stated?: number;
  mapped: number;
  chapters: number;
}

function buildUnits(
  raw: RawUnit[],
  region: string,
  source: Source,
  books: Book[],
): { units: Unit[]; mapped: number; chapters: number } {
  const units: Unit[] = raw.map((r) => ({ name: r.name, marks: r.marks, chapters: [] }));
  const total = books.reduce((n, b) => n + b.chapters.length, 0);
  let mapped = 0;

  if (source.layout === "sst") {
    // One discipline, one book: the whole book is that discipline's syllabus.
    for (const [i, r] of raw.entries()) {
      const book = r.bookTitle ? matchBook(r.bookTitle, books) : null;
      if (!book) {
        units[i].note = `no book in the manifest matches "${r.bookTitle || r.name}"`;
        continue;
      }
      units[i].bookCode = book.code;
      units[i].chapters = book.chapters.map((c) => c.n);
      mapped += book.chapters.length;
    }
    return { units, mapped, chapters: total };
  }

  if (source.layout === "english") {
    // Only the literature section corresponds to books; reading and writing are
    // assessed on unseen material.
    const lit = units.findIndex((u) => /literature/i.test(u.name));
    const listAt = region.search(new RegExp(loose("PrescribedBooks"), "i"));
    const matches = lit >= 0 && listAt >= 0 ? matchBooks(region.slice(listAt), books) : [];
    if (lit >= 0) {
      if (matches.length === 0) {
        units[lit].note = "the books CBSE prescribes are not the ones in the manifest";
      } else if (matches.length === 1) {
        units[lit].bookCode = matches[0].code;
        units[lit].chapters = matches[0].chapters.map((c) => c.n);
      } else {
        units[lit].books = matches.map((b) => ({
          bookCode: b.code,
          chapters: b.chapters.map((c) => c.n),
        }));
      }
      mapped = matches.reduce((n, b) => n + b.chapters.length, 0);
    }
    for (const u of units) {
      if (!/literature/i.test(u.name)) u.note = "assessed on unseen material, not on any chapter";
    }
    return { units, mapped, chapters: total };
  }

  // "units": match each chapter of the class's book against the unit bodies.
  const bodies = unitBodies(region, raw.map((r) => r.name));
  const topics = bodies.map(topicKeys);
  // CBSE hyphenates across spaces ("co - ordination", "non - metals"). Closing
  // those up before word matching is what lets a chapter called "Control and
  // Coordination" find its unit.
  const haystacks = bodies.map((b) => b.replace(new RegExp(`\\s*${DASH}\\s*`, "g"), ""));
  const perUnit = new Map<number, Map<string, number[]>>();

  for (const book of books) {
    for (const ch of book.chapters) {
      const decision = assignUnit(ch.title, haystacks, topics);
      if (VERBOSE) {
        const where = decision ? `unit ${ROMANS[decision.unit]} — ${decision.reason}` : "unmapped";
        console.log(`      ${book.code} ch${ch.n} "${ch.title}" -> ${where}`);
      }
      if (!decision) continue;
      const byBook = perUnit.get(decision.unit) ?? new Map<string, number[]>();
      byBook.set(book.code, [...(byBook.get(book.code) ?? []), ch.n]);
      perUnit.set(decision.unit, byBook);
      mapped++;
    }
  }

  for (const [i, byBook] of perUnit) {
    const entries = [...byBook.entries()].map(([bookCode, chapters]) => ({ bookCode, chapters }));
    if (entries.length === 1) {
      units[i].bookCode = entries[0].bookCode;
      units[i].chapters = entries[0].chapters;
    } else {
      units[i].books = entries;
    }
  }

  // Say why a unit is bare, so a consumer can tell "nothing matched" apart from
  // "the extractor never looked".
  for (const unit of units) {
    if (unit.chapters.length > 0 || unit.books) continue;
    unit.note =
      books.length === 0
        ? "no book for this subject in the manifest"
        : "no chapter matched this unit clearly enough to map";
  }
  return { units, mapped, chapters: total };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const manifest = JSON.parse(await readFile("data/manifest.json", "utf8")) as Manifest;
  const subjects: SubjectSyllabus[] = [];
  const reports: Report[] = [];

  for (const source of SOURCES) {
    const path = `${CURRICULUM_DIR}/${source.file}`;
    if (!existsSync(path)) {
      console.log(`\n[${source.subject}] ${source.file} not downloaded — run content:curriculum`);
      continue;
    }
    console.log(`\n[${source.subject}] ${source.file}`);
    const text = await pdfText(path);

    for (const cls of [9, 10] as const) {
      const region = classRegion(text, source.layout, cls);
      if (!region) {
        reports.push({
          cls, subject: source.subject, ok: false, units: 0, sum: 0, mapped: 0, chapters: 0,
          detail: "no course structure found for this class",
        });
        continue;
      }

      const raw =
        source.layout === "units" ? parseUnitTable(region)
        : source.layout === "sst" ? parseSstDisciplines(region)
        : parseEnglishSections(region);

      if (raw.length === 0) {
        reports.push({
          cls, subject: source.subject, ok: false, units: 0, sum: 0, mapped: 0, chapters: 0,
          detail: "weightage table could not be parsed",
        });
        continue;
      }

      const books = manifest.books.filter((b) => b.class === cls && b.subject === source.subject);
      const { units, mapped, chapters } = buildUnits(raw, region, source, books);
      const sum = units.reduce((n, u) => n + u.marks, 0);
      const stated = statedTotal(region);

      subjects.push({
        class: cls,
        subject: source.subject,
        totalMarks: stated ?? sum,
        internalAssessment: statedInternal(region),
        units,
        source: `${BASE}/${source.file}`,
      });

      reports.push({
        cls,
        subject: source.subject,
        ok: stated === undefined || stated === sum,
        detail:
          stated === undefined
            ? "no total printed in the document; using the sum"
            : stated === sum
              ? ""
              : `unit marks sum to ${sum}, document states ${stated}`,
        units: units.length,
        sum,
        stated,
        mapped,
        chapters,
      });
    }
  }

  subjects.sort((a, b) => a.class - b.class || a.subject.localeCompare(b.subject));
  await writeFile(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), subjects } satisfies Syllabus, null, 2),
  );

  // Summary. The marks check matters more than the mapping count: a wrong
  // number here would misdirect a student's whole revision plan.
  console.log(`\n=== ${OUT} ===`);
  console.log(`class  subject          units  marks  total  chapters mapped`);
  for (const r of reports.sort((a, b) => a.cls - b.cls || a.subject.localeCompare(b.subject))) {
    const marks = r.units > 0 ? String(r.sum).padStart(5) : "    —";
    const total = r.stated === undefined ? "    ?" : String(r.stated).padStart(5);
    console.log(
      `${String(r.cls).padStart(5)}  ${r.subject.padEnd(15)} ${String(r.units).padStart(5)}  ` +
        `${marks}  ${total}  ${String(`${r.mapped}/${r.chapters}`).padStart(14)}`,
    );
  }

  const problems = reports.filter((r) => r.detail);
  if (problems.length > 0) {
    console.log(`\nnotes:`);
    for (const r of problems) console.log(`  class ${r.cls} ${r.subject}: ${r.detail}`);
  }

  const unmapped = subjects.flatMap((s) =>
    s.units
      .filter((u) => u.note)
      .map((u) => `  class ${s.class} ${s.subject} / ${u.name}: ${u.note}`),
  );
  if (unmapped.length > 0) {
    console.log(`\nunits with no chapter mapping:`);
    for (const line of unmapped) console.log(line);
  }

  const broken = reports.filter((r) => !r.ok);
  console.log(
    `\n${subjects.length} subject syllabuses written` +
      (broken.length > 0 ? `, ${broken.length} with a marks discrepancy` : `, marks verified`),
  );
  if (!VERBOSE) console.log(`Re-run with --verbose to see every chapter mapping decision.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
