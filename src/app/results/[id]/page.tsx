import AppHeader from "@/components/AppHeader";
import GradeSync from "@/components/GradeSync";
import ScriptView from "./ScriptView";

export const metadata = { title: "Your marked script — NCERT Quick" };

/**
 * Dynamic, and deliberately so. Everything under /class, /read, /quiz,
 * /practice and /past-papers is still prerendered at build time; a marked
 * script cannot be, because it is one student's handwriting behind a session.
 */
export default function ScriptPage() {
  return (
    <>
      <AppHeader
        title="Your marked script"
        subtitle="Green earned it, orange part-earned it, red earned nothing"
        back={{ href: "/results", label: "scripts" }}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {/* This is where "See this script" from the capture flow lands, so it is
            the one screen a student opens *expecting* a mark. /revise and the
            dual-track done screen both poll; this did not, and a mark awarded
            after the page was first opened would sit on the server unread while
            the student stared at the screen built to show it.

            The cadence is unchanged and still stops on its own: `syncPending`
            returns how many written answers are outstanding, and with none —
            which is the case for a purely self-marked practice paper — the
            timer is cleared after the first pass rather than left ticking. See
            src/components/GradeSync.tsx. */}
        <div className="mb-4 empty:mb-0">
          <GradeSync />
        </div>
        <ScriptView />
      </main>
    </>
  );
}
