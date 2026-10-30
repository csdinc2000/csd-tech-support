import { Link } from "wouter";
import {
  Wrench,
  Ticket,
  Monitor,
  Download,
  ArrowLeft,
  ArrowRight,
  Phone,
  FileSignature,
  Store,
} from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

const PHONE_DISPLAY = "954-637-7300";
const PHONE_HREF = "tel:9546377300";
const REMOTE_URL = "https://remote.computersystemsdepot.com";

const OPTIONS = [
  {
    icon: FileSignature,
    title: "Maintenance Agreement",
    body: "Review or sign your Computer Systems Maintenance Agreement using the secure access code we sent you.",
    href: "/portal/contract",
    external: false,
    cta: "Open agreement",
    testid: "card-maintenance-agreement",
  },
  {
    icon: Store,
    title: "Community Marketplace",
    body: "Buy or sell used computers, laptops and parts with other customers. Listing is free.",
    href: "/portal/marketplace",
    external: false,
    cta: "Browse listings",
    testid: "card-marketplace",
  },
  {
    icon: Wrench,
    title: "Submit a Request",
    body: "Tell us what's wrong with your computer and a technician will reach out.",
    href: "/intake",
    external: false,
    cta: "Start a request",
    testid: "card-submit-request",
  },
  {
    icon: Ticket,
    title: "Check Ticket Status",
    body: "Look up an existing ticket with your email and ticket number — no account needed.",
    href: "/portal/ticket",
    external: false,
    cta: "Look up ticket",
    testid: "card-check-ticket",
  },
  {
    icon: Download,
    title: "Download Remote Support Agent",
    body: "On a call with us? Download our secure support tool so a technician can help right on your screen.",
    href: "/download",
    external: false,
    cta: "Download agent",
    testid: "card-download-agent",
  },
  {
    icon: Monitor,
    title: "Remote Support Code",
    body: "Already have the agent installed? Open the secure remote portal and enter the 6-digit code we give you.",
    href: REMOTE_URL,
    external: true,
    cta: "Open remote support",
    testid: "card-remote-support",
  },
];

export default function PortalHome() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto p-6 space-y-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-red-600"
          data-testid="link-back-home"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Home
        </Link>

        <div className="text-center space-y-4">
          <img
            src={csdLogo}
            alt="Computer Systems Depot"
            className="h-16 mx-auto"
          />
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Customer Portal</h1>
            <p className="text-gray-600 mt-2">
              How can we help you today? Choose an option below to get started.
            </p>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const inner = (
              <div className="bg-white rounded-xl border p-6 h-full flex flex-col hover:border-red-300 hover:shadow-md transition">
                <div className="h-12 w-12 rounded-lg bg-red-50 text-red-600 flex items-center justify-center">
                  <Icon className="h-6 w-6" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-gray-900">
                  {opt.title}
                </h2>
                <p className="mt-2 text-sm text-gray-600 flex-1">{opt.body}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-red-600">
                  {opt.cta}
                  <ArrowRight className="h-4 w-4" />
                </span>
              </div>
            );

            if (opt.external) {
              return (
                <a
                  key={opt.title}
                  href={opt.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                  data-testid={opt.testid}
                >
                  {inner}
                </a>
              );
            }
            return (
              <Link
                key={opt.title}
                href={opt.href}
                className="block"
                data-testid={opt.testid}
              >
                {inner}
              </Link>
            );
          })}
        </div>

        <div className="text-center text-sm text-gray-600 pb-8">
          <p>Prefer to talk to someone? Give us a call.</p>
          <a
            href={PHONE_HREF}
            className="inline-flex items-center gap-2 mt-2 text-2xl font-bold text-red-600 hover:text-red-700"
            data-testid="link-phone"
          >
            <Phone className="h-5 w-5" />
            {PHONE_DISPLAY}
          </a>
          <p className="mt-2 text-gray-500">Monday - Friday: 5:00 AM - 11:00 PM</p>
        </div>
      </div>
    </div>
  );
}
