import { Link } from "wouter";
import { CheckCircle2, MapPin, Phone, ShieldCheck, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeoHead, localBusinessSchema } from "@/components/seo-head";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

type ServiceKey = "computer-repair" | "gaming-computers" | "virus-removal";

const SERVICES: Record<ServiceKey, {
  path: string;
  title: string;
  description: string;
  eyebrow: string;
  heading: string;
  intro: string;
  benefits: string[];
  details: Array<{ title: string; body: string }>;
  faq: Array<{ question: string; answer: string }>;
}> = {
  "computer-repair": {
    path: "/computer-repair-lauderhill",
    title: "Computer Repair Lauderhill, FL | Computer Systems Depot",
    description: "Computer repair in Lauderhill, FL for desktops and laptops. Get diagnostics, hardware repair, tune-ups and local support from CSD. Call 954-637-7300.",
    eyebrow: "Local service since 1996",
    heading: "Computer Repair in Lauderhill, FL",
    intro: "Computer Systems Depot diagnoses and repairs desktops, laptops, and workstations for Lauderhill homes and businesses. Visit our local shop for clear recommendations and dependable service.",
    benefits: ["Desktop and laptop diagnostics", "Hardware replacement and upgrades", "Windows repair and performance tune-ups", "In-shop, remote, and on-site support"],
    details: [
      { title: "Accurate diagnostics", body: "We identify the underlying hardware or software issue before recommending a repair." },
      { title: "Repairs for major brands", body: "Service for Dell, HP, Lenovo, ASUS, Apple, custom PCs, and business workstations." },
      { title: "Local Lauderhill support", body: "Our shop is at 5601 NW 13 Street in Lauderhill, with service available across South Florida." },
    ],
    faq: [
      { question: "What types of computers do you repair?", answer: "We repair desktop PCs, laptops, custom computers, and business workstations from major manufacturers." },
      { question: "Do you offer remote computer repair?", answer: "Yes. Software troubleshooting, tune-ups, and many security issues can be handled through secure remote support." },
      { question: "Where is your Lauderhill computer repair shop?", answer: "Computer Systems Depot is located at 5601 NW 13 Street, Lauderhill, Florida 33313." },
    ],
  },
  "gaming-computers": {
    path: "/gaming-computers-lauderhill",
    title: "Gaming Computers Lauderhill | Custom Gaming PCs",
    description: "Custom gaming computers in Lauderhill, FL. CSD builds, upgrades and tunes gaming PCs for better performance, cooling and reliability. Call 954-637-7300.",
    eyebrow: "Tweek Geeks gaming division",
    heading: "Gaming Computers in Lauderhill",
    intro: "Build or improve a gaming PC with local help from Computer Systems Depot. We match components to your games, performance goals, display, and budget.",
    benefits: ["Custom gaming PC builds", "Graphics card, CPU, RAM, and storage upgrades", "Cooling and airflow optimization", "Performance troubleshooting and tuning"],
    details: [
      { title: "Balanced custom builds", body: "Component recommendations focus on real gaming performance without unnecessary bottlenecks or overspending." },
      { title: "Gaming PC upgrades", body: "Improve frame rates, loading times, cooling, storage, and reliability with targeted upgrades." },
      { title: "Troubleshooting", body: "We diagnose crashes, overheating, low frame rates, boot problems, and unstable gaming systems." },
    ],
    faq: [
      { question: "Can you build a custom gaming computer?", answer: "Yes. We design and assemble custom gaming PCs around your games, monitor resolution, performance goals, and budget." },
      { question: "Can you upgrade my current gaming PC?", answer: "Yes. We evaluate compatibility and recommend useful GPU, CPU, memory, storage, power, and cooling upgrades." },
      { question: "Do you fix overheating gaming computers?", answer: "Yes. We inspect airflow, fans, thermal performance, dust buildup, component temperatures, and cooling configuration." },
    ],
  },
  "virus-removal": {
    path: "/virus-removal-lauderhill",
    title: "Virus Removal Lauderhill, FL | Malware Cleanup",
    description: "Virus and malware removal in Lauderhill, FL. CSD removes threats, repairs Windows issues and helps secure your computer. Call 954-637-7300.",
    eyebrow: "Security cleanup and recovery",
    heading: "Virus Removal in Lauderhill, FL",
    intro: "If your computer shows pop-ups, redirects, fake alerts, unexplained slowness, or suspicious account activity, Computer Systems Depot can identify and remove malicious software.",
    benefits: ["Virus, malware, and spyware removal", "Browser redirect and pop-up cleanup", "Windows repair and performance recovery", "Security updates and prevention guidance"],
    details: [
      { title: "Thorough threat removal", body: "We check for viruses, spyware, unwanted programs, malicious browser extensions, and persistence mechanisms." },
      { title: "System recovery", body: "After cleanup, we repair affected settings and help restore stable computer performance." },
      { title: "Safer next steps", body: "We explain what happened and provide practical recommendations to reduce repeat infections." },
    ],
    faq: [
      { question: "What are common signs of a computer virus?", answer: "Unexpected pop-ups, browser redirects, fake security alerts, severe slowness, unknown programs, and disabled security tools can indicate an infection." },
      { question: "Can virus removal be done remotely?", answer: "Many malware and software issues can be assessed remotely. Severe infections or computers that cannot start may need in-shop service." },
      { question: "Will virus removal delete my files?", answer: "Our goal is to remove threats while preserving personal files. We will explain any data risk found during diagnostics." },
    ],
  },
};

