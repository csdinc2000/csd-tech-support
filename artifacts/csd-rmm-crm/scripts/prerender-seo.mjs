import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputRoot = path.resolve("dist/public");
const shell = await readFile(path.join(outputRoot, "index.html"), "utf8");
const siteUrl = "https://support.computersystemsdepot.com";

const pages = [
  {
    path: "computer-repair-lauderhill",
    title: "Computer Repair Lauderhill, FL | Computer Systems Depot",
    description: "Computer repair in Lauderhill, FL for desktops and laptops. Get diagnostics, hardware repair, tune-ups and local support from CSD. Call 954-637-7300.",
    heading: "Computer Repair in Lauderhill, FL",
    summary: "Local desktop, laptop, and workstation diagnostics, repairs, hardware upgrades, Windows support, and tune-ups from Computer Systems Depot.",
    serviceType: "Computer repair",
  },
  {
    path: "gaming-computers-lauderhill",
    title: "Gaming Computers Lauderhill | Custom Gaming PCs",
    description: "Custom gaming computers in Lauderhill, FL. CSD builds, upgrades and tunes gaming PCs for better performance, cooling and reliability. Call 954-637-7300.",
    heading: "Gaming Computers in Lauderhill",
    summary: "Custom gaming PC builds, component upgrades, cooling optimization, performance tuning, and troubleshooting from the Tweek Geeks division of CSD.",
    serviceType: "Custom gaming computer building and repair",
  },
  {
    path: "virus-removal-lauderhill",
    title: "Virus Removal Lauderhill, FL | Malware Cleanup",
    description: "Virus and malware removal in Lauderhill, FL. CSD removes threats, repairs Windows issues and helps secure your computer. Call 954-637-7300.",
    heading: "Virus Removal in Lauderhill, FL",
    summary: "Local virus, malware, spyware, browser redirect, and pop-up removal with Windows repair and practical security guidance.",
    serviceType: "Computer virus and malware removal",
  },
  {
    path: "local-seo-services",
    title: "Local SEO Services in Lauderhill, FL | CSD",
    description: "Local SEO support for Google Business Profile optimization, citations, Maps visibility, and local keyword targeting for South Florida businesses.",
    heading: "Local SEO Services for South Florida Businesses",
    summary: "Computer Systems Depot helps local businesses improve online visibility through Google Business Profile optimization, accurate citations and listings, Maps visibility support, and local keyword targeting. Search rankings vary and are not guaranteed.",
    serviceType: "Local search engine optimization",
    sections: [
      {
        heading: "Google Business Profile Optimization",
        body: "Improve profile completeness with accurate categories, services, service areas, photos, and useful updates. Changes require owner-authorized access.",
      },
      {
        heading: "Local Citations & Listings",
        body: "Review business listings across relevant directories and identify inconsistent names, addresses, phone numbers, or website links.",
      },
      {
        heading: "Maps Ranking & Visibility",
        body: "Support local map visibility through profile quality, local relevance, and consistent business information. Map placement varies by searcher and location; no position is guaranteed.",
      },
      {
        heading: "Local Keyword Targeting",
        body: "Align service pages with the locations and services customers search for, using useful, natural language.",
      },
    ],
    faq: [
      {
        question: "Can anyone guarantee a top position on Google Maps?",
        answer: "No. Google Maps results depend on relevance, distance, and prominence, and can differ by searcher and location. Our work focuses on accurate profiles, useful pages, and consistent business information—not guaranteed rankings.",
      },
      {
        question: "Do I need to own my Google Business Profile?",
        answer: "Yes. The business owner should retain ownership and grant authorized access when profile updates are needed. Never share your Google password.",
      },
      {
        question: "What businesses can use local SEO?",
        answer: "Local SEO can help businesses that serve a defined community or service area make their services and location easier for nearby customers to understand and find.",
      },
    ],
  },
  {
    path: "scam-check-guide",
    title: "Computer Scam Alert Safety Guide | CSD",
    description: "See an unexpected virus pop-up? Learn safe first steps for suspicious alerts, links, or remote-access requests—without uploading files or sharing passwords.",
    heading: "Unexpected computer warning? Pause before you click.",
    summary: "A calm, privacy-safe checklist for suspicious computer pop-ups, unexpected downloads, and remote-access requests. A warning alone does not prove a computer is infected.",
    schemaType: "WebPage",
  },
];

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
})[character]);

