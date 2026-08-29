import AppHeader from "@/components/AppHeader";
import QuizIndex from "@/components/QuizIndex";
import { quizIndex, totalQuestions } from "@/lib/quiz";

export const metadata = { title: "Quiz — NCERT Quick" };

/**
 * The quiz entry point.
 *
 * Only the *summary* is computed here and handed to the client — subject names
 * and counts, never the questions themselves. The bank is sliced per subject on
 * its own route, so opening this page costs a few hundred bytes however large
 * the bank grows.
 */
export default function QuizPage() {
  const index = quizIndex();

  return (
    <>
      <AppHeader
        title="Quiz"
        subtitle={`${totalQuestions()} questions, marked instantly`}
        back={{ href: "/", label: "home" }}
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <p className="mb-6 text-sm text-ink-soft">
          Short chapter quizzes, marked as you go with the reason for every answer. Your score
          schedules that chapter for revision, so what you get wrong comes back sooner.
        </p>

        <QuizIndex index={index} />
      </main>
    </>
  );
}
