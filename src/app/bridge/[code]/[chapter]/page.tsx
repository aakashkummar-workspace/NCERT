import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import MicroBridge from "@/components/MicroBridge";
import { bridgeChapters, bridgesForChapter } from "@/lib/bridge";
import { getBook, getChapter } from "@/lib/manifest";

/**
 * Routes come from data/prerequisites.json, not from the manifest.
 *
 * Unlike /quiz, an empty page here would be worse than a missing one: a student
 * who followed an offer and landed on "no run-up yet" has been sent somewhere
 * for nothing. So only chapters that actually have a bridge get a route, and
 * everything is prerendered at build time — the review has to open instantly
 * and offline, since it is read mid-quiz.
 */
export function generateStaticParams() {
  return bridgeChapters().map(({ code, chapter }) => ({ code, chapter: String(chapter) }));
}

export default async function BridgePage({ params }: PageProps<"/bridge/[code]/[chapter]">) {
  const { code, chapter: chapterParam } = await params;
  const n = Number(chapterParam);

  const book = getBook(code);
  const chapter = getChapter(code, n);
  const bridges = bridgesForChapter(code, n);
  if (!book || !chapter || bridges.length === 0) notFound();

  return (
    <>
      <AppHeader
        title={`Run-up to ${chapter.title}`}
        subtitle={`Class ${book.class} · ${book.subject} · chapter ${chapter.n}`}
        back={{ href: "/bridge", label: "bridges" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <MicroBridge bridges={bridges} />
      </main>
    </>
  );
}
