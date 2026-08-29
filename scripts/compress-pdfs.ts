/**
 * Parallel track — shrink the mirrored chapter PDFs in place.
 *
 * The mirror is ~509 MB and the app is aimed at students on metered Indian
 * mobile data, so the download size is the single biggest barrier to installing
 * it. Ghostscript's /ebook preset with images resampled to 150 dpi typically
 * takes NCERT's scans down by 3-4x while staying comfortably readable on a
 * phone; text stays vector, so it does not blur.
 *
 * Safe to re-run: every chapter this pass has touched has a pristine copy under
 * data/ncert-original/, and the presence of that copy is what marks the chapter
 * as done — so an interrupted run resumes where it stopped and a completed run
 * is a no-op. The backup is also the undo button: copy the tree back over
 * public/ncert/. It is gitignored, so it costs local disk only.
 *
 * Ghostscript rewrites a PDF rather than editing it, and a rewrite can come out
 * *larger* (for an already-optimised file) or truncated (a crash mid-write).
 * Neither result is ever kept: the output goes to a temp file and only replaces
 * the chapter once it is verified to be a real PDF and genuinely smaller.
 */
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Manifest } from "./lib/ncert";

const OUT_ROOT = "public/ncert";
/** Pristine pre-compression copies. Already gitignored. */
const ORIG_ROOT = "data/ncert-original";

/** Tried in order; the first that answers --version wins. Windows names first. */
const GS_CANDIDATES = ["gswin64c", "gswin32c", "gs"];

/*
 * The Windows installer does not add gs to the PATH of shells that were already
 * open, so fall back to the standard install root before giving up.
 */
const GS_INSTALL_ROOTS = ["C:/Program Files/gs", "C:/Program Files (x86)/gs"];
const GS_INSTALL_HINT = "winget install ArtifexSoftware.GhostScript";

/** No single chapter should take this long; a hang would stall the whole run. */
const GS_TIMEOUT_MS = 5 * 60 * 1000;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pct(before: number, after: number): string {
  if (before <= 0) return "0%";
  return `${Math.round((1 - after / before) * 100)}%`;
}

/** Locate a working Ghostscript binary, or null if none is installed. */
function findGhostscript(): string | null {
  for (const bin of GS_CANDIDATES) {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
    // `error` is set when the binary is not on PATH at all.
    if (!probe.error && probe.status === 0) return bin;
  }

  // Not on PATH: look where the Windows installer actually puts it. A shell
  // opened before the install will not have picked up the PATH change.
  for (const root of GS_INSTALL_ROOTS) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root)) {
      for (const name of ["gswin64c.exe", "gswin32c.exe", "gs.exe"]) {
        const candidate = `${root}/${version}/bin/${name}`;
        if (!existsSync(candidate)) continue;
        const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
        if (!probe.error && probe.status === 0) return candidate;
      }
    }
  }
  return null;
}

/**
 * Rewrite `input` to `output` with the /ebook preset. Returns false on any
 * non-zero exit, timeout or missing output, leaving the caller to keep the
 * original.
 */
function runGhostscript(gs: string, input: string, output: string): boolean {
  const res = spawnSync(
    gs,
    [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.5",
      /*
       * Explicit downsampling rather than -dPDFSETTINGS=/ebook.
       *
       * The /ebook and /printer presets silently DROP images: on a sample
       * chapter they cut the page from 3 image-paint operations to 1, and what
       * disappeared was NCERT's diagonal "not to be republished" watermark —
       * their own copyright notice. Stripping a rights-holder's notice while
       * republishing their file is materially worse than republishing it
       * intact, so the presets cannot be used here.
       *
       * These flags downsample images to 150 dpi and nothing else. Measured on
       * jemh101: preset 29% of original with the watermark gone, these flags
       * 31% with all 3 image operations intact. Four points of size is a cheap
       * price for not altering the source.
       */
      "-dDownsampleColorImages=true",
      "-dColorImageResolution=150",
      "-dDownsampleGrayImages=true",
      "-dGrayImageResolution=150",
      "-dDownsampleMonoImages=true",
      "-dMonoImageResolution=300",
      "-dNOPAUSE",
      "-dBATCH",
      "-dQUIET",
      `-sOutputFile=${output}`,
      input,
    ],
    { encoding: "utf8", timeout: GS_TIMEOUT_MS },
  );
  return !res.error && res.status === 0 && existsSync(output);
}

/** A rewrite is only worth keeping if it is a real PDF and actually smaller. */
async function acceptable(tmpPath: string, sizeBefore: number): Promise<Buffer | null> {
  const buf = await readFile(tmpPath);
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  if (buf.byteLength >= sizeBefore) return null;
  return buf;
}

