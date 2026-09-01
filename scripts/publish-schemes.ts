/**
 * Gets the CBSE marking schemes to a teacher who is not sitting at this laptop.
 *
 * ## The problem this solves
 *
 * `docs/teacher-review.md` asks one teacher to settle 342 marking decisions,
 * and every one of them is read against a marking-scheme PDF under
 * `public/papers/`. Those PDFs are gitignored — deliberately, they are CBSE's
 * copyright and 37 MB besides — so a deployment built from the repository
 * contains none of them. The teacher opens the deployed app and the one thing
 * they were asked to bring is the one thing that is not there.
 *
 * Putting `public/papers/` back into the deploy is not the answer: that is a
 * public URL serving somebody else's copyright, which is exactly what
 * PERMISSIONS.md says must not happen before a permission request that has
 * still not been sent.
 *
 * So the schemes go into the same **private** object-storage bucket the app
 * already uses for answer sheets, under a `schemes/` prefix, and each one is
 * handed out as a pre-signed URL that expires. Nothing is world-readable at any
 * point; the link is a capability with a deadline, sent to one named teacher,
 * for the duration of one review.
 *
 * ## Running it
 *
 * ```bash
 * # the same S3_* variables the app uses; see DEPLOY.md
 * npx tsx scripts/publish-schemes.ts             # the 27 schemes the queue cites
 * npx tsx scripts/publish-schemes.ts --all       # every *-ms.pdf in public/papers
 * npx tsx scripts/publish-schemes.ts --ttl-days 3
 * npx tsx scripts/publish-schemes.ts --links-only   # re-sign, upload nothing
 * ```
 *
 * It writes `scripts/.tmp/teacher-schemes.md` — a list to paste into a message.
 * That directory is gitignored, which matters: a signed URL is a credential and
 * committing one publishes the file it points at for as long as it lives.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_PRESIGN_TTL_SEC } from "@/lib/s3";

const PAPERS_DIR = path.resolve("public/papers");
const QUEUE = path.resolve("data/teacher-review-queue.json");
const OUT_DIR = path.resolve("scripts/.tmp");
const PREFIX = "schemes/";

interface QueueItem {
  schemeFile?: string;
  paperTitle?: string;
  questionNo?: string | number;
  band?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Which schemes the teacher actually needs, in the order the queue asks for them. */
async function schemesFromQueue(): Promise<Map<string, Set<string>>> {
  const raw = JSON.parse(await readFile(QUEUE, "utf8")) as { queue: QueueItem[] };
  const byFile = new Map<string, Set<string>>();
  for (const item of raw.queue) {
    if (!item.schemeFile) continue;
    const papers = byFile.get(item.schemeFile) ?? new Set<string>();
    if (item.paperTitle) papers.add(item.paperTitle);
    byFile.set(item.schemeFile, papers);
  }
  return byFile;
}

async function main(): Promise<void> {
  if (process.env.STORAGE_DRIVER !== "s3") {
    // Refusing rather than defaulting: run against `local` and this would write
    // 37 MB into .storage/ and mint /api/dev/storage/ links that 404 in
    // production — a teacher with a page of dead links and no way to tell.
    throw new Error(
      "Set STORAGE_DRIVER=s3 and the S3_* variables. Signed links from the local driver " +
        "point at /api/dev/storage/, which does not exist in production.",
    );
  }
  const { default: storage } = await import("@/lib/storage");

  const ttlDays = Number(arg("ttl-days") ?? 7);
  const ttlSec = Math.min(Math.round(ttlDays * 86_400), MAX_PRESIGN_TTL_SEC);
  if (!Number.isFinite(ttlSec) || ttlSec < 60) throw new Error("--ttl-days must be at least a minute.");

  let files: string[];
  let cited: Map<string, Set<string>> = new Map();
  if (flag("all")) {
    const { readdir } = await import("node:fs/promises");
    files = (await readdir(PAPERS_DIR)).filter((f) => f.endsWith("-ms.pdf")).sort();
  } else {
    cited = await schemesFromQueue();
    files = [...cited.keys()].sort();
  }
  if (files.length === 0) throw new Error("No marking schemes found. Run `npm run content:papers` first.");

  const rows: { file: string; key: string; bytes: number; sha256: string; url: string; papers: string[] }[] = [];

  for (const file of files) {
    const key = `${PREFIX}${file}`;
    let bytes = 0;
    let sha256 = "";

    if (flag("links-only")) {
      if (!(await storage.exists(key))) {
        console.log(`  missing  ${file} — not in the bucket; run without --links-only`);
        continue;
      }
      console.log(`  signed   ${file}`);
    } else {
      const body = await readFile(path.join(PAPERS_DIR, file));
      // storageClass "document" is application/pdf at a 25 MB ceiling; the
      // content type is pinned by the driver, not guessed from the extension.
      const stored = await storage.put({ key, body, contentType: "application/pdf", storageClass: "document" });
      bytes = stored.bytes;
      sha256 = stored.sha256;
      console.log(`  uploaded ${file}  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    }

    rows.push({
      file,
      key,
      bytes,
      sha256,
      url: await storage.getSignedUrl(key, ttlSec),
      papers: [...(cited.get(file) ?? [])].sort(),
    });
  }

  const expiry = new Date(Date.now() + ttlSec * 1000);
  const lines = [
    "# Marking schemes — signed links",
    "",
    `${rows.length} PDFs. **These links stop working on ${expiry.toISOString().slice(0, 16).replace("T", " ")} UTC**`,
    `(${(ttlSec / 86_400).toFixed(1)} days from now). Re-run \`npx tsx scripts/publish-schemes.ts --links-only\` for fresh ones.`,
    "",
    "They are private: the bucket grants nothing to the public, and each link carries its own",
    "expiring signature. Do not post them anywhere they outlive the review.",
    "",
  ];
  for (const row of rows) {
    lines.push(`- [${row.file}](${row.url})`);
    if (row.papers.length) lines.push(`  <br>${row.papers.join("; ")}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "teacher-schemes.md"), lines.join("\n") + "\n", "utf8");
  await writeFile(
    path.join(OUT_DIR, "teacher-schemes.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), expiresAt: expiry.toISOString(), rows }, null, 2),
    "utf8",
  );

  const manifestSha = createHash("sha256")
    .update(rows.map((r) => `${r.key}:${r.sha256}`).join("\n"))
    .digest("hex")
    .slice(0, 12);

  console.log(`\n${rows.length} schemes, links valid until ${expiry.toISOString()} (manifest ${manifestSha}).`);
  console.log(`Written to ${path.join(OUT_DIR, "teacher-schemes.md")} — gitignored, and it contains live links.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
