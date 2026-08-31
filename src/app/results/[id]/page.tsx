import AppHeader from "@/components/AppHeader";
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
        <ScriptView />
      </main>
    </>
  );
}
