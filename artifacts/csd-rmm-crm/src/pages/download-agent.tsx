import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  MousePointerClick,
  MonitorSmartphone,
  ShieldCheck,
  ArrowLeft,
  Phone,
  Apple,
  Monitor,
  Terminal,
} from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

const PHONE_DISPLAY = "954-637-7300";
const PHONE_HREF = "tel:9546377300";

type Platform = "windows" | "mac" | "linux";

const PLATFORMS: {
  id: Platform;
  label: string;
  hint: string;
  icon: typeof Monitor;
}[] = [
  { id: "windows", label: "Windows", hint: "Windows 10 & 11 (64-bit)", icon: Monitor },
  { id: "mac", label: "macOS", hint: "Intel & Apple Silicon", icon: Apple },
  { id: "linux", label: "Linux", hint: "64-bit", icon: Terminal },
];

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("linux") && !ua.includes("android")) return "linux";
  return "windows";
}

const STEPS = [
  {
    icon: Download,
    title: "1. Download",
    body: "Click the button for your computer. A small file downloads in seconds — no account or login needed.",
  },
  {
    icon: MousePointerClick,
    title: "2. Open the file",
    body: "Open your Downloads folder and double-click the file you just downloaded.",
  },
  {
    icon: MonitorSmartphone,
    title: "3. Click Connect",
    body: "A small window appears — click Connect (or Install). That's it. Your technician can now assist you.",
  },
];

export default function DownloadAgentPage() {
  const [primary, setPrimary] = useState<Platform>("windows");

  useEffect(() => {
    const prev = document.title;
    document.title = "Download Remote Support Agent | Computer Systems Depot";
    setPrimary(detectPlatform());
    return () => {
      document.title = prev;
    };
  }, []);

  const { data: status, isLoading } = useQuery<{ available: boolean }>({
    queryKey: ["/api/download/status"],
  });

  const available = status?.available ?? false;
  const ordered = [...PLATFORMS].sort((a, b) =>
    a.id === primary ? -1 : b.id === primary ? 1 : 0,
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link
          href="/portal"
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-red-600"
          data-testid="link-back-portal"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Support
        </Link>

        <div className="mt-8 text-center">
          <img src={csdLogo} alt="Computer Systems Depot" className="mx-auto h-12 w-auto" />
          <h1 className="mt-6 text-3xl font-bold text-gray-900">
            Download Remote Support Agent
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-gray-600">
            On a call or chat with a CSD technician? Download our secure remote
            support tool so we can help you right on your screen.
          </p>
        </div>

        {/* Download buttons */}
        <div className="mt-8 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          {isLoading ? (
            <div className="py-8 text-center text-gray-500">Loading…</div>
          ) : available ? (
            <div className="space-y-3">
              {ordered.map((p, i) => {
                const Icon = p.icon;
                const isPrimary = i === 0;
                return (
                  <a
                    key={p.id}
                    href={`/api/download/agent?platform=${p.id}`}
                    data-testid={`button-download-${p.id}`}
                    className={
                      isPrimary
                        ? "flex items-center justify-between gap-4 rounded-xl bg-red-600 px-5 py-4 text-white transition hover:bg-red-700"
                        : "flex items-center justify-between gap-4 rounded-xl border border-gray-200 px-5 py-4 text-gray-800 transition hover:border-gray-300 hover:bg-gray-50"
                    }
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="h-6 w-6 shrink-0" />
                      <span className="text-left">
                        <span className="block font-semibold">
                          {`Download for ${p.label}`}
                        </span>
                        <span
                          className={
                            isPrimary ? "block text-sm text-red-100" : "block text-sm text-gray-500"
                          }
                        >
                          {p.hint}
                        </span>
                      </span>
                    </span>
                    <Download className="h-5 w-5 shrink-0" />
                  </a>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl bg-amber-50 p-5 text-center text-amber-900">
              <p className="font-semibold">The download isn't available right now.</p>
              <p className="mt-1 text-sm">
                Please call us at{" "}
                <a href={PHONE_HREF} className="font-bold underline">
                  {PHONE_DISPLAY}
                </a>{" "}
                and we'll connect you.
              </p>
            </div>
          )}
        </div>

        {/* What happens next */}
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.title}
                className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
              >
                <Icon className="h-7 w-7 text-red-600" />
                <h3 className="mt-3 font-semibold text-gray-900">{s.title}</h3>
                <p className="mt-1 text-sm text-gray-600">{s.body}</p>
              </div>
            );
          })}
        </div>

        {/* Safety note */}
        <div className="mt-8 flex items-start gap-3 rounded-xl border border-yellow-300 bg-yellow-50 p-5 text-sm text-yellow-900">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            <strong className="block">Your safety comes first.</strong>
            Only download and run this tool while you're on the phone with a
            verified Computer Systems Depot technician. We will never ask you to
            install it because of a pop-up, text, or unexpected email. If you
            didn't call us, call{" "}
            <a href={PHONE_HREF} className="font-bold underline">
              {PHONE_DISPLAY}
            </a>
            .
          </p>
        </div>

        <div className="mt-8 text-center text-sm text-gray-500">
          Need help? Call us at{" "}
          <a href={PHONE_HREF} className="inline-flex items-center gap-1 font-semibold text-gray-700">
            <Phone className="h-4 w-4" />
            {PHONE_DISPLAY}
          </a>
        </div>
      </div>
    </div>
  );
}
