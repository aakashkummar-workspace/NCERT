import AppHeader from "@/components/AppHeader";
import AnswerCapture from "@/components/AnswerCapture";

export const metadata = { title: "Photograph your answers — NCERT Quick" };

export default function SubmitPage() {
  return (
    <>
      <AppHeader
        title="Photograph your answers"
        subtitle="Written answers, marked against the official scheme"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <AnswerCapture />
      </main>
    </>
  );
}
