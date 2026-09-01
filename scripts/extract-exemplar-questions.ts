/**
 * Extract multiple-choice questions from the NCERT Exemplar Problems books into
 * the data/questions.json shape, as data/questions.exemplar.json.
 *
 *   npx tsx scripts/extract-exemplar-questions.ts            # every mapped class
 *   npx tsx scripts/extract-exemplar-questions.ts --class 10 # just one of them
 *   npx tsx scripts/extract-exemplar-questions.ts --dump ieep108   # debug one unit
 *
 * The output file holds every class the chapter map covers, so a run must never
 * be narrowed with --class before writing it: that would drop the other class's
 * rows from the file.
 *
 * Four things about this job are worth knowing before changing anything here.
 *
 * 1. **Exemplar book codes are not textbook codes.** `ieep1` is the Class 9
 *    Science Exemplar; the book a student actually owns is `iesc1`. Worse, the
 *    Exemplar tracks the pre-rationalisation syllabus, and the current NCF books
 *    were re-cut and re-titled, so a title-to-title match is not merely
 *    unreliable, it is actively misleading (`iemh1` chapter 5 is called "I'm Up
 *    and Down, and Round and Round" and is Circles). Every unit-to-chapter
 *    decision therefore lives in data/exemplar-chapter-map.json, authored by
 *    reading the section headings out of the current PDFs. A unit with a `null`
 *    target has no home in the current book and its questions are dropped. This
 *    script never guesses a chapter.
 *
 * 2. **A wrong answer is the worst thing this app can ship.** It tells a student
 *    they are wrong when they are right, and nothing in the UI could reveal it.
 *    So every question that cannot be paired with its answer letter *with
 *    certainty* is refused into the `rejects` array with a reason, rather than
 *    published with a best guess. The refusal rules are in `classify()`.
 *
 * 3. **Superscripts and subscripts do not survive text extraction.** pdf.js
 *    reports them as their own short lines ("2" alone, on the line above), so an
 *    option reading "m s^-1" extracts as "m s" with a stray "-1" elsewhere. Any
 *    question whose block contains a line typeset smaller than the body is
 *    therefore refused: a silently truncated option is indistinguishable from a
 *    real one, and it would be marked wrong for the right reason.
 *
 * 4. **Some pages are typeset in fonts whose ToUnicode table is wrong.** The
 *    Class 10 Science Exemplar sets its headings thirty code points low
 *    ("ANSWERS" as "#059'45") and ten whole pages twenty-nine low (":KLFK RI
 *    WKH IROORZLQJ"). Both are repaired — see `deshift` and `decodeShift` — and
 *    the repair is what makes those units usable at all, because without it the
 *    chapter boundaries in the answer key cannot be found and five units are
 *    lost whole. On the twenty-nine pages the brackets around an option letter
 *    are not in the text layer at all, so "(a) Litmus" arrives as "a Litmus";
 *    those questions are refused rather than have a marker inferred from a bare
 *    letter, which would mistake a stem's own line for an option.
 *
 * The output is a separate file. data/questions.json is hand-authored and
 * merging the two is a human decision, not this script's.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

const FONT_OPTS = {
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  useSystemFonts: true,
} as const;

const EXEMPLAR = "data/exemplar.json";
const MANIFEST = "data/manifest.json";
const MAP = "data/exemplar-chapter-map.json";
const OUT = "data/questions.exemplar.json";

// --- the files this script reads -----------------------------------------

interface ExemplarChapter {
  n: number;
  title: string;
  file: string;
  path: string;
}
interface ExemplarBook {
  code: string;
  class: number;
  subject: string;
  solutions: string;
  chapters: ExemplarChapter[];
}
interface Exemplar {
  generatedAt: string;
  books: ExemplarBook[];
}

interface ManifestBook {
  code: string;
  class: number;
  subject: string;
  chapters: { n: number; title: string }[];
}
interface Manifest {
  books: ManifestBook[];
}

interface Target {
  bookCode: string;
  chapter: number;
  chapterTitle: string;
}

/**
 * A hand-authored override for a run of question numbers inside one unit.
 *
 * Some Exemplar units are a superset of two current chapters — "Introduction to
 * Trigonometry and its Applications" is `jemh1` ch8 plus ch9, "Statistics and
 * Probability" is ch13 plus ch14 — and their MCQ exercise runs both halves in
 * one numbered sequence with a single clean break in it. Where that break has
 * been read off the exercise and written down here, routing across it is a fact
 * about the exercise rather than a guess about each question, and the unit does
 * not have to be discarded whole. A `null` target drops the run instead.
 *
 * Question numbers are the ones printed in the book, and the extractor has
 * already refused the unit unless every printed number matches its position and
 * the published answer key numbers 1..N — so an exception cannot silently slide.
 */
interface MapException {
  from: number;
  to: number;
  target: Target | null;
  confidence: string;
  why: string;
}