const homepageFallback = `<main aria-label="Computer Systems Depot local services"><h1>Computer Repair and Managed IT in Lauderhill, FL</h1><p>Computer Systems Depot has served South Florida homes and businesses since 1996 with computer repair, managed IT, custom gaming computers, virus removal, and local SEO services.</p><h2>Local computer and IT services</h2><ul><li><a href="/computer-repair-lauderhill">Computer repair in Lauderhill</a></li><li><a href="/gaming-computers-lauderhill">Custom gaming computers</a></li><li><a href="/virus-removal-lauderhill">Virus and malware removal</a></li></ul><h2>Local SEO services</h2><p>Google Business Profile optimization, local citations and listings, Maps visibility support, and local keyword targeting for businesses across South Florida.</p><p>Visit us at 5601 NW 13 Street, Lauderhill, FL 33313. Call <a href="tel:9546377300">954-637-7300</a> or <a href="/local-seo-services">explore local SEO services</a>.</p></main>`;
await writeFile(
  path.join(outputRoot, "index.html"),
  shell.replace('<div id="root">', `<div id="root">${homepageFallback}`),
);

for (const page of pages) {
  const canonical = `${siteUrl}/${page.path}`;
  const schema = [
    {
      "@context": "https://schema.org",
      "@type": ["ComputerStore", "LocalBusiness"],
      "@id": `${siteUrl}/#business`,
      name: "Computer Systems Depot Inc.",
      url: siteUrl,
      telephone: "+1-954-637-7300",
      address: {
        "@type": "PostalAddress",
        streetAddress: "5601 NW 13 Street",
        addressLocality: "Lauderhill",
        addressRegion: "FL",
        postalCode: "33313",
        addressCountry: "US",
      },
    },
    page.schemaType === "WebPage"
      ? {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: page.heading,
          description: page.description,
          url: canonical,
          publisher: { "@id": `${siteUrl}/#business` },
        }
      : {
          "@context": "https://schema.org",
          "@type": "Service",
          name: page.heading,
          serviceType: page.serviceType,
          description: page.description,
          url: canonical,
          provider: { "@id": `${siteUrl}/#business` },
          areaServed: { "@type": "City", name: "Lauderhill" },
        },
  ];
  if (page.faq?.length) {
    schema.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    });
  }

  const schemaMarkup = schema.map((entry) => `<script type="application/ld+json" data-route-structured-data="true">${JSON.stringify(entry)}</script>`).join("\n");
  const sectionsMarkup = (page.sections ?? []).map((section) => (
    `<section><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p></section>`
  )).join("\n");
  const faqMarkup = page.faq?.length
    ? `<section><h2>Local SEO questions</h2>${page.faq.map((item) => `<article><h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p></article>`).join("\n")}</section>`
    : "";
  const html = shell
    .replace(/<title>.*?<\/title>/s, `<title>${page.title}</title>`)
    .replace(/<meta name="description" content=".*?" \/>/s, `<meta name="description" content="${page.description}" />`)
    .replace(/<link rel="canonical" href=".*?" \/>/s, `<link rel="canonical" href="${canonical}" />`)
    .replace(/<meta property="og:title" content=".*?" \/>/s, `<meta property="og:title" content="${page.title}" />`)
    .replace(/<meta property="og:description" content=".*?" \/>/s, `<meta property="og:description" content="${page.description}" />`)
    .replace(/<meta property="og:url" content=".*?" \/>/s, `<meta property="og:url" content="${canonical}" />`)
    .replace(/<meta name="twitter:title" content=".*?" \/>/s, `<meta name="twitter:title" content="${page.title}" />`)
    .replace(/<meta name="twitter:description" content=".*?" \/>/s, `<meta name="twitter:description" content="${page.description}" />`)
    .replace(/<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/, schemaMarkup)
    .replace(
      '<div id="root">',
      `<div id="root"><main aria-label="${escapeHtml(page.heading)}"><h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.summary)}</p>${sectionsMarkup}${faqMarkup}<p>Computer Systems Depot, 5601 NW 13 Street, Lauderhill, FL 33313. Call <a href="tel:9546377300">954-637-7300</a> or <a href="/intake">start a service request</a>.</p></main>`,
    );

  const directory = path.join(outputRoot, page.path);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.html"), html);
}

console.log(`Generated ${pages.length} SEO route shells.`);
