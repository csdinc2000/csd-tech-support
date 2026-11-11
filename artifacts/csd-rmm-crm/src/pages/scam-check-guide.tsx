import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Check, Phone, Share2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeoHead, localBusinessSchema } from "@/components/seo-head";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

type Scenario = "warning-only" | "downloaded" | "shared-access";

const SCENARIOS: Record<Scenario, { title: string; detail: string; steps: string[] }> = {
  "warning-only": {
    title: "I only saw the warning",
    detail: "A message on a screen is not proof by itself that your computer is infected.",
    steps: [
      "Don’t call a number shown in the pop-up.",
      "Don’t pay, install software, or allow remote access because the warning tells you to.",
      "Close the browser tab or quit the browser using your device’s usual controls.",
      "If you still have concerns, contact support using a number you found independently.",
    ],
  },
  downloaded: {
    title: "I clicked a link or downloaded something",
    detail: "If you are not sure what the file is, avoid opening it and get advice through a contact method you already trust.",
    steps: [
      "Don’t open the downloaded file or run an installer you weren’t expecting.",
      "Don’t use contact information from the pop-up or message.",
      "If you entered an account password, change it from a trusted device and review that account’s security settings.",
      "If you need help with the computer, describe what happened without sending the file or private account details.",
    ],
  },
  "shared-access": {
    title: "I allowed remote access or entered payment details",
    detail: "Take action through trusted contact channels. You don’t need to share sensitive details with this guide.",
    steps: [
      "End the remote session if you can.",
      "If you entered payment information, contact your bank or card provider using its official website or the number on your card.",
      "Change affected passwords from a trusted device—not through a link in the warning.",
      "For help with your computer, contact a technician using a number you found independently.",
    ],
  },
};

