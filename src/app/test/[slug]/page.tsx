import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import DualTrackTest from "@/components/DualTrackTest";
import { formatDuration, getPaper, paperPdfPath, schemePdfPath } from "@/lib/papers";
import { allTests, getTest } from "@/lib/tests";

/*
 * One statically exported route per assembled test. Everything the runner needs
 * is resolved here at build time and handed down as plain data — the attempt
 * store is Dexie-backed, so nothing below this file can be a server component.
 *
 * A test's slug is its source paper's slug: the assembly is deterministic, so
 * one paper is always one test and the exported set of routes is stable between
 * builds. `assembleTest` has already refused any paper that cannot be both
 * tracks, so a route that exists is a route that can be sat.
 */
export function generateStaticParams() {
  return allTests().map((test) => ({ slug: test.slug }));
}

export default async function TestSlugPage({ params }: PageProps<"/test/[slug]">) {
  const { slug } = await params;
  const test = getTest(slug);
  const paper = test ? getPaper(test.paperSlug) : undefined;
  if (!test || !paper) notFound();

  return (
    <>
      <AppHeader
        title={test.title}
        subtitle={`Class ${test.classNum} · ${test.paperSubject} · ${test.session}`}
        back={{ href: "/test", label: "tests" }}
      />
      <DualTrackTest
        test={test}
        paperUrl={paperPdfPath(paper)}
        schemeUrl={schemePdfPath(paper)}
        durationLabel={formatDuration(test.durationMinutes)}
      />
    </>
  );
}
