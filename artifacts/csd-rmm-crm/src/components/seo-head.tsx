import { useEffect } from "react";

const SITE_URL = "https://support.computersystemsdepot.com";
const SOCIAL_IMAGE = `${SITE_URL}/hero-poster.jpg`;

type SeoHeadProps = {
  title: string;
  description: string;
  path: string;
  type?: "website" | "article";
  schema?: Record<string, unknown> | Array<Record<string, unknown>>;
};

function upsertMeta(selector: string, attributes: Record<string, string>) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    document.head.appendChild(element);
  }
  Object.entries(attributes).forEach(([name, value]) => element!.setAttribute(name, value));
}

export function SeoHead({ title, description, path, type = "website", schema }: SeoHeadProps) {
  useEffect(() => {
    const canonicalUrl = `${SITE_URL}${path === "/" ? "" : path}`;
    document.title = title;
    upsertMeta('meta[name="description"]', { name: "description", content: description });
    upsertMeta('meta[name="robots"]', { name: "robots", content: "index, follow, max-image-preview:large" });
    upsertMeta('meta[property="og:title"]', { property: "og:title", content: title });
    upsertMeta('meta[property="og:description"]', { property: "og:description", content: description });
    upsertMeta('meta[property="og:type"]', { property: "og:type", content: type });
    upsertMeta('meta[property="og:url"]', { property: "og:url", content: canonicalUrl });
    upsertMeta('meta[property="og:image"]', { property: "og:image", content: SOCIAL_IMAGE });
    upsertMeta('meta[name="twitter:card"]', { name: "twitter:card", content: "summary_large_image" });
    upsertMeta('meta[name="twitter:title"]', { name: "twitter:title", content: title });
    upsertMeta('meta[name="twitter:description"]', { name: "twitter:description", content: description });
    upsertMeta('meta[name="twitter:image"]', { name: "twitter:image", content: SOCIAL_IMAGE });

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = canonicalUrl;

    document.querySelectorAll('[data-route-structured-data="true"]').forEach((element) => element.remove());
    if (schema) {
      const schemas = Array.isArray(schema) ? schema : [schema];
      schemas.forEach((entry) => {
        const script = document.createElement("script");
        script.type = "application/ld+json";
        script.dataset.routeStructuredData = "true";
        script.text = JSON.stringify(entry);
        document.head.appendChild(script);
      });
    }
  }, [description, path, schema, title, type]);

  return null;
}

export const localBusinessSchema = {
  "@context": "https://schema.org",
  "@type": ["ComputerStore", "LocalBusiness"],
  "@id": `${SITE_URL}/#business`,
  name: "Computer Systems Depot Inc.",
  url: SITE_URL,
  telephone: "+1-954-637-7300",
  email: "support@computersystemsdepot.com",
  foundingDate: "1996",
  address: {
    "@type": "PostalAddress",
    streetAddress: "5601 NW 13 Street",
    addressLocality: "Lauderhill",
    addressRegion: "FL",
    postalCode: "33313",
    addressCountry: "US",
  },
  areaServed: ["Lauderhill", "Fort Lauderdale", "Plantation", "Weston", "Coral Springs", "South Florida"],
};
