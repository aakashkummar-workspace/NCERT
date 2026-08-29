/**
 * Mirror CBSE past-year question papers for Class 9 and 10 (2020-2026) from
 * cbsepyqs.com into public/pyqs/, and record them in data/pyqs.json.
 *
 * These are NOT the same kind of asset as the sample papers in fetch-papers.ts,
 * and the difference drives the whole design:
 *
 *  - They are page *image scans* (WebP), not PDFs. There is no text layer, so
 *    nothing here can be searched, extracted or auto-graded — ever.
 *  - They ship with **no marking scheme**. The Tier 1 self-scoring flow needs an
 *    official scheme to mark against, so these cannot feed it; they are a timed
 *    reading-and-attempting archive instead.
 *  - The source is a third-party aggregator, not CBSE. Its own disclaimer says
 *    the material is "collected from various sources" with no accuracy
 *    guarantee, and its terms permit personal download but not redistribution.
 *    That is a materially weaker position than the NCERT/CBSE mirrors, and it is
 *    recorded in PERMISSIONS.md rather than buried here.
 *
 * Ordering is deliberate: the subjects this app actually teaches (Science,
 * Mathematics, Social Science, English, Hindi) are fetched first, so an
 * interrupted run still leaves the useful half of the archive on disk. The rest
 * — some 60 vocational and language subjects — follow.
 *
 * Safe to re-run: an image whose bytes are already on disk at the recorded size
 * is skipped, and data/pyqs.json is rewritten after every paper, so an
 * interrupted run resumes where it stopped. Requests are sequential with a
 * delay; this is one person's website, not a CDN.
 *
 *   npm run content:pyqs              # everything, core subjects first
 *   npm run content:pyqs -- --core    # only the five subjects the app carries
 *   npm run content:pyqs -- --limit 50
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const SITE = "https://cbsepyqs.com";
const OUT_ROOT = "public/pyqs";
const PYQS_JSON = "data/pyqs.json";
const UA = "Mozilla/5.0 (compatible; NCERTQuick/0.1; offline study app)";
const DELAY_MS = 500;
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
const CLASSES = [9, 10] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The site's slugs drop the first letter of many subjects — "CIENCE",
 * "ATHEMATICS", "OCIAL-SCIENCE", "ERIODIC-TEST". Rather than guess per case,
 * every slug is matched against a vocabulary allowing one missing leading
 * character, which repairs those and leaves intact names alone.
 */
const SUBJECT_VOCAB = [
  "MATHEMATICS-STANDARD",
  "MATHEMATICS-BASIC",
  "MATHEMATICS",
  "SCIENCE",
  "SOCIAL-SCIENCE",
  "ENGLISH-LANGUAGE-AND-LITERATURE",
  "ENGLISH-COMMUNICATIVE",
  "ENGLISH",
  "HINDI-A",
  "HINDI-B",
  "HINDI",
  "SANSKRIT",
  "INFORMATION-TECHNOLOGY",
  "COMPUTER-APPLICATIONS",
  "PERIODIC-TEST",
];

/** The five subjects the app carries; everything else is fetched afterwards. */
const CORE = new Set([
  "Mathematics",
  "Science",
  "Social Science",
  "English",
  "Hindi",
]);

interface PyqPage {
  file: string;
  bytes: number;
  sha256: string;
}

export interface Pyq {
  id: string;
  class: 9 | 10;
  year: number;
  category: string;
  /** Normalised where recognised, else a tidied version of the raw slug. */
  subject: string;
  core: boolean;
  /** Set/variant, e.g. "Set 1", when the slug carries one. */
  variant?: string;
  title: string;
  rawSlug: string;
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

async function fetchText(url: string, tries = 3): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    await sleep(DELAY_MS);
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === tries - 1) {
        console.warn(`  ! ${url} — ${(err as Error).message}`);
        return null;
      }
      await sleep(DELAY_MS * (i + 2));
    }
  }
  return null;
}

async function fetchBinary(url: string, tries = 3): Promise<Buffer | null> {
  for (let i = 0; i < tries; i++) {
    await sleep(DELAY_MS);
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i === tries - 1) {
        console.warn(`  ! ${url} — ${(err as Error).message}`);
        return null;
      }
      await sleep(DELAY_MS * (i + 2));
    }
  }
  return null;
}

const hrefs = (html: string, re: RegExp): string[] => [
  ...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => re.test(h))),
];