interface Mapping {
  exemplarBook: string;
  unit: number;
  unitTitle: string;
  target: Target | null;
  exceptions?: MapException[];
  confidence: string;
  why: string;
}
interface ChapterMap {
  mappings: Mapping[];
}

// --- what this script writes ---------------------------------------------

interface OutQuestion {
  id: string;
  class: number;
  subject: string;
  bookCode: string;
  chapter: number;
  type: "mcq";
  question: string;
  options: string[];
  answer: number;
  marks: number;
  difficulty: "medium";
  origin: "exemplar";
  provenance: {
    exemplarBook: string;
    unit: number;
    unitTitle: string;
    questionNo: number;
    page: number;
    file: string;
    answerKey: string;
    mapConfidence: string;
  };
}

interface Reject {
  ref: string;
  exemplarBook: string;
  unit: number;
  questionNo: number | null;
  page: number | null;
  reason: string;
  detail: string;
}

// --- PDF text, line by line ----------------------------------------------

interface Line {
  page: number;
  /** True when the line sits in the top or bottom margin band of its page. */
  margin: boolean;
  /**
   * True when the runs on this line do not all sit on one baseline.
   *
   * Rounding groups items into lines, so a radical's numerals set a single
   * point below the text they belong to are folded into the line rather than
   * left beside it — "(D) 7 root 5" comes out as "(D) 7+ 5", which reads as a
   * complete option and is not one. The unrounded offsets are the only thing
   * left that shows it happened.
   */
  mixed: boolean;
  /** Baseline, in PDF user units. Two baselines a hair apart mean a superscript. */
  y: number;
  text: string;
  /** Cap height of the tallest glyph run on the line. */
  height: number;
}

/**
 * One page's text as lines.
 *
 * Items are grouped by baseline and ordered left to right. NCERT sets italics
 * as separate runs with no space of their own ("under a v-t graph" arrives as
 * three items), so a space is inserted only where the horizontal gap between
 * two runs is wide enough to be one — comparing the gap against the glyph
 * height rather than a fixed value, because the books mix type sizes.
 */
function linesOfPage(items: TextItem[], pageNo: number, pageHeight: number): Line[] {
  const rows = new Map<number, { x: number; w: number; h: number; s: string; exact: number }[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    const h = Math.abs(it.transform[3]) || it.height || 0;
    const row = rows.get(y) ?? [];
    row.push({ x: it.transform[4], w: it.width ?? 0, h, s: it.str, exact: it.transform[5] });
    rows.set(y, row);
  }

  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, row]) => {
      row.sort((a, b) => a.x - b.x);
      let text = "";
      let prevEnd: number | null = null;
      let height = 0;
      let lowest = Infinity;
      let highest = -Infinity;
      for (const r of row) {
        if (prevEnd !== null && r.x - prevEnd > Math.max(1, r.h * 0.2)) text += " ";
        text += r.s;
        prevEnd = r.x + r.w;
        height = Math.max(height, r.h);
        lowest = Math.min(lowest, r.exact);
        highest = Math.max(highest, r.exact);
      }
      const mixed = highest - lowest > 0.4;
      const margin = pageHeight > 0 && (y > pageHeight * 0.92 || y < pageHeight * 0.08);
      return { page: pageNo, margin, mixed, y, text: text.replace(/\s+/g, " ").trim(), height };
    })
    .filter((l) => l.text.length > 0);
}

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

