import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Monitor,
  Wrench,
  ShieldCheck,
  Network,
  HardDrive,
  Headphones,
  Phone,
  Mail,
  MapPin,
  Clock,
  ArrowRight,
  KeyRound,
  Building2,
  CheckCircle2,
  Search,
  Zap,
  Cpu,
  Home,
  Smartphone,
  DatabaseBackup,
  Server,
  Truck,
  Calendar,
  BadgeCheck,
  Gamepad2,
  Menu,
  X,
} from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

const PHONE_DISPLAY = "954-637-7300";
const PHONE_HREF = "tel:9546377300";
const SUPPORT_EMAIL = "support@computersystemsdepot.com";
const REMOTE_URL = "https://remote.computersystemsdepot.com";
const HERO_VIDEO = "/hero.mp4";
const HERO_POSTER = "/hero-poster.jpg";

const PUBLIC_NAV_ITEMS = [
  { label: "Services", href: "#services" },
  { label: "Repairs", href: "#repairs" },
  { label: "Websites & Apps", href: "/web-app-intake", route: true },
  { label: "Remote Support", href: "#remote" },
  { label: "Company", href: "#company" },
  { label: "Contact", href: "#contact" },
  { label: "Client Portal", href: "/portal", route: true },
] as const;

const STATS = [
  { value: "Since 1996", label: "Locally owned & operated" },
  { value: "27+ Years", label: "Diagnostic expertise" },
  { value: "Lauderhill, FL", label: "Serving South Florida" },
  { value: "Residential & Enterprise", label: "Homes and businesses" },
];

// "We don't just fix the surface issue." — The CSD philosophy (PDF pillars)
const PILLARS = [
  {
    icon: Search,
    title: "Obsessive Diagnostics",
    body: "We don't just fix the surface issue — we actively hunt for the secondary problems before they escalate.",
  },
  {
    icon: ShieldCheck,
    title: "Radical Transparency",
    body: "No surprises. If there's a fix you can safely do yourself, we'll give you the information to do it.",
  },
  {
    icon: Zap,
    title: "Unmatched Speed",
    body: "Decades of experience mean we often know the solution the moment we finish diagnostics.",
  },
];

// Mind map: Core IT Services — the CSD ecosystem (PDF "CSD Ecosystem" venn)
const ECOSYSTEM = [
  {
    icon: Building2,
    title: "Enterprise & Business IT",
    points: [
      "Managed services & maintenance",
      "Network installation & security",
      "Data backup & server setup",
      "Shared internet office solutions",
    ],
  },
  {
    icon: Cpu,
    title: "Core Expertise",
    featured: true,
    points: [
      "Deep diagnostics",
      "Advanced data recovery",
      "Remote support infrastructure",
    ],
  },
  {
    icon: Home,
    title: "Residential Services",
    points: [
      "Comprehensive hardware repair",
      "Mobile device screen replacement",
      "Virus removal & OS upgrades",
      "Home theater & A/V setup",
    ],
  },
];

// Mind map: Specialized Repairs — Hardware, Mobile, Security
const SPECIALIZED = [
  {
    icon: HardDrive,
    title: "Hardware Components",
    body: "Display & interface, core infrastructure, and power & peripherals.",
    points: [
      "LCD screen replacements & keyboard repairs",
      "Motherboard, RAM, and hard drive swaps",
      "Battery, power supply & peripheral fixes",
    ],
  },
  {
    icon: Smartphone,
    title: "Mobile Devices",
    body: "Fast turnaround on phones, tablets, and laptops.",
    points: [
      "Cracked screen & touch-panel calibration",
      "Battery and charge-port replacement",
      "Data transfer between devices",
    ],
  },
  {
    icon: ShieldCheck,
    title: "Security & Optimization",
    body: "Threat neutralization and system health.",
    points: [
      "Deep virus, malware & spyware removal",
      "Blue-screen fixes and PC tune-ups",
      "Windows 10/11 installs & secure deployment",
    ],
  },
];

// Mind map: Digital Solutions (PDF data recovery + enterprise IT)
const DIGITAL = [
  {
    icon: DatabaseBackup,
    title: "Data Recovery",
    body: "Our advanced protocols safely retrieve business-critical information from physically failing drives when other companies come up short.",
  },
  {
    icon: Network,
    title: "Network Engineering",
    body: "Infrastructure & security — office relocations, enterprise wired/wireless networks, VPN configuration, and secure router deployment.",
  },
  {
    icon: Server,
    title: "Business Continuity",
    body: "Zero-downtime protocols — automated and off-site backups with rapid disaster recovery to protect your critical operational data.",
  },
];

