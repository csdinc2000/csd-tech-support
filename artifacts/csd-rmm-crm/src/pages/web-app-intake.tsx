import { useEffect } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import WebAppIntakeForm from "@/components/forms/web-app-intake-form";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Smartphone,
  ShoppingCart,
  LayoutDashboard,
  Search,
  ShieldCheck,
  Phone,
  Mail,
  MapPin,
  Clock,
  CheckCircle2,
  Gauge,
  Wrench,
} from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

const PHONE_DISPLAY = "954-637-7300";
const PHONE_HREF = "tel:9546377300";
const SUPPORT_EMAIL = "support@computersystemsdepot.com";

const SERVICES = [
  {
    icon: Globe,
    title: "Business Websites",
    body: "Fast, mobile-first sites that make it obvious what you do and how to hire you.",
  },
  {
    icon: ShoppingCart,
    title: "E-Commerce Stores",
    body: "Secure checkout, inventory and payment processing wired up end to end.",
  },
  {
    icon: Smartphone,
    title: "Mobile Apps",
    body: "iOS and Android apps for customers, field crews and internal teams.",
  },
  {
    icon: LayoutDashboard,
    title: "Web Apps & Portals",
    body: "Customer portals, booking systems and dashboards built around how you actually work.",
  },
  {
    icon: Search,
    title: "SEO & Performance",
    body: "Page-speed, accessibility and search fixes that get you found and keep visitors there.",
  },
  {
    icon: ShieldCheck,
    title: "Hosting & Maintenance",
    body: "Managed hosting, backups, SSL and security patching — the same discipline we bring to IT.",
  },
];

const PROCESS = [
  {
    step: "01",
    title: "Discovery call",
    body: "A free 30-minute conversation about your goals, customers and budget.",
  },
  {
    step: "02",
    title: "Written scope & quote",
    body: "A fixed-price proposal with deliverables and dates — no vague hourly estimates.",
  },
  {
    step: "03",
    title: "Design & build",
    body: "You review real, working previews at every milestone. Revisions are built in.",
  },
  {
    step: "04",
    title: "Launch & support",
    body: "We handle deployment, then keep it patched, backed up and monitored.",
  },
];

const DIFFERENTIATORS = [
  {
    icon: Gauge,
    title: "Built to perform",
    body: "Mobile-first, accessible and fast — because slow sites lose customers before they load.",
  },
  {
    icon: Wrench,
    title: "One vendor, whole stack",
    body: "Site, app, hosting, email, domains and the IT behind them — supported by one local team.",
  },
  {
    icon: ShieldCheck,
    title: "Local since 1996",
    body: "A South Florida company you can call, visit and hold accountable. No offshore handoffs.",
  },
];

