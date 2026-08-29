import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import PaperAttempt from "@/components/PaperAttempt";
import { allPapers, getPaper, questionsFor } from "@/lib/papers";

/*
 * One statically exported route per sample paper. Everything the runner needs is
 * resolved here at build time and handed down as plain data: the attempt store
 * is Dexie-backed, so nothing below this file can be a server component.
 */
export function generateStaticParams() {
  return allPapers().map((paper) => ({ slug: paper.slug }));
}

export default async function PracticePaperPage({ params }: PageProps<"/practice/[slug]">) {
  const { slug } = await params;
  const paper = getPaper(slug);
  if (!paper) notFound();

  return (
    <>
      <AppHeader
        title={paper.title}
        subtitle={`Class ${paper.class} · ${paper.subject} · ${paper.session}`}
        back={{ href: "/practice", label: "practice papers" }}
      />
      <PaperAttempt paper={paper} questions={questionsFor(paper)} />
    </>
  );
}
