import { Link } from "wouter";
import { ArrowRight, Building2, MapPin, Phone, Search, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeoHead, localBusinessSchema } from "@/components/seo-head";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

const SERVICES = [
  {
    icon: Building2,
    title: "Google Business Profile Optimization",
    body: "Improve the accuracy and completeness of your Google Business Profile with clear categories, service details, service areas, photos, and useful updates. Changes are made with owner-authorized access.",
  },
  {
    icon: Search,
    title: "Local Citations & Listings",
    body: "Review business listings across relevant directories and identify inconsistent names, addresses, phone numbers, or website links that may confuse customers.",
  },
  {
    icon: MapPin,
    title: "Maps Ranking & Visibility",
    body: "Support local map visibility by improving profile quality, local relevance, and the consistency of your business information. Map placement varies by searcher, competition, and location; no position is guaranteed.",
  },
  {
    icon: Target,
    title: "Local Keyword Targeting",
    body: "Match your service pages to the services and locations customers search for, with useful copy that reads naturally rather than repeating keywords.",
  },
];

const FAQ = [
  {
    question: "Can anyone guarantee a top position on Google Maps?",
    answer: "No. Google Maps results depend on factors such as relevance, distance, and prominence, and can differ by searcher and location. Our work focuses on accurate profiles, useful pages, and consistent business information—not guaranteed rankings.",
  },
  {
    question: "Do I need to own my Google Business Profile?",
    answer: "Yes. The business owner should retain ownership and grant authorized access when profile updates are needed. Never share your Google password.",
  },
  {
    question: "What businesses can use local SEO?",
    answer: "Local SEO can help businesses that serve a defined community or service area make their services and location easier for nearby customers to understand and find.",
  },
];

const SERVICE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Local SEO Services",
  serviceType: "Local search engine optimization",
  description: "Google Business Profile optimization, local citations and listings, Maps visibility support, and local keyword targeting.",
  url: "https://support.computersystemsdepot.com/local-seo-services",
  provider: { "@id": "https://support.computersystemsdepot.com/#business" },
  areaServed: ["Lauderhill", "Fort Lauderdale", "Plantation", "Weston", "Coral Springs", "South Florida"],
};

const FAQ_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: { "@type": "Answer", text: item.answer },
  })),
};

export default function LocalSeoServicesPage() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SeoHead
        title="Local SEO Services in Lauderhill, FL | CSD"
        description="Local SEO support for Google Business Profile optimization, citations, Maps visibility, and local keyword targeting for South Florida businesses."
        path="/local-seo-services"
        schema={[localBusinessSchema, SERVICE_SCHEMA, FAQ_SCHEMA]}
      />
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" aria-label="Computer Systems Depot home">
            <img src={csdLogo} alt="Computer Systems Depot" className="h-10 w-auto" width="160" height="54" />
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/" className="hidden text-sm font-medium text-gray-700 hover:text-csd-red sm:inline">Home</Link>
            <a href="tel:9546377300" className="hidden text-sm font-semibold text-csd-red sm:inline">954-637-7300</a>
            <Link href="/web-app-intake"><Button className="bg-csd-red text-white hover:bg-red-700">Contact CSD</Button></Link>
          </div>
        </div>
      </header>

      <main>
        <section className="bg-gray-950 text-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
            <p className="text-sm font-bold uppercase tracking-widest text-red-400">Local search support · South Florida</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">Local SEO Services in Lauderhill, FL</h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-gray-300">
              Help nearby customers understand what you offer and where you serve them with accurate business listings,
              useful local pages, and clear Google Business Profile information.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="tel:9546377300"><Button size="lg" className="bg-csd-red text-white hover:bg-red-700"><Phone className="mr-2 h-4 w-4" />Call 954-637-7300</Button></a>
              <a href="mailto:support@computersystemsdepot.com?subject=Local%20SEO%20services"><Button size="lg" variant="outline" className="border-white/40 bg-transparent text-white hover:bg-white/10">Email CSD</Button></a>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Four parts of local search optimization</h2>
            <p className="mt-3 text-gray-600">Practical work that improves clarity and consistency without promising a specific search position.</p>
          </div>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {SERVICES.map(({ icon: Icon, title, body }) => (
              <article key={title} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-csd-red/10 text-csd-red"><Icon className="h-6 w-6" /></div>
                <h2 className="mt-4 text-xl font-semibold">{title}</h2>
                <p className="mt-2 leading-7 text-gray-600">{body}</p>
              </article>
            ))}
          </div>
          <p className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            Google Business Profile ownership stays with your business. Any profile changes require owner-authorized access, and no provider can guarantee a particular Maps ranking.
          </p>
        </section>

        <section className="border-y bg-gray-50">
          <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
            <h2 className="text-3xl font-bold">Local SEO questions</h2>
            <div className="mt-8 space-y-6">
              {FAQ.map((item) => (
                <article key={item.question}>
                  <h3 className="text-lg font-semibold">{item.question}</h3>
                  <p className="mt-2 leading-7 text-gray-600">{item.answer}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-gray-950 text-gray-300">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 px-4 py-8 text-sm sm:flex-row sm:px-6">
          <p>Computer Systems Depot Inc. · 5601 NW 13 Street, Lauderhill, FL 33313</p>
          <Link href="/" className="inline-flex items-center gap-2 hover:text-white">Back to Computer Systems Depot <ArrowRight className="h-4 w-4" /></Link>
        </div>
      </footer>
    </div>
  );
}