async function main() {
  const gs = findGhostscript();
  if (!gs) {
    // A missing external tool is a setup problem, not a bug: say what to do
    // about it in one line rather than throwing a stack trace at the user.
    console.error("Ghostscript is not installed.");
    console.error(`Looked for: ${GS_CANDIDATES.join(", ")} — none found on PATH.`);
    console.error("");
    console.error("Install it, then re-run this script:");
    console.error(`  ${GS_INSTALL_HINT}`);
    console.error("");
    console.error("Nothing was read or written. No files were changed.");
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile("data/manifest.json", "utf8")) as Manifest;

  const total = manifest.books.reduce((n, b) => n + b.chapters.length, 0);
  let done = 0;
  let compressed = 0;
  let skipped = 0;
  let kept = 0;
  let failed = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  // Persist progress regularly so an interrupted run loses at most a few entries.
  const save = () => writeFile("data/manifest.json", JSON.stringify(manifest, null, 2));

  console.log(`Using ${gs} on ${total} chapters (150 dpi images, presets avoided).`);
  console.log(`Originals are preserved in ${ORIG_ROOT}/.`);

  for (const book of manifest.books) {
    const dir = `${OUT_ROOT}/${book.code}`;
    const origDir = `${ORIG_ROOT}/${book.code}`;
    console.log(`\n[${book.code}] ${book.title} (${book.chapters.length} chapters)`);

    for (const ch of book.chapters) {
      done++;
      const path = `${dir}/${ch.file}`;
      const origPath = `${origDir}/${ch.file}`;
      const tmpPath = `${path}.gs-tmp`;
      const prefix = `  ${String(done).padStart(3)}/${total} ${ch.file}`;

      if (!existsSync(path)) {
        failed++;
        console.log(`${prefix}  MISSING (run content:pdfs first)`);
        continue;
      }

      // A backup exists only for chapters this pass has already decided on, so
      // its presence alone means "done". Comparing the two hashes says which way
      // that decision went — the same use of sha256 that fetch-pdfs.ts makes to
      // tell an already-correct file from one that still needs fetching.
      if (existsSync(origPath)) {
        const [live, orig] = await Promise.all([readFile(path), readFile(origPath)]);
        ch.originalBytes ??= orig.byteLength;
        ch.bytes = live.byteLength;
        bytesBefore += orig.byteLength;
        bytesAfter += live.byteLength;
        if (sha256(live) === sha256(orig)) {
          // Ghostscript could not improve this one last time. It is
          // deterministic, so there is nothing to gain by paying for it again.
          kept++;
          console.log(`${prefix}  keep (${mb(live.byteLength)}, no gain)`);
        } else {
          skipped++;
          console.log(`${prefix}  skip (${mb(live.byteLength)}, already compressed)`);
        }
        continue;
      }

      const before = await readFile(path);
      const sizeBefore = before.byteLength;
      bytesBefore += sizeBefore;

      const ran = runGhostscript(gs, path, tmpPath);
      const shrunk = ran ? await acceptable(tmpPath, sizeBefore) : null;

      // Back the original up only now: a crash before this point leaves no
      // backup, so the chapter is retried next run rather than marked done.
      await mkdir(origDir, { recursive: true });
      await copyFile(path, origPath);

      // Set once and never overwritten, so it stays the true pre-compression
      // size even if this pass is ever run again with different settings.
      ch.originalBytes ??= sizeBefore;

      if (!shrunk) {
        if (existsSync(tmpPath)) await unlink(tmpPath);
        ch.bytes = sizeBefore;
        bytesAfter += sizeBefore;
        if (!ran) {
          failed++;
          console.log(`${prefix}  FAILED ghostscript (${mb(sizeBefore)}, original kept)`);
        } else {
          kept++;
          console.log(`${prefix}  keep (${mb(sizeBefore)}, no gain)`);
        }
        continue;
      }

      await rename(tmpPath, path);
      ch.bytes = shrunk.byteLength;
      // Re-hash: fetch-pdfs.ts skips a chapter whose file matches the recorded
      // sha256, so leaving the pre-compression hash here would make it
      // re-download every compressed chapter (~509 MB).
      ch.sha256 = sha256(shrunk);
      bytesAfter += shrunk.byteLength;
      compressed++;
      console.log(
        `${prefix}  ok (${mb(sizeBefore)} -> ${mb(shrunk.byteLength)}, -${pct(sizeBefore, shrunk.byteLength)})`,
      );

      if (compressed % 10 === 0) await save();
    }
    await save();
  }

  await save();
  console.log(`\n=== done ===`);
  console.log(`processed:  ${done}`);
  console.log(`compressed: ${compressed}`);
  console.log(`skipped:    ${skipped}`);
  console.log(`kept:       ${kept}`);
  console.log(`failed:     ${failed}`);
  console.log(`before:     ${mb(bytesBefore)}`);
  console.log(`after:      ${mb(bytesAfter)}`);
  console.log(`saved:      ${mb(bytesBefore - bytesAfter)} (${pct(bytesBefore, bytesAfter)})`);
  console.log(`\nOriginals kept in ${ORIG_ROOT}/ — copy them back over ${OUT_ROOT}/ to undo.`);
  if (failed > 0) console.log(`Re-run to retry the ${failed} chapter(s) that failed.`);

  // The manifest sha256 of every compressed chapter now describes the original
  // rather than the file on disk. That is deliberate — this pass owns `bytes`
  // and `originalBytes` only — but it means content:pdfs would see a mismatch
  // and re-download. Restore from ORIG_ROOT before re-running it.
  if (compressed > 0) {
    console.log(`manifest sha256 updated to match the compressed files.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
