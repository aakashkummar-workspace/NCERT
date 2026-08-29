import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import QuizSubjectView from "@/components/QuizSubjectView";
import { CLASSES, getSubject, isClassNum, subjectsForClass } from "@/lib/manifest";
import { chapterGroups, looseQuestions } from "@/lib/quiz";

/**
 * Routes come from the *manifest*, not from the question bank.
 *
 * Every subject a class has gets a page whether or not anyone has written
 * questions for it, which keeps the export's shape stable as the bank fills up
 * and means a link to an empty subject lands on a page that explains itself
 * rather than a 404. It also keeps `generateStaticParams` from ever returning
 * an empty array on a fresh checkout.
 */
export function generateStaticParams() {
  return CLASSES.flatMap((cls) =>
    subjectsForClass(cls).map((s) => ({ class: String(cls), subject: s.slug })),
  );
}

export default async function SubjectQuizPage({ params }: PageProps<"/quiz/[class]/[subject]">) {
  const { class: classParam, subject: subjectSlug } = await params;
  const cls = Number(classParam);
  if (!isClassNum(cls)) notFound();

  const subject = getSubject(cls, subjectSlug);
  if (!subject) notFound();

  // Sliced at build time: only this subject's questions reach the client.
  const groups = chapterGroups(cls, subjectSlug);
  const loose = looseQuestions(cls, subjectSlug);
  const count = groups.reduce((n, g) => n + g.questions.length, 0) + loose.length;

  return (
    <>
      <AppHeader
        title={subject.name}
        subtitle={
          count === 0
            ? `Class ${cls} · no questions yet`
            : `Class ${cls} · ${count} ${count === 1 ? "question" : "questions"}`
        }
        back={{ href: "/quiz", label: "quiz" }}
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <QuizSubjectView cls={cls} subject={subject.name} groups={groups} loose={loose} />
      </main>
    </>
  );
}