/** Repair a chopped leading letter by matching the vocabulary. */
function repairSlug(slug: string): string {
  const upper = slug.toUpperCase();
  for (const known of SUBJECT_VOCAB) {
    if (upper.startsWith(known)) return upper;
    // One missing leading character: "CIENCE..." against "SCIENCE".
    if (known.length > 1 && upper.startsWith(known.slice(1))) return known + upper.slice(known.length - 1);
  }
  return upper;
}

const TITLE_CASE = (s: string) =>
  s
    .toLowerCase()
    .split("-")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

/**
 * Pull a subject and a set/variant out of a paper slug.
 *
 * Order matters: the known-subject vocabulary is matched FIRST, and only the
 * leftover tail is treated as a code. Stripping codes first ate real words —
 * "SOCIAL-SCIENCE-JBB-87" lost its second half and became "Social".
 *
 * Slugs carry trailing codes that mean nothing to a student: a CBSE subject
 * code ("JBB-87"), a regional set code ("HF1EG", "KLNM"), or a date
 * ("010424-MAR"). Those are dropped from the display title and kept in
 * `rawSlug`.
 */
function parseSlug(slug: string): { subject: string; variant?: string } {
  const repaired = repairSlug(slug);

  const setMatch = repaired.match(/-SET-([0-9A-Z]+?)(?:-|$)/);
  const setVariant = setMatch ? `Set ${setMatch[1]}` : undefined;

  // Longest vocabulary match wins, so "MATHEMATICS-STANDARD" beats "MATHEMATICS".
  const known = [...SUBJECT_VOCAB]
    .sort((a, b) => b.length - a.length)
    .find((k) => repaired.startsWith(k));

  if (known) {
    const name = TITLE_CASE(known);
    if (name.startsWith("Mathematics")) return { subject: "Mathematics", variant: variantOf(name, setVariant) };
    if (name.startsWith("English")) return { subject: "English", variant: variantOf(name, setVariant) };
    if (name.startsWith("Hindi")) return { subject: "Hindi", variant: variantOf(name, setVariant) };
    return { subject: name, variant: setVariant };
  }

  // Unknown subject: drop trailing tokens that are plainly codes rather than
  // words — anything containing a digit, plus CBSE's "JBB" code prefix.
  const tokens = repaired.replace(/-SET-[0-9A-Z]+.*$/, "").split("-");
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (/\d/.test(last) || last === "JBB" || last.length <= 2) tokens.pop();
    else break;
  }
  return { subject: TITLE_CASE(tokens.join("-")), variant: setVariant };
}