async function readPdfLines(pdfjs: Pdfjs, path: string): Promise<Line[]> {
  const data = new Uint8Array(await readFile(path));
  const doc = await pdfjs.getDocument({ data, ...FONT_OPTS }).promise;
  try {
    const out: Line[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const pageLines = linesOfPage(
        tc.items.filter((i): i is TextItem => "str" in i),
        p,
        page.getViewport({ scale: 1 }).height,
      );
      const by = decodeShift(pageLines);
      out.push(
        ...(by === 0
          ? pageLines
          : pageLines.map((l) => ({ ...l, text: deshift(l.text, by).replace(/\s+/g, " ").trim() }))),
      );
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/** Page furniture: running heads, folios, and the reprint date NCERT stamps on every page. */
const NOISE = [
  // The Class 10 books run "122EXEMPLARPROBLEMS- SCIENCE"; the trailing part
  // varies, and the margin test in isNoise is what keeps this from over-reaching.
  /^\d{0,3}\s*EXEMPLAR\s*PROBLEMS?\b/i,
  /^A\s*NSWERS?\b/i,
  // The Class 10 books set the chapter name across the foot of the page
  // ("CHEMICAL REACTIONS AND EQUATIONS 3"), and it lands glued to the last
  // option. Upper case throughout, and only ever consulted inside the margin
  // band, so an option that happens to shout cannot match it.
  /^[A-Z][A-Z’' ,.&?()-]{4,}\s*\d{0,3}$/,
  /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})?$/,
  /^(SCIENCE|MATHEMATICS)\s*\d{0,3}$/i,
  /^\d{1,3}$/,
  /^Reprint/i,
];

/**
 * The Class 10 Science Exemplar sets every heading in a font whose ToUnicode
 * table is thirty code points low: "ANSWERS" arrives as "#059'45", "Multiple
 * Choice Questions" as "/WNVKRNG%JQKEG3WGUVKQPU", and a chapter number 12 as
 * two control characters. Body text and the answer letters themselves are in a
 * normal font and come through clean, so only the headings need repairing —
 * and repairing them is what makes it possible to find the chapter boundaries
 * at all.
 *
 * Applied as an alternative reading rather than a replacement: ordinary text is
 * also below code point 96 and would be mangled by shifting it, so every marker
 * is tested against the line as printed first and against this only if that
 * fails.
 */
function deshift(text: string, by = 30): string {
  let out = "";
  for (const ch of text) {
    const n = ch.charCodeAt(0);
    // A real space is left alone: some headings in the broken font still use
    // one, and shifting it would turn the word gaps into punctuation.
    out += n >= 1 && n <= 96 && n !== 32 ? String.fromCharCode(n + by) : ch;
  }
  return out;
}

/**
 * The same fault, one page at a time and one code point further off.
 *
 * The Class 10 Science Exemplar has ten pages — whole pages, body text and all
 * — typeset in a font whose ToUnicode table is twenty-nine low rather than
 * thirty: "Which of the following" arrives as ":KLFK RI WKH IROORZLQJ". Those
 * pages carry real questions, and without repairing them five units are lost
 * whole, so the offset is worked out per page and applied to every line.
 *
 * Which offset is not guessed. Each candidate is scored by how many ordinary
 * English function words the whole page yields under it, and the winner is
 * accepted only if it scores at least five and at least three times the
 * runner-up. On a page that is already fine the winner is "no shift" by a mile;
 * on a broken page the true offset scores in the dozens and every other offset
 * scores nothing. When no candidate is decisive the page is left exactly as it
 * came, and its questions are then refused downstream for the gibberish they
 * still contain — which is the right outcome, because a page this cannot read
 * is a page nobody should be quizzed from.
 *
 * The scoring shift deliberately moves every character, including the lower
 * case the broken fonts never use: shifting only the broken range would leave
 * an ordinary page's lower-case words intact and make every offset score alike.
 */
const FUNCTION_WORDS = /\b(the|of|and|is|in|to|which|following|are|for|that|with|will|be)\b/gi;

function decodeShift(lines: Line[]): number {
  const page = lines.map((l) => l.text).join(" ");
  const scored = [0, 29, 30]
    .map((by) => {
      const moved = [...page]
        .map((c) => (c.charCodeAt(0) < 0x2000 ? String.fromCharCode(c.charCodeAt(0) + by) : c))
        .join("");
      return { by, score: (moved.match(FUNCTION_WORDS) ?? []).length };
    })
    .sort((a, b) => b.score - a.score);

  const [best, next] = scored;
  return best.score >= 5 && best.score >= 3 * Math.max(next.score, 1) ? best.by : 0;
}

/** Does `re` match the line as printed, or the line read through `deshift`? */
function marks(re: RegExp, text: string): boolean {
  // The word gaps in these headings are sometimes a real space and sometimes a
  // control character that deshifts into one, and sometimes both together, so
  // the deshifted reading is squeezed before it is tested.
  return re.test(text) || re.test(deshift(text).replace(/\s+/g, " ").trim());
}

/**
 * Page furniture, and only page furniture.
 *
 * The position test is not decoration. A bare "2" alone on a line is a folio
 * number at the foot of the page and a dropped superscript in the middle of
 * one, and the second must survive: it is the only trace left of "cm²", and
 * dropping it silently turns "9 paise per cm²" into "9 paise per cm" with
 * nothing to show anything went wrong.
 */
function isNoise(line: Line): boolean {
  return line.margin && NOISE.some((re) => re.test(line.text.trim()));
}

/**
 * The body type size, as the modal line height. Used only to spot lines set
 * smaller than the body — superscripts, subscripts and fraction parts, which
 * extraction has already separated from the text they belong to.
 */
function bodyHeight(lines: Line[]): number {
  const counts = new Map<number, number>();
  for (const l of lines) {
    const key = Math.round(l.height * 2) / 2;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [h, n] of counts) {
    if (n > bestCount) {
      best = h;
      bestCount = n;
    }
  }
  return best;
}

// --- parsing a unit's MCQ exercise ---------------------------------------

interface RawQuestion {
  /** Position in the exercise, 1-based — what the answer key is keyed by. */
  n: number;
  /** The number actually printed beside the question, which is not always `n`. */
  printed: number;
  page: number;
  stem: string;
  options: string[];
  /** True if any line in the block was typeset below body size. */
  small: boolean;
  /** True if the option letters did not run a, b, c, d in order. */
  outOfOrder: boolean;
}

/**
 * True when two consecutive "lines" sit almost on the same baseline.
 *
 * That is not two lines of prose — nothing is set that tight — it is one line
 * whose superscript, fraction or radical parts pdf.js reports a fraction of a
 * point off the baseline, so they arrive as a line of their own and would be
 * glued on wherever the parser happens to be. Catching it by baseline rather
 * than by type size matters: the numerals inside a radical are set at full
 * body size ("area of 9 root 3 cm squared" extracts as "area of cm is 9 3"),
 * so a height test alone lets exactly the worst cases through.
 */
function offsetBaselines(block: Line[], body: number): boolean[] {
  // Body-height rather than a fixed value, and 1.0 rather than something
  // smaller: the tightest real leading in these books is about 1.2 times the
  // body height, while a fraction's numerator and denominator sit under one.
  const near = (a: Line, b: Line | undefined) =>
    !!b && a.page === b.page && Math.abs(a.y - b.y) < body;
  // Both neighbours, not just the one before. A fraction printed inside
  // question 8 sorts above question 8's own baseline and so lands at the end of
  // question 7, where comparing backwards sees only an ordinary paragraph gap.
  return block.map((l, i) => near(l, block[i - 1]) || near(l, block[i + 1]));
}

/**
 * A numbered question opens a line at the left margin: a one- or two-digit
 * number, a full stop, then text beginning with a letter, a bracket or a digit.
 * The number itself is not trusted for pairing — see the count check in main().
 *
 * The one thing that is excluded is a remainder opening with a closing bracket,
 * with or without a digit before it. That is the tail of a figure reference
 * that wrapped — "(Fig. 12.4) obtaining maximum potential is" extracts as a
 * line beginning "12.4)" — and reading it as question 12 invents a question the
 * book does not have, which then costs the whole unit at the count check.
 */
const QUESTION_START = /^(\d{1,2})\s*\.\s*(?!\d{0,2}\))(\S.{2,})$/;

/** Lines between two markers, noise removed. */
function slice(lines: Line[], from: RegExp, to: RegExp): Line[] | null {
  const start = lines.findIndex((l) => marks(from, l.text));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (marks(to, lines[i].text)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).filter((l) => !isNoise(l));
}

/**
 * Science units: one question per numbered line, options each on their own
 * `(a)`-`(d)` line, both wrapping freely onto following lines.
 */
function parseScienceUnit(lines: Line[], body: number): RawQuestion[] {
  // NCERT is inconsistent about the plural ("Short Answer Question" in unit 12).
  const block = slice(lines, /^Multiple Choice Questions$/i, /^(Short|Long) Answer Questions?/i);
  if (!block) return [];

  const out: RawQuestion[] = [];
  let cur: RawQuestion | null = null;
  let target: "stem" | "option" | null = null;
  const offsets = offsetBaselines(block, body);

  for (const [i, line] of block.entries()) {
    const offset = offsets[i] || line.mixed;
    const q = QUESTION_START.exec(line.text);
    if (q) {
      if (cur) out.push(cur);
      cur = {
        n: out.length + 1,
        printed: Number(q[1]),
        page: line.page,
        stem: q[2],
        options: [],
        small: line.height < body * 0.85 || offset,
        outOfOrder: false,
      };
      target = "stem";
      continue;
    }
    if (!cur) continue;

    if (line.height < body * 0.85 || offset) cur.small = true;

    // The Class 10 book sets two options to a line ("(a) (i) and (iv)(b) (ii)
    // and (iii)"), so a line is cut at every marker that is the *next* letter
    // due rather than at every "(x)" — the roman numerals inside these stems
    // would otherwise be mistaken for option markers.
    let rest = line.text;
    while (rest.length > 0) {
      const want = "abcde"[cur.options.length];
      const at = want === undefined ? -1 : rest.indexOf(`(${want})`);
      if (at === -1) break;
      const before = rest.slice(0, at).trim();
      if (before) {
        if (cur.options.length === 0) {
          if (target === "stem") cur.stem += ` ${before}`;
        } else {
          cur.options[cur.options.length - 1] += ` ${before}`;
        }
      }
      cur.options.push("");
      target = "option";
      rest = rest.slice(at + 3);
    }

    // Any letter that is not the one due means the block is not what it looks
    // like; flag it so the question is refused rather than mis-assembled.
    const stray = /\(([a-e])\)/.exec(rest);
    if (stray && target === "option") cur.outOfOrder = true;

    const tail = rest.trim();
    if (tail) {
      if (target === "option" && cur.options.length > 0) {
        cur.options[cur.options.length - 1] += ` ${tail}`;
      } else if (target === "stem") {
        cur.stem += ` ${tail}`;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Maths units: options are `(A)`-`(D)` and several often share one line
 * ("(A)0(B)1"), so the split happens inside the line rather than between lines.
 */
function parseMathsUnit(lines: Line[], body: number, unit: number): RawQuestion[] {
  const block = slice(
    lines,
    new RegExp(`^EXERCISE\\s+${unit}\\.1\\b`),
    // Not a bare /\([C-E]\)/ — that would also match option (C) and cut the
    // exercise off after its first question.
    /^(EXERCISE\s+\d|\([C-E]\)\s*(Short|Long)|(Short|Long) Answer Questions?)/i,
  );
  if (!block) return [];

  const out: RawQuestion[] = [];
  let cur: RawQuestion | null = null;
  const offsets = offsetBaselines(block, body);

  const absorb = (q: RawQuestion, text: string) => {
    const parts = text.split(/(?=\([A-E]\))/);
    for (const part of parts) {
      const o = /^\(([A-E])\)\s*(.*)$/.exec(part.trim());
      if (o) {
        if (o[1] !== "ABCDE"[q.options.length]) q.outOfOrder = true;
        q.options.push(o[2].trim());
      } else if (q.options.length > 0) {
        q.options[q.options.length - 1] += ` ${part.trim()}`;
      } else {
        q.stem += ` ${part.trim()}`;
      }
    }
  };

  for (const [i, line] of block.entries()) {
    const offset = offsets[i] || line.mixed;

    const q = QUESTION_START.exec(line.text);
    if (q) {
      if (cur) out.push(cur);
      cur = {
        n: out.length + 1,
        printed: Number(q[1]),
        page: line.page,
        stem: "",
        options: [],
        small: line.height < body * 0.85 || offset,
        outOfOrder: false,
      };
      absorb(cur, q[2]);
      continue;
    }
    if (!cur) continue;
    if (line.height < body * 0.85 || offset) cur.small = true;
    absorb(cur, line.text);
  }
  if (cur) out.push(cur);
  return out.map((q) => ({ ...q, stem: q.stem.trim(), options: q.options.map((o) => o.trim()) }));
}

// --- the answer keys ------------------------------------------------------

/**
 * `<code>an.pdf` holds every unit's answers. Science opens each unit with
 * "Chapter / N / ANSWERS / Multiple Choice Questions"; Maths heads each with
 * "EXERCISE N.1". In both, the MCQ answers are a run of "12.(c)" tokens ending
 * where the written answers begin.
 */
function scienceAnswers(lines: Line[]): Map<number, Map<number, string>> {
  const out = new Map<number, Map<number, string>>();
  for (let i = 0; i < lines.length; i++) {
    if (!marks(/^Multiple Choice Questions$/i, lines[i].text)) continue;
    // The banner is printed five times over itself as a drop shadow in the
    // Class 10 book, so it extracts as "ANSWERSANSWERSANSWERS...".
    if (!marks(/^(ANSWERS)+$/i, lines[i - 1]?.text ?? "")) continue;

    // The unit number is the bare integer just above the ANSWERS banner; the
    // word "Chapter" above it often extracts as "C" + "hapter".
    let unit: number | null = null;
    for (let k = i - 2; k >= Math.max(0, i - 5); k--) {
      for (const candidate of [lines[k].text.trim(), deshift(lines[k].text.trim())]) {
        // Either on a line of its own, or set tight against the word CHAPTER,
        // which is how half of the Class 10 answer key prints it.
        const m = /^(?:CHAPTER\s*)?(\d{1,2})$/i.exec(candidate);
        if (m) {
          unit = Number(m[1]);
          break;
        }
      }
      if (unit !== null) break;
    }
    if (unit === null) continue;

    // Unit 3's key interleaves a worked explanation between the MCQ letters, so
    // a token-less line cannot end the block. The letters are instead read as a
    // strictly increasing run from 1: whatever the prose happens to look like is
    // out of sequence and ignored, and a genuinely missing letter ends the run
    // rather than silently shifting every answer after it by one.
    const answers = new Map<number, string>();
    let next = 1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].text;
      if (marks(/^(Short|Long) Answer Questions?/i, t)) break;
      if (marks(/^Multiple Choice Questions$/i, t)) break;
      if (isNoise(lines[k]) || marks(/^(ANSWERS)+$/i, t)) continue;
      for (const m of t.matchAll(/(\d{1,2})\s*\.\s*\(([a-eA-E])\)/g)) {
        if (Number(m[1]) !== next) continue;
        answers.set(next, m[2].toLowerCase());
        next++;
      }
    }
    if (answers.size) out.set(unit, answers);
  }
  return out;
}

function mathsAnswers(lines: Line[]): Map<number, Map<number, string>> {
  const out = new Map<number, Map<number, string>>();
  for (let i = 0; i < lines.length; i++) {
    const head = /^EXERCISE\s+(\d{1,2})\.1\b/.exec(lines[i].text);
    if (!head) continue;
    const unit = Number(head[1]);
    const answers = new Map<number, string>();
    let next = 1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].text;
      if (/^EXERCISE\s+\d/.test(t)) break;
      if (isNoise(lines[k]) || /^ANSWERS/i.test(t)) continue;
      for (const m of t.matchAll(/(\d{1,2})\s*\.\s*\(([A-Ea-e])\)/g)) {
        if (Number(m[1]) !== next) continue;
        answers.set(next, m[2].toLowerCase());
        next++;
      }
    }
    if (answers.size) out.set(unit, answers);
  }
  return out;
}

// --- refusal --------------------------------------------------------------

/** Anything that reads as "look at the picture" cannot be answered from text. */
const DIAGRAM =
  /\bFig(ure)?\.?\s*\d|\bfigures?\s*\(|following figures?\b|graph(s)? (shown|given|below)|shown in (the )?(figure|fig|graph|diagram)|in the (figure|diagram) (below|given)|\btable (given|below|shown)\b/i;

/**
 * Stems that say, in so many words, that a table follows.
 *
 * A frequency table extracted linearly becomes "Class 0-5 5-10 10-15 15-20
 * Frequency 10 15 12 20" — every number is present, in an order that happens to
 * be right here and is not guaranteed anywhere, and in a form no student can
 * read. The book is telling us the question is not made of prose; take it at
 * its word.
 */
const TABLE =
  /following (frequency )?distribution|frequency distribution (is|are)? ?:|tabulated below|following data\b|distribution\s*:|following table/i;

/**
 * Characters that survive extraction cleanly. Anything else — the radical sign,
 * the mathematical italics NCERT uses for variables, box-drawing left over from
 * a table — means the text on the page is not the text we captured.
 */
const CLEAN = /^[\x20-\x7E -ÿ‐-―‘-”…°²³×÷–—]*$/;

function classify(
  q: RawQuestion,
  answerLetter: string | undefined,
  body: number,
): { ok: true; index: number } | { ok: false; reason: string; detail: string } {
  if (q.printed !== q.n) {
    return {
      ok: false,
      reason: "numbering-drift",
      detail: `printed as ${q.printed} but sits at position ${q.n} in the exercise, so which published answer belongs to it is not certain`,
    };
  }
  if (q.small) {
    return {
      ok: false,
      reason: "mangled",
      detail:
        "the block contains type set below body size — a superscript, subscript or fraction that extraction has separated from the text it belongs to, leaving an option that looks complete but is not",
    };
  }
  if (q.outOfOrder) {
    return {
      ok: false,
      reason: "option-order",
      detail: "the option letters did not run a, b, c, d in order, so the block was not assembled the way it is printed",
    };
  }
  if (q.options.length === 0) {
    return { ok: false, reason: "no-options", detail: "no lettered options; the choices are probably a diagram" };
  }
  if (q.options.length < 4) {
    return {
      ok: false,
      reason: "option-count",
      detail: `${q.options.length} option(s) parsed; every Exemplar MCQ has four, so one was lost`,
    };
  }
  if (q.options.length > 4) {
    return { ok: false, reason: "option-count", detail: `${q.options.length} options parsed; four expected` };
  }
  const stem = q.stem.trim();
  if (stem.length < 10) {
    return { ok: false, reason: "empty-stem", detail: `stem is ${stem.length} characters` };
  }
  if (DIAGRAM.test(stem) || q.options.some((o) => DIAGRAM.test(o))) {
    return { ok: false, reason: "diagram", detail: "the question refers to a figure, graph or table that is not in the text" };
  }
  if (TABLE.test(stem)) {
    return {
      ok: false,
      reason: "table",
      detail: "the stem announces a table, which extraction flattens into a run of numbers that is unreadable and whose column order is not guaranteed",
    };
  }
  const crowded = q.options.find((o) => (o.match(/=/g) ?? []).length > 1);
  if (crowded !== undefined) {
    return {
      ok: false,
      reason: "run-together",
      detail: `an option holds more than one equation (${JSON.stringify(crowded)}), so a multi-line or two-column option block was flattened into one`,
    };
  }
  for (const o of q.options) {
    if (o.trim().length < 1) return { ok: false, reason: "blank-option", detail: "an option extracted as empty" };
  }
  if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) {
    return { ok: false, reason: "duplicate-option", detail: "two options extracted identically, so at least one is wrong" };
  }
  for (const t of [stem, ...q.options]) {
    if (!CLEAN.test(t)) {
      return {
        ok: false,
        reason: "mangled",
        detail: `text contains characters that do not survive extraction: ${JSON.stringify(
          [...t].filter((c) => !CLEAN.test(c)).join(""),
        )}`,
      };
    }
  }
  if (!answerLetter) {
    return { ok: false, reason: "no-answer", detail: `the answer key lists no letter for question ${q.n}` };
  }
  const index = answerLetter.charCodeAt(0) - 97;
  if (index < 0 || index >= q.options.length) {
    return { ok: false, reason: "answer-out-of-range", detail: `key says (${answerLetter}) but only ${q.options.length} options were parsed` };
  }
  // Not reachable through `body` today, but keeps the signature honest about
  // what the caller must supply.
  void body;
  return { ok: true, index };
}

/** NCERT's typesetting leaves a few reliable artefacts; fix only those. */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:?])/g, "$1")
    .replace(/\.\.+$/, ".")
    .trim();
}