export default function WebAppIntakePage() {
  useEffect(() => {
    const prev = document.title;
    document.title =
      "Website & App Development | Computer Systems Depot — South Florida";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* ---- Top nav ---------------------------------------------------- */}
      <header className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2" aria-label="Computer Systems Depot home">
            <img src={csdLogo} alt="Computer Systems Depot" className="h-9 w-auto" />
          </Link>
          <nav className="hidden items-center gap-6 text-sm font-medium text-gray-600 md:flex">
            <a href="#services" className="hover:text-csd-red">What we build</a>
            <a href="#process" className="hover:text-csd-red">How it works</a>
            <a href="#start" className="hover:text-csd-red">Start a project</a>
          </nav>
          <div className="flex items-center gap-2">
            <a href={PHONE_HREF} className="hidden sm:block">
              <Button
                variant="outline"
                className="border-csd-red text-csd-red hover:bg-csd-red hover:text-white"
              >
                <Phone className="mr-2 h-4 w-4" />
                {PHONE_DISPLAY}
              </Button>
            </a>
            <a href="#start">
              <Button className="bg-csd-red text-white hover:bg-red-700">Get a Quote</Button>
            </a>
          </div>
        </div>
      </header>

      {/* ---- Hero -------------------------------------------------------- */}
      <section className="relative isolate overflow-hidden bg-gray-950 text-white">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(60%_60%_at_80%_10%,rgba(220,38,38,0.35),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
          <div className="max-w-2xl space-y-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide backdrop-blur">
              <Globe className="h-3.5 w-3.5" />
              CSD Web &amp; App Studio
            </span>
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl md:text-6xl">
              Websites and apps that{" "}
              <span className="text-csd-red">win you customers</span>
            </h1>
            <p className="max-w-xl text-lg text-gray-200">
              From a first business website to a full custom app, Computer Systems Depot designs,
              builds, hosts and maintains it — with the same engineering discipline we've brought to
              South Florida IT since 1996.
            </p>
            <div className="flex flex-wrap gap-3">
              <a href="#start">
                <Button size="lg" className="bg-csd-red text-white hover:bg-red-700">
                  Start Your Project
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </a>
              <a href={PHONE_HREF}>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-white/40 bg-transparent text-white hover:bg-white/10"
                >
                  <Phone className="mr-2 h-5 w-5" />
                  {PHONE_DISPLAY}
                </Button>
              </a>
            </div>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-300">
              {["Free consultation", "Fixed-price quotes", "You own everything we build"].map(
                (item) => (
                  <li key={item} className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-csd-red" />
                    {item}
                  </li>
                ),
              )}
            </ul>
          </div>
        </div>
      </section>

      {/* ---- What we build ---------------------------------------------- */}
      <section id="services" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">What we build</h2>
          <p className="mt-3 text-gray-600">
            Whether you need a five-page site or a custom platform, we scope it honestly and build
            it to last.
          </p>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {SERVICES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-gray-200 p-6 transition-shadow hover:shadow-md"
            >
              <Icon className="h-8 w-8 text-csd-red" />
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-gray-600">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Process ----------------------------------------------------- */}
      <section id="process" className="scroll-mt-20 border-y border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">How it works</h2>
            <p className="mt-3 text-gray-600">
              Four clear steps, no mystery invoices, and a real person on the phone at every stage.
            </p>
          </div>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {PROCESS.map(({ step, title, body }) => (
              <div key={step} className="rounded-xl border border-gray-200 bg-white p-6">
                <span className="text-sm font-extrabold tracking-widest text-csd-red">{step}</span>
                <h3 className="mt-3 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-gray-600">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Why CSD ------------------------------------------------------ */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-8 md:grid-cols-3">
          {DIFFERENTIATORS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex gap-4">
              <Icon className="h-8 w-8 shrink-0 text-csd-red" />
              <div>
                <h3 className="text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-gray-600">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Intake form -------------------------------------------------- */}
      <section id="start" className="scroll-mt-20 border-t border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Start your project</h2>
            <p className="mt-3 text-gray-600">
              Tell us what you have in mind. A CSD specialist reviews every request personally and
              replies within one business day.
            </p>
          </div>
          <WebAppIntakeForm className="mx-auto mt-10 max-w-3xl" />
        </div>
      </section>

      {/* ---- Footer -------------------------------------------------------- */}
      <footer className="border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <img src={csdLogo} alt="Computer Systems Depot" className="h-10 w-auto" />
              <p className="mt-3 text-sm text-gray-600">
                Serving Broward, Miami-Dade &amp; Palm Beach counties since 1996.
              </p>
            </div>
            <div className="space-y-2 text-sm text-gray-600">
              <p className="font-semibold text-gray-900">Talk to us</p>
              <a href={PHONE_HREF} className="flex items-center gap-2 hover:text-csd-red">
                <Phone className="h-4 w-4" />
                {PHONE_DISPLAY}
              </a>
              <a href={`mailto:${SUPPORT_EMAIL}`} className="flex items-center gap-2 hover:text-csd-red">
                <Mail className="h-4 w-4" />
                {SUPPORT_EMAIL}
              </a>
            </div>
            <div className="space-y-2 text-sm text-gray-600">
              <p className="font-semibold text-gray-900">Visit</p>
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  5601 NW 13 Street
                  <br />
                  Lauderhill, FL 33313
                </span>
              </p>
              <p className="flex items-start gap-2">
                <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Mon – Fri: 5:00 AM – 11:00 PM</span>
              </p>
            </div>
            <div className="space-y-2 text-sm text-gray-600">
              <p className="font-semibold text-gray-900">More from CSD</p>
              <Link href="/" className="flex items-center gap-2 hover:text-csd-red">
                <ArrowLeft className="h-4 w-4" />
                Back to home
              </Link>
              <Link href="/intake" className="block hover:text-csd-red">
                Computer repair request
              </Link>
              <Link href="/portal" className="block hover:text-csd-red">
                Client portal
              </Link>
              <Link href="/privacy" className="block hover:text-csd-red">
                Privacy policy
              </Link>
            </div>
          </div>
          <p className="mt-10 text-center text-xs text-gray-400">
            © {new Date().getFullYear()} Computer Systems Depot Inc. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