export default function ScamCheckGuidePage() {
  const [scenario, setScenario] = useState<Scenario>("warning-only");
  const [shareStatus, setShareStatus] = useState("");
  const selected = SCENARIOS[scenario];

  const shareGuide = async () => {
    const url = `${window.location.origin}${window.location.pathname}`;
    setShareStatus("");

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "Unexpected computer warning? Safe first steps",
          text: "A calm checklist for suspicious computer pop-ups, links, and remote-access requests.",
          url,
        });
        setShareStatus("Thanks for sharing this guide.");
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setShareStatus("Guide link copied. You can paste it into a message.");
    } catch {
      setShareStatus("Copy the guide address from your browser’s address bar to share it.");
    }
  };

  const guideSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Computer Scam Alert Safety Guide",
    description: "Safe first steps for suspicious computer alerts, links, and remote-access requests.",
    url: "https://support.computersystemsdepot.com/scam-check-guide",
    publisher: { "@id": "https://support.computersystemsdepot.com/#business" },
  };

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SeoHead
        title="Computer Scam Alert Safety Guide | CSD"
        description="See an unexpected virus pop-up? Learn safe first steps for suspicious alerts, links, or remote-access requests—without uploading files or sharing passwords."
        path="/scam-check-guide"
        schema={[localBusinessSchema, guideSchema]}
      />

      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" aria-label="Computer Systems Depot home">
            <img
              src={csdLogo}
              alt="Computer Systems Depot"
              className="h-10 w-auto"
              width="160"
              height="54"
            />
          </Link>
          <div className="flex items-center gap-2">
            <a href="tel:9546377300" className="hidden text-sm font-semibold text-csd-red sm:inline">
              954-637-7300
            </a>
            <Button asChild className="bg-csd-red text-white hover:bg-red-700">
              <Link href="/intake" data-testid="button-request-service">
                Request Service
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="bg-gray-950 text-white">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.35fr_.65fr] lg:py-20">
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-red-400">A calm safety checklist</p>
              <h1 className="mt-4 max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">
                Unexpected computer warning? Pause before you click.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-gray-300">
                Some websites use alarming messages to pressure people into calling, paying, installing software, or allowing remote access. A warning alone does not prove your computer is infected.
              </p>
            </div>
            <aside className="rounded-2xl border border-white/15 bg-white/5 p-6">
              <ShieldCheck className="h-8 w-8 text-green-400" aria-hidden="true" />
              <h2 className="mt-4 text-xl font-bold">Your privacy comes first</h2>
              <p className="mt-3 leading-7 text-gray-300">
                This guide does not ask you to upload files, send a screenshot, or enter passwords, verification codes, or payment details.
              </p>
            </aside>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-2xl font-bold">What happened?</h2>
              <p className="mt-2 text-gray-600">Choose the situation that best fits. These are general safety steps, not a device diagnosis.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={shareGuide}
              className="w-fit gap-2 border-gray-300"
              data-testid="button-share-scam-guide"
            >
              {shareStatus.startsWith("Guide link copied") ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
              {shareStatus.startsWith("Guide link copied") ? "Link copied" : "Share this guide"}
            </Button>
          </div>
          {shareStatus && (
            <p className="mt-3 text-sm text-gray-600" role="status" data-testid="status-share-guide">
              {shareStatus}
            </p>
          )}

          <div className="mt-6 grid gap-3 sm:grid-cols-3" role="group" aria-label="Choose what happened">
            {(Object.entries(SCENARIOS) as Array<[Scenario, typeof SCENARIOS[Scenario]]>).map(([key, item]) => (
              <button
                key={key}
                type="button"
                onClick={() => setScenario(key)}
                aria-pressed={scenario === key}
                data-testid={`button-scenario-${key}`}
                className={`rounded-xl border p-4 text-left font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-csd-red focus-visible:ring-offset-2 ${
                  scenario === key
                    ? "border-csd-red bg-red-50 text-gray-950"
                    : "border-gray-200 bg-white text-gray-700 hover:border-gray-400"
                }`}
              >
                {item.title}
              </button>
            ))}
          </div>

          <article className="mt-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8" aria-live="polite">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-1 h-6 w-6 shrink-0 text-amber-600" aria-hidden="true" />
              <div>
                <h3 className="text-xl font-bold" data-testid="text-selected-scenario">{selected.title}</h3>
                <p className="mt-2 leading-7 text-gray-600">{selected.detail}</p>
                <ol className="mt-5 list-decimal space-y-3 pl-5 leading-7 text-gray-800">
                  {selected.steps.map((step) => <li key={step}>{step}</li>)}
                </ol>
              </div>
            </div>
          </article>

          <aside className="mt-8 rounded-xl bg-gray-50 p-6">
            <h2 className="text-lg font-bold">A few things to remember</h2>
            <ul className="mt-4 space-y-3 text-gray-700">
              <li className="flex gap-3"><Check className="mt-1 h-5 w-5 shrink-0 text-green-700" />Don’t call a number shown in an unexpected warning.</li>
              <li className="flex gap-3"><Check className="mt-1 h-5 w-5 shrink-0 text-green-700" />Don’t give a stranger remote access because a pop-up tells you to.</li>
              <li className="flex gap-3"><Check className="mt-1 h-5 w-5 shrink-0 text-green-700" />Use contact details you found independently when seeking help.</li>
            </ul>
          </aside>

          <section className="mt-10 rounded-2xl bg-gray-950 p-6 text-white sm:p-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-2xl font-bold">Need help with your computer?</h2>
                <p className="mt-2 max-w-2xl leading-7 text-gray-300">
                  Computer Systems Depot serves Lauderhill and nearby South Florida communities. Contact us using the details on this page—not a number in a pop-up.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-3">
                <Button asChild variant="outline" className="border-white/40 bg-transparent text-white hover:bg-white/10">
                  <a href="tel:9546377300" data-testid="button-call-csd">
                    <Phone className="mr-2 h-4 w-4" />Call CSD
                  </a>
                </Button>
                <Button asChild className="bg-csd-red text-white hover:bg-red-700">
                  <Link href="/intake" data-testid="button-start-service-request">
                    Request Service
                  </Link>
                </Button>
              </div>
            </div>
            <p className="mt-5 border-t border-white/15 pt-4 text-sm leading-6 text-gray-400">
              This checklist provides general information and cannot confirm whether a device is infected or replace advice from your bank, account provider, or a qualified technician.
            </p>
          </section>
        </section>
      </main>

      <footer className="bg-gray-950 text-gray-300">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 px-4 py-8 text-sm sm:flex-row sm:px-6">
          <p>Computer Systems Depot Inc. · Lauderhill, Florida</p>
          <nav className="flex flex-wrap gap-4" aria-label="Guide pages">
            <Link href="/">Home</Link>
            <Link href="/virus-removal-lauderhill">Virus removal service</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