// PDF: support modalities comparison
const MODALITIES = [
  {
    icon: Monitor,
    title: "Remote Support",
    bestFor: "Software issues, tune-ups, viruses",
    speed: "Immediate / same-day",
    effort: "Zero travel required",
  },
  {
    icon: Wrench,
    title: "In-Shop Repair",
    bestFor: "Hardware failures, data recovery, screens",
    speed: "Drop-off / scheduled",
    effort: "Standard drop-off",
  },
  {
    icon: Truck,
    title: "On-Site / Mobile",
    bestFor: "Office networks, server maintenance",
    speed: "Scheduled dispatch",
    effort: "We come to your desk",
  },
];

const REMOTE_STEPS = [
  { title: "The Brief", body: "Call us and describe the issue directly to a local technician." },
  { title: "The Key", body: "Receive a unique, one-time 6-digit support code." },
  { title: "The Handshake", body: "Enter the code into our secure, encrypted client portal." },
  { title: "The Resolution", body: "A live technician connects, diagnoses, and fixes it while you watch." },
];

// Mind map: Company Information
const COMPANY = [
  { icon: Calendar, title: "Founded 1996", body: "Nearly three decades serving South Florida." },
  { icon: MapPin, title: "Lauderhill, FL based", body: "5601 NW 13 Street, Lauderhill, FL 33313." },
  { icon: BadgeCheck, title: "CSD certified techs", body: "Experienced, vetted technicians on every job." },
  { icon: ShieldCheck, title: "No fix, no fees", body: "If we can't solve it, you don't pay." },
  { icon: Gamepad2, title: "Tweek Geeks Division", body: "Custom builds, gaming rigs, and performance tuning." },
];

const SERVICE_AREA =
  "Proudly serving Lauderhill, Fort Lauderdale, Plantation, Weston, Coral Springs, and the wider South Florida region.";

