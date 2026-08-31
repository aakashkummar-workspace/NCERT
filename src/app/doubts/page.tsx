import AppHeader from "@/components/AppHeader";
import DoubtList from "@/components/DoubtList";

export const metadata = { title: "Doubts — NCERT Quick" };

/**
 * The doubt registry.
 *
 * The subtitle is the whole promise of the screen and it is deliberately flat:
 * it describes what happens, not how the student should feel about needing it.
 */
export default function DoubtsPage() {
  return (
    <>
      <AppHeader
        title="Doubts"
        subtitle="Ask your class. Use Shadow Mode if you would rather not sign it."
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <DoubtList />
      </main>
    </>
  );
}
