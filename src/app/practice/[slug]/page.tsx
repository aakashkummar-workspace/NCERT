import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import PaperAttempt from "@/components/PaperAttempt";
import PaperReading from "@/components/PaperReading";
import { allPapers, getPaper, isScorable, questionsFor } from "@/lib/papers";

/*
 * One statically exported route per sample paper. Everything the runner needs is
 * resolved here at build time and handed down as plain data: the attempt store
 * is Dexie-backed, so nothing below this file can be a server component.
 *
 * Which of the two screens a paper gets is decided here, at build time, from
 * `isScorable` — so a paper with no mark grid never mounts the runner at all,
 * rather than mounting it and hiding the parts that cannot work.
 */
export function generateStaticParams() {
  return allPapers().map((paper) => ({ slug: paper.slug }));
}

export default async function PracticePaperPage({ params }: PageProps<"/practice/[slug]">) {
  const { slug } = await params;
  const paper = getPaper(slug);
  if (!paper) notFound();

  // The read-only marker is not appended to the subtitle: that line already
  // runs to the ellipsis on a phone for a subject like "English (Language &
  // Literature)", and a marker that truncates is worse than none. PaperReading
  // carries it in a pill of its own, immediately below.
  const scorable = isScorable(paper);

  return (
    <>
      <AppHeader
        title={paper.title}
        subtitle={`Class ${paper.class} · ${paper.subject} · ${paper.session}`}
        back={{ href: "/practice", label: "practice papers" }}
      />
      {scorable ? (
        <PaperAttempt paper={paper} questions={questionsFor(paper)} />
      ) : (
        <PaperReading paper={paper} />
      )}
    </>
  );
}