export default function LandingPage() {
  const [playVideo, setPlayVideo] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const prev = document.title;
    document.title =
      "CSD — Computer Repair & Managed IT in South Florida | Computer Systems Depot";
    return () => {
      document.title = prev;
    };
  }, []);

  // Respect users who prefer reduced motion — show the poster instead of the video.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPlayVideo(!mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Top nav */}
      <header className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href="/" className="flex items-center gap-2" aria-label="Computer Systems Depot home">
            <img src={csdLogo} alt="Computer Systems Depot" className="h-9 w-auto" />
          </a>
          <nav className="hidden items-center gap-5 text-sm font-medium text-gray-600 lg:flex" aria-label="Primary navigation">
            {PUBLIC_NAV_ITEMS.map((item) =>
              item.route ? (
                <Link key={item.label} href={item.href} className="whitespace-nowrap transition-colors hover:text-csd-red">
                  {item.label}
                </Link>
              ) : (
                <a key={item.label} href={item.href} className="whitespace-nowrap transition-colors hover:text-csd-red">
                  {item.label}
                </a>
              ),
            )}
          </nav>
          <div className="flex items-center gap-2">
            <a href={PHONE_HREF} className="hidden sm:block">
              <Button variant="outline" className="border-csd-red text-csd-red hover:bg-csd-red hover:text-white">
                <Phone className="mr-2 h-4 w-4" />
                {PHONE_DISPLAY}
              </Button>
            </a>
            <Link href="/intake">
              <Button className="hidden bg-csd-red text-white hover:bg-red-700 sm:inline-flex">Start a Request</Button>
            </Link>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="lg:hidden"
              aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>
        {mobileMenuOpen && (
          <nav className="border-t border-gray-200 bg-white px-4 py-3 shadow-lg lg:hidden" aria-label="Mobile navigation">
            <div className="mx-auto grid max-w-6xl gap-1">
              {PUBLIC_NAV_ITEMS.map((item) =>
                item.route ? (
                  <Link
                    key={item.label}
                    href={item.href}
                    className="rounded-md px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-red-50 hover:text-csd-red"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {item.label}
                  </Link>
                ) : (
                  <a
                    key={item.label}
                    href={item.href}
                    className="rounded-md px-3 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-red-50 hover:text-csd-red"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {item.label}
                  </a>
                ),
              )}
              <Link href="/intake" onClick={() => setMobileMenuOpen(false)}>
                <Button className="mt-2 w-full bg-csd-red text-white hover:bg-red-700">Start a Request</Button>
              </Link>
            </div>
          </nav>
        )}
      </header>

      {/* Hero with video background */}
      <section className="relative isolate overflow-hidden bg-gray-950 text-white">
        {playVideo ? (
          <video
            className="absolute inset-0 h-full w-full object-cover opacity-75"
            autoPlay
            loop
            muted
            playsInline
            poster={HERO_POSTER}
            aria-hidden="true"
          >
            <source src={HERO_VIDEO} type="video/mp4" />
          </video>
        ) : (
          <img
            src={HERO_POSTER}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover opacity-75"
          />
        )}
        {/* Readability overlay — dark on the left for text, lighter on the right to show the footage */}
        <div className="absolute inset-0 bg-gradient-to-r from-gray-950/95 via-gray-950/70 to-gray-950/25" />
        <div className="absolute inset-0 bg-gradient-to-t from-gray-950/70 to-transparent" />

        <div className="relative mx-auto max-w-6xl px-4 py-24 sm:px-6 md:py-32">
          <div className="max-w-2xl space-y-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide backdrop-blur">
              <Headphones className="h-3.5 w-3.5" />
              Computer Systems Depot · Since 1996
            </span>
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl md:text-6xl">
              South Florida's Premier{" "}
              <span className="text-csd-red">Technology Partner</span>
            </h1>
            <p className="max-w-xl text-lg text-gray-200">
              Comprehensive device repair and managed IT — engineered for reliability
              since 1996. Get help in our shop, on-site, or remotely from wherever you are.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/intake">
                <Button size="lg" className="bg-csd-red text-white hover:bg-red-700">
                  Start a Service Request
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </Link>
              <a href="#remote">
                <Button
                  size="lg"
                  variant="outline"
                  className="border-white/40 bg-transparent text-white hover:bg-white/10"
                >
                  <Monitor className="mr-2 h-5 w-5" />
                  Get Remote Support
                </Button>
              </a>
            </div>
            <p className="text-sm text-gray-300">
              No fix, no surprise fees · Same-day remote sessions available
            </p>
          </div>
        </div>
      </section>

      {/* Stats strip */}
      <section className="border-b border-gray-200 bg-gray-50">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px overflow-hidden px-4 sm:px-6 md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.value} className="px-2 py-6 text-center">
              <p className="text-lg font-extrabold text-gray-900 sm:text-xl">{s.value}</p>
              <p className="mt-1 text-xs text-gray-500">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why CSD — pillars */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">Why Computer Systems Depot</h2>
          <p className="mt-3 text-gray-600">
            27+ years of diagnostic expertise plus lean, low-overhead operations means
            enterprise-grade support — priced for SMBs and local residents.
          </p>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {PILLARS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-gray-200 bg-white p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-csd-red/10 text-csd-red">
                <Icon className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-gray-600">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Core IT Services — the CSD ecosystem */}
      <section id="services" className="border-y border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Core IT Services</h2>
            <p className="mt-3 text-gray-600">
              One team for homes and businesses — built on the same core expertise.
            </p>
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {ECOSYSTEM.map(({ icon: Icon, title, points, featured }) => (
              <div
                key={title}
                className={`rounded-xl border bg-white p-6 ${
                  featured ? "border-csd-red/50 shadow-md ring-1 ring-csd-red/20" : "border-gray-200"
                }`}
              >
                <div
                  className={`flex h-11 w-11 items-center justify-center rounded-lg ${
                    featured ? "bg-csd-red text-white" : "bg-csd-red/10 text-csd-red"
                  }`}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <ul className="mt-3 space-y-2 text-sm text-gray-600">
                  {points.map((p) => (
                    <li key={p} className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Specialized Repairs */}
      <section id="repairs" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">Specialized Repairs</h2>
          <p className="mt-3 text-gray-600">
            Supporting all major brands including Apple, Dell, Lenovo, HP, Asus, and custom builds.
          </p>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {SPECIALIZED.map(({ icon: Icon, title, body, points }) => (
            <div
              key={title}
              className="group rounded-xl border border-gray-200 bg-white p-6 transition hover:border-csd-red/40 hover:shadow-md"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-csd-red/10 text-csd-red">
                <Icon className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-gray-600">{body}</p>
              <ul className="mt-3 space-y-2 text-sm text-gray-600">
                {points.map((p) => (
                  <li key={p} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Digital Solutions */}
      <section className="border-y border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Digital Solutions</h2>
            <p className="mt-3 text-gray-600">
              Recover what matters and keep your business running without interruption.
            </p>
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {DIGITAL.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-gray-200 bg-white p-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-csd-red/10 text-csd-red">
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-gray-600">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Support modalities comparison */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">How we can help you</h2>
          <p className="mt-3 text-gray-600">
            Choose the support that fits — every path leads to the same certified techs.
          </p>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {MODALITIES.map(({ icon: Icon, title, bestFor, speed, effort }) => (
            <div key={title} className="rounded-xl border border-gray-200 bg-white p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-csd-red/10 text-csd-red">
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold">{title}</h3>
              </div>
              <dl className="mt-4 space-y-3 text-sm">
                <div>
                  <dt className="font-semibold text-gray-900">Best for</dt>
                  <dd className="text-gray-600">{bestFor}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-gray-900">Speed</dt>
                  <dd className="text-gray-600">{speed}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-gray-900">Your effort</dt>
                  <dd className="text-gray-600">{effort}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </section>

      {/* Remote support workflow */}
      <section id="remote" className="border-y border-gray-200 bg-gray-900 text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 md:grid-cols-2">
          <div className="space-y-5">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
              <KeyRound className="h-3.5 w-3.5" />
              Live Remote Session
            </span>
            <h2 className="text-3xl font-bold tracking-tight">Get help without leaving home</h2>
            <p className="max-w-lg text-gray-300">
              Call us first and a technician will give you a one-time, 6-digit support
              code. Open our secure remote portal, enter the code, and we'll connect to
              your computer to fix the problem together. No fix, no surprise fees — your
              connection ends the moment the session does.
            </p>
            <div className="flex flex-wrap gap-3">
              <a href={REMOTE_URL} target="_blank" rel="noopener noreferrer">
                <Button size="lg" className="bg-csd-red text-white hover:bg-red-700">
                  Launch Remote Support
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </a>
              <a href={PHONE_HREF}>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-white/30 bg-transparent text-white hover:bg-white/10"
                >
                  <Phone className="mr-2 h-5 w-5" />
                  Call for a Code
                </Button>
              </a>
            </div>
          </div>
          <ol className="space-y-4">
            {REMOTE_STEPS.map((step, i) => (
              <li key={step.title} className="flex items-start gap-4 rounded-xl bg-white/5 p-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-csd-red font-bold text-white">
                  {i + 1}
                </span>
                <div className="pt-0.5">
                  <p className="font-semibold">{step.title}</p>
                  <p className="text-sm text-gray-300">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Company information */}
      <section id="company" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">About Computer Systems Depot</h2>
          <p className="mt-3 text-gray-600">
            Quality you can afford. Expertise you can trust.
          </p>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {COMPANY.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex items-start gap-4 rounded-xl border border-gray-200 bg-white p-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-csd-red/10 text-csd-red">
                <Icon className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-gray-600">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Contact & operations */}
      <section id="contact" className="border-t border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Contact &amp; operations</h2>
            <p className="mt-3 text-gray-600">{SERVICE_AREA}</p>
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            <a
              href={PHONE_HREF}
              className="rounded-xl border border-gray-200 bg-white p-6 text-center transition hover:border-csd-red/40 hover:shadow-md"
            >
              <Phone className="mx-auto h-7 w-7 text-csd-red" />
              <h3 className="mt-3 font-semibold">Call us</h3>
              <p className="mt-1 font-bold text-csd-red">{PHONE_DISPLAY}</p>
            </a>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="rounded-xl border border-gray-200 bg-white p-6 text-center transition hover:border-csd-red/40 hover:shadow-md"
            >
              <Mail className="mx-auto h-7 w-7 text-csd-red" />
              <h3 className="mt-3 font-semibold">Email support</h3>
              <p className="mt-1 break-all text-sm text-gray-600">{SUPPORT_EMAIL}</p>
            </a>
            <div className="rounded-xl border border-gray-200 bg-white p-6 text-center">
              <MapPin className="mx-auto h-7 w-7 text-csd-red" />
              <h3 className="mt-3 font-semibold">Visit us</h3>
              <p className="mt-1 text-sm text-gray-600">
                5601 NW 13 Street
                <br />
                Lauderhill, FL 33313
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-6 text-center">
              <Clock className="mx-auto h-7 w-7 text-csd-red" />
              <h3 className="mt-3 font-semibold">Hours</h3>
              <p className="mt-1 text-sm text-gray-600">
                Monday – Friday
                <br />
                5:00 AM – 11:00 PM
              </p>
            </div>
          </div>
          <div className="mt-10 text-center">
            <Link href="/intake">
              <Button size="lg" className="bg-csd-red text-white hover:bg-red-700">
                Start a Service Request
                <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-gray-500 sm:px-6 md:flex-row">
          <div className="flex items-center gap-3">
            <img src={csdLogo} alt="Computer Systems Depot" className="h-7 w-auto" />
            <span>&copy; {new Date().getFullYear()} Computer Systems Depot</span>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link href="/intake" className="hover:text-csd-red">Service Request</Link>
            <a href={REMOTE_URL} target="_blank" rel="noopener noreferrer" className="hover:text-csd-red">
              Remote Support
            </a>
            <Link href="/portal" className="hover:text-csd-red">Client Portal</Link>
            <Link href="/privacy" className="hover:text-csd-red">Privacy</Link>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-csd-red">Contact</a>
            <Link href="/dashboard" className="hover:text-csd-red">Staff Login</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