export default function LocalServicePage({ service }: { service: ServiceKey }) {
  const content = SERVICES[service];
  const serviceSchema = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: content.heading,
    description: content.description,
    url: `https://support.computersystemsdepot.com${content.path}`,
    provider: { "@id": "https://support.computersystemsdepot.com/#business" },
    areaServed: { "@type": "City", name: "Lauderhill" },
  };
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: content.faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SeoHead title={content.title} description={content.description} path={content.path} schema={[localBusinessSchema, serviceSchema, faqSchema]} />
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" aria-label="Computer Systems Depot home">
            <img src={csdLogo} alt="Computer Systems Depot computer repair" className="h-10 w-auto" width="160" height="54" />
          </Link>
          <div className="flex items-center gap-2">
            <a href="tel:9546377300" className="hidden text-sm font-semibold text-csd-red sm:inline">954-637-7300</a>
            <Link href="/intake"><Button className="bg-csd-red text-white hover:bg-red-700">Request Service</Button></Link>
          </div>
        </div>
      </header>

      <main>
        <section className="bg-gray-950 text-white">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1.35fr_.65fr] lg:py-24">
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-red-400">{content.eyebrow}</p>
              <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">{content.heading}</h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-gray-300">{content.intro}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/intake"><Button size="lg" className="bg-csd-red text-white hover:bg-red-700">Start a Service Request</Button></Link>
                <a href="tel:9546377300"><Button size="lg" variant="outline" className="border-white/40 bg-transparent text-white hover:bg-white/10"><Phone className="mr-2 h-4 w-4" />Call 954-637-7300</Button></a>
              </div>
            </div>
            <aside className="rounded-2xl border border-white/15 bg-white/5 p-6">
              <h2 className="text-xl font-bold">Service highlights</h2>
              <ul className="mt-5 space-y-3">
                {content.benefits.map((benefit) => <li key={benefit} className="flex gap-3 text-sm text-gray-200"><CheckCircle2 className="h-5 w-5 shrink-0 text-green-400" />{benefit}</li>)}
              </ul>
            </aside>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-center text-3xl font-bold">Local service from experienced technicians</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {content.details.map((item, index) => (
              <article key={item.title} className="rounded-xl border p-6">
                {index === 2 ? <MapPin className="h-7 w-7 text-csd-red" /> : index === 1 ? <Wrench className="h-7 w-7 text-csd-red" /> : <ShieldCheck className="h-7 w-7 text-csd-red" />}
                <h3 className="mt-4 text-xl font-semibold">{item.title}</h3>
                <p className="mt-2 leading-7 text-gray-600">{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-y bg-gray-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <div className="max-w-3xl">
              <p className="text-sm font-bold uppercase tracking-widest text-csd-red">A clear next step</p>
              <h2 className="mt-2 text-3xl font-bold">What happens after you request service?</h2>
              <p className="mt-3 leading-7 text-gray-600">
                We review your request and contact you to learn more about the issue and discuss next steps.
              </p>
            </div>
            <ol className="mt-8 grid gap-5 md:grid-cols-3">
              <li className="rounded-xl border bg-white p-6">
                <p className="text-sm font-bold text-csd-red">1</p>
                <h3 className="mt-2 text-lg font-semibold">Describe the problem</h3>
                <p className="mt-2 leading-7 text-gray-600">
                  Include the device type and what you have noticed. Please don’t send passwords, verification codes, or payment details.
                </p>
              </li>
              <li className="rounded-xl border bg-white p-6">
                <p className="text-sm font-bold text-csd-red">2</p>
                <h3 className="mt-2 text-lg font-semibold">We review your request</h3>
                <p className="mt-2 leading-7 text-gray-600">
                  A CSD team member will use the contact details you provide to follow up and understand the issue.
                </p>
              </li>
              <li className="rounded-xl border bg-white p-6">
                <p className="text-sm font-bold text-csd-red">3</p>
                <h3 className="mt-2 text-lg font-semibold">Discuss next steps</h3>
                <p className="mt-2 leading-7 text-gray-600">
                  We’ll discuss an appropriate service option and what should happen next before you decide how to proceed.
                </p>
              </li>
            </ol>
            {service === "virus-removal" && (
              <p className="mt-6 rounded-lg border border-red-100 bg-white p-4 text-sm leading-6 text-gray-700">
                Seeing a suspicious pop-up or virus warning?{" "}
                <Link href="/scam-check-guide" className="font-semibold text-csd-red underline underline-offset-4 hover:text-red-700">
                  Read the free scam-safety guide
                </Link>
                {" "}for safe first steps. It does not ask you to upload files or share account details.
              </p>
            )}
          </div>
        </section>

        <section className="border-y bg-gray-50">
          <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
            <h2 className="text-3xl font-bold">Frequently asked questions</h2>
            <div className="mt-8 space-y-6">
              {content.faq.map((item) => <article key={item.question}><h3 className="text-lg font-semibold">{item.question}</h3><p className="mt-2 leading-7 text-gray-600">{item.answer}</p></article>)}
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-gray-950 text-gray-300">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 px-4 py-8 text-sm sm:flex-row sm:px-6">
          <p>Computer Systems Depot Inc. · 5601 NW 13 Street, Lauderhill, FL 33313</p>
          <nav className="flex flex-wrap gap-4" aria-label="Service pages">
            <Link href="/computer-repair-lauderhill">Computer Repair</Link>
            <Link href="/gaming-computers-lauderhill">Gaming Computers</Link>
            <Link href="/virus-removal-lauderhill">Virus Removal</Link>
            <Link href="/scam-check-guide">Scam-safety guide</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