/** Keep "Standard"/"Basic"/"A"/"B" in the variant, not in the subject name. */
function variantOf(fullName: string, setVariant?: string): string | undefined {
  const extra = fullName.split(" ").slice(1).join(" ");
  const parts = [extra, setVariant].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const coreOnly = args.includes("--core");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
  const dryRun = args.includes("--dry-run");

  const existing: PyqsFile = existsSync(PYQS_JSON)
    ? JSON.parse(await readFile(PYQS_JSON, "utf8"))
    : {
        source: SITE,
        fetchedAt: new Date().toISOString(),
        note:
          "Page-image scans from a third-party aggregator. No marking schemes, no text layer. See PERMISSIONS.md.",
        papers: [],
      };
  const byId = new Map(existing.papers.map((p) => [p.id, p]));

  // --- 1. discover every paper page ---------------------------------------
  console.log("discovering papers…");
  const discovered: { cls: 9 | 10; year: number; category: string; url: string; slug: string }[] = [];

  for (const cls of CLASSES) {
    for (const year of YEARS) {
      const yearHtml = await fetchText(`${SITE}/class/${cls}/year/${year}`);
      if (!yearHtml) continue;
      const cats = hrefs(yearHtml, new RegExp(`/class/${cls}/year/${year}/category/[^"]+$`));
      for (const catUrl of cats) {
        const catHtml = await fetchText(catUrl);
        if (!catHtml) continue;
        const category = decodeURIComponent(catUrl.split("/category/")[1]).replace(/\+/g, " ");
        const escaped = catUrl.split("/category/")[1].replace(/[+]/g, "\\+");
        const papers = hrefs(
          catHtml,
          new RegExp(`/class/${cls}/year/${year}/category/${escaped}/[^"]+$`),
        );
        for (const url of papers) {
          // The site uses "+" for spaces inside path segments, which
          // decodeURIComponent leaves alone — normalise before anything parses it,
          // or every "…+SET+1" reads as part of the subject name.
          const slug = decodeURIComponent(url.split("/").pop()!).replace(/\+/g, "-");
          discovered.push({ cls, year, category, url, slug });
        }
      }
      console.log(`  class ${cls} ${year}: ${discovered.length} found so far`);
    }
  }

  // --- 2. order: the subjects the app teaches first ------------------------
  const planned = discovered
    .map((d) => {
      const { subject, variant } = parseSlug(d.slug);
      return { ...d, subject, variant, core: CORE.has(subject) };
    })
    .filter((d) => (coreOnly ? d.core : true))
    .sort((a, b) => Number(b.core) - Number(a.core) || b.year - a.year || a.subject.localeCompare(b.subject));

  console.log(
    `\n${planned.length} papers to consider (${planned.filter((p) => p.core).length} in core subjects)\n`,
  );

  if (dryRun) {
    const bySubject = new Map<string, number>();
    for (const p of planned) bySubject.set(p.subject, (bySubject.get(p.subject) ?? 0) + 1);
    for (const [subject, n] of [...bySubject.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${CORE.has(subject) ? "core" : "    "}  ${String(n).padStart(4)}  ${subject}`);
    }
    console.log(`
${planned.length} papers, ${bySubject.size} distinct subjects`);
    return;
  }

  // --- 3. fetch page images -----------------------------------------------
  let done = 0;
  let downloaded = 0;
  let skipped = 0;

  const save = () =>
    writeFile(
      PYQS_JSON,
      JSON.stringify({ ...existing, fetchedAt: new Date().toISOString(), papers: [...byId.values()] }, null, 2) + "\n",
    );

  for (const p of planned) {
    if (done >= limit) break;
    done++;

    const id = `class${p.cls}-${p.year}-${p.slug.toLowerCase()}`;
    const html = await fetchText(p.url);
    if (!html) continue;

    const images = [
      ...new Set(
        [...html.matchAll(/https:\/\/cbsepyqs\.com\/webp\/[^"'\s)]+\.webp/g)].map((m) => m[0]),
      ),
    ].sort(pageOrder);
    if (images.length === 0) {
      console.log(`  · ${id}: no page images, skipped`);
      continue;
    }

    const dir = `${OUT_ROOT}/class${p.cls}/${p.year}`;
    await mkdir(dir, { recursive: true });

    const pages: PyqPage[] = [];
    for (let i = 0; i < images.length; i++) {
      const file = `${dir}/${p.slug.toLowerCase()}-${i + 1}.webp`;
      const prior = byId.get(id)?.pages[i];
      if (prior && existsSync(file) && (await stat(file)).size === prior.bytes) {
        pages.push(prior);
        skipped++;
        continue;
      }
      const buf = await fetchBinary(images[i]);
      if (!buf) continue;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, buf);
      pages.push({
        file: file.replace(`${OUT_ROOT}/`, ""),
        bytes: buf.byteLength,
        sha256: createHash("sha256").update(buf).digest("hex"),
      });
      downloaded++;
    }

    if (pages.length === 0) continue;

    byId.set(id, {
      id,
      class: p.cls,
      year: p.year,
      category: p.category,
      subject: p.subject,
      core: p.core,
      variant: p.variant,
      title: [p.subject, p.variant].filter(Boolean).join(" · "),
      rawSlug: p.slug,
      sourceUrl: p.url,
      pages,
      bytes: pages.reduce((n, pg) => n + pg.bytes, 0),
    });
    await save();

    if (done % 10 === 0 || p.core) {
      const mb = [...byId.values()].reduce((n, x) => n + x.bytes, 0) / 1048576;
      console.log(
        `  [${done}/${planned.length}] ${id} — ${pages.length}pp — ${mb.toFixed(0)} MB total`,
      );
    }
  }

  await save();
  const total = [...byId.values()].reduce((n, x) => n + x.bytes, 0);
  console.log(
    `\n${byId.size} papers on disk · ${downloaded} images downloaded, ${skipped} already present · ${(total / 1048576).toFixed(0)} MB`,
  );
}

/** "…-2.webp" before "…-10.webp"; the site zero-pads nothing. */
function pageOrder(a: string, b: string): number {
  const n = (s: string) => Number(s.match(/-(\d+)\.webp$/)?.[1] ?? 0);
  return n(a) - n(b);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
