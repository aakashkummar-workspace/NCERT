import AppHeader from "@/components/AppHeader";
import ModerationQueue from "./ModerationQueue";

export const metadata = { title: "Moderation — NCERT Quick" };

/**
 * The moderator queue. `ADMIN`, scoped to their own school.
 *
 * This page is not in the tab bar and is not linked from anywhere a student
 * goes. That is not the security boundary — every route it calls is behind
 * `requireUser("ADMIN")`, re-read from the database each request — it is just
 * that a moderation queue is not a destination in a study app.
 */
export default function ModerationPage() {
  return (
    <>
      <AppHeader
        title="Moderation"
        subtitle="Reported doubts, worst first"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <ModerationQueue />
      </main>
    </>
  );
}