// --- main -----------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  // Both classes by default; --class narrows it. The output file holds every
  // class the map covers, so a Class 10 run must not drop Class 9's rows.
  const classArg = argv.indexOf("--class");
  const wanted = classArg === -1 ? null : Number(argv[classArg + 1]);
  const dumpAt = argv.indexOf("--dump");
  const dumpUnit = dumpAt === -1 ? null : argv[dumpAt + 1];

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const exemplar = JSON.parse(await readFile(EXEMPLAR, "utf8")) as Exemplar;
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
  const chapterMap = JSON.parse(await readFile(MAP, "utf8")) as ChapterMap;

  const books = new Map(manifest.books.map((b) => [b.code, b]));
  const questions: OutQuestion[] = [];
  const rejects: Reject[] = [];
  const unitSummary: { unit: string; extracted: number; refused: number; note: string }[] = [];

  for (const exBook of exemplar.books) {
    if (wanted !== null && exBook.class !== wanted) continue;
    if (!chapterMap.mappings.some((m) => m.exemplarBook === exBook.code)) continue;

    // The answer key sits beside the chapters as <code>an.pdf.
    const keyPath = `public/exemplar/${exBook.code}/${exBook.code}an.pdf`;
    if (!existsSync(keyPath)) {
      console.log(`[${exBook.code}] no answer key at ${keyPath} — skipping the whole book`);
      continue;
    }
    const keyLines = await readPdfLines(pdfjs, keyPath);
    const isScience = exBook.subject === "Science";
    const keys = isScience ? scienceAnswers(keyLines) : mathsAnswers(keyLines);
    console.log(`[${exBook.code}] ${exBook.subject}: answer key has MCQ answers for ${keys.size} units`);

    for (const ch of exBook.chapters) {
      const mapping = chapterMap.mappings.find(
        (m) => m.exemplarBook === exBook.code && m.unit === ch.n,
      );
      const ref = `${exBook.code}-u${String(ch.n).padStart(2, "0")}`;

      if (!mapping) {
        rejects.push({
          ref, exemplarBook: exBook.code, unit: ch.n, questionNo: null, page: null,
          reason: "unmapped-unit",
          detail: `no row in ${MAP} for this unit; add one before its questions can be filed`,
        });
        continue;
      }
      const exceptions = mapping.exceptions ?? [];
      /** The chapter question `n` belongs to: an exception if one covers it, else the unit's own. */
      const routeOf = (n: number) => {
        const hit = exceptions.find((e) => n >= e.from && n <= e.to);
        return hit
          ? { target: hit.target, confidence: hit.confidence, why: hit.why }
          : { target: mapping.target, confidence: mapping.confidence, why: mapping.why };
      };

      if (!mapping.target && !exceptions.some((e) => e.target)) {
        rejects.push({
          ref, exemplarBook: exBook.code, unit: ch.n, questionNo: null, page: null,
          reason: "no-home-chapter",
          detail: mapping.why,
        });
        unitSummary.push({ unit: `${ref} ${mapping.unitTitle}`, extracted: 0, refused: 0, note: "unmapped — no home chapter" });
        continue;
      }

      const targets = [mapping.target, ...exceptions.map((e) => e.target)].filter(
        (t): t is Target => t !== null,
      );
      const badTarget = targets.find((t) => {
        const b = books.get(t.bookCode);
        return !b || !b.chapters.some((c) => c.n === t.chapter);
      });
      if (badTarget) {
        rejects.push({
          ref, exemplarBook: exBook.code, unit: ch.n, questionNo: null, page: null,
          reason: "bad-map-target",
          detail: `${badTarget.bookCode} chapter ${badTarget.chapter} is not in ${MANIFEST}`,
        });
        continue;
      }

      const path = `public/exemplar/${exBook.code}/${ch.file}`;
      if (!existsSync(path)) {
        rejects.push({
          ref, exemplarBook: exBook.code, unit: ch.n, questionNo: null, page: null,
          reason: "missing-pdf", detail: `${path} is not on disk`,
        });
        continue;
      }

      const lines = await readPdfLines(pdfjs, path);
      const body = bodyHeight(lines);
      const parsed = isScience ? parseScienceUnit(lines, body) : parseMathsUnit(lines, body, ch.n);

      if (dumpUnit && ch.file.startsWith(dumpUnit)) {
        console.log(JSON.stringify({ body, parsed }, null, 2));
      }

      const answers = keys.get(ch.n);
      if (!answers) {
        rejects.push({
          ref, exemplarBook: exBook.code, unit: ch.n, questionNo: null, page: null,
          reason: "no-answer-block",
          detail: `${exBook.code}an.pdf has no MCQ answer block for unit ${ch.n}`,
        });
        unitSummary.push({ unit: `${ref} ${mapping.unitTitle}`, extracted: 0, refused: parsed.length, note: "no answer block" });
        continue;
      }

      // Everything downstream pairs a question with its answer by position, so
      // the position has to be beyond doubt. The exercise is trusted only when
      // the number of questions found equals the number of answers published,
      // and the key numbers exactly 1..N. Either a missed question or a false
      // question-start breaks that equality, and both would otherwise shift
      // every later pairing by one — the failure that publishes wrong answers
      // and shows nothing. When it breaks, the whole unit is refused.
      const keyNumbers = [...answers.keys()].sort((a, b) => a - b);
      const keyRunsToN =
        keyNumbers.length === parsed.length && keyNumbers.every((n, i) => n === i + 1);
      if (parsed.length === 0 || !keyRunsToN) {
        rejects.push({
          ref, exemplarBook: exBook.code, unit: ch.n, questionNo: null, page: null,
          reason: "numbering-drift",
          detail: `${parsed.length} question(s) parsed against ${answers.size} published answer(s) numbered ${
            keyNumbers.join(",") || "(none)"
          }; the whole unit is refused because a question is missing or spurious and every pairing after it would be uncertain`,
        });
        unitSummary.push({ unit: `${ref} ${mapping.unitTitle}`, extracted: 0, refused: parsed.length, note: "numbering drift" });
        continue;
      }

      let kept = 0;
      let refused = 0;
      for (const q of parsed) {
        const cleaned: RawQuestion = {
          ...q,
          stem: tidy(q.stem),
          options: q.options.map(tidy),
        };
        const route = routeOf(q.n);
        if (!route.target) {
          refused++;
          rejects.push({
            ref: `${ref}-${String(q.n).padStart(3, "0")}`,
            exemplarBook: exBook.code, unit: ch.n, questionNo: q.n, page: q.page,
            reason: "no-home-chapter", detail: route.why,
          });
          continue;
        }
        const book = books.get(route.target.bookCode)!;

        const verdict = classify(cleaned, answers.get(q.n), body);
        if (!verdict.ok) {
          refused++;
          rejects.push({
            ref: `${ref}-${String(q.n).padStart(3, "0")}`,
            exemplarBook: exBook.code, unit: ch.n, questionNo: q.n, page: q.page,
            reason: verdict.reason, detail: verdict.detail,
          });
          continue;
        }
        kept++;
        questions.push({
          id: `${ref}-${String(q.n).padStart(3, "0")}`,
          class: book.class,
          subject: book.subject,
          bookCode: route.target.bookCode,
          chapter: route.target.chapter,
          type: "mcq",
          question: cleaned.stem,
          options: cleaned.options,
          answer: verdict.index,
          // Every Exemplar MCQ is a one-mark objective question; the sample
          // papers print "(1)" beside each. Difficulty is left uniform for the
          // same reason — the source grades none of them, and inventing a
          // spread would be a fiction the revision schedule then acts on.
          marks: 1,
          difficulty: "medium",
          origin: "exemplar",
          provenance: {
            exemplarBook: exBook.code,
            unit: ch.n,
            unitTitle: ch.title,
            questionNo: q.n,
            page: q.page,
            file: ch.file,
            answerKey: `${exBook.code}an.pdf`,
            mapConfidence: route.confidence,
          },
        });
      }
      const filed = [
        ...new Set(
          questions.filter((x) => x.id.startsWith(`${ref}-`)).map((x) => `${x.bookCode} ch${x.chapter}`),
        ),
      ];
      const fallback = mapping.target ? `${mapping.target.bookCode} ch${mapping.target.chapter}` : "(none)";
      unitSummary.push({
        unit: `${ref} ${mapping.unitTitle} -> ${filed.join(" + ") || fallback}`,
        extracted: kept,
        refused,
        note: mapping.confidence,
      });
    }
  }

  // Deterministic order, so an unchanged corpus produces a byte-identical file.
  questions.sort((a, b) => a.id.localeCompare(b.id));
  rejects.sort((a, b) => a.ref.localeCompare(b.ref));

  const file = {
    // Taken from the corpus, not from the clock: re-running over unchanged
    // inputs must produce an identical file.
    generatedAt: exemplar.generatedAt.slice(0, 10),
    source: `NCERT Exemplar Problems. Multiple-choice questions only, extracted from public/exemplar/ by scripts/extract-exemplar-questions.ts and paired with the published answer keys. Units are filed against the current textbook chapters through ${MAP}; a unit with no home chapter there is dropped, not guessed at.`,
    classes: [...new Set(questions.map((q) => q.class))].sort((x, y) => x - y),
    counts: {
      questions: questions.length,
      rejected: rejects.length,
    },
    units: unitSummary,
    questions,
    rejects,
  };

  await writeFile(OUT, `${JSON.stringify(file, null, 2)}\n`);

  console.log(`\n${OUT}: ${questions.length} questions, ${rejects.length} refused`);
  for (const u of unitSummary) {
    console.log(`  ${u.unit.padEnd(58)} kept ${String(u.extracted).padStart(3)}  refused ${String(u.refused).padStart(3)}  (${u.note})`);
  }
  const byReason = new Map<string, number>();
  for (const r of rejects) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  console.log("\nRefusals by reason:");
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(20)} ${n}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
