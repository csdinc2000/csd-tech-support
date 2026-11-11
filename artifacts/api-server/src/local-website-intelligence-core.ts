import { isIP } from "node:net";

function normalizedText(value: unknown, maxLength = 200): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

export function validPublicWebsite(value: string, requireHttps = false): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (requireHttps && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || isIP(host) || host === "localhost" || host.endsWith(".localhost")
      || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test")) return null;
    url.hostname = host;
    url.pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return url;
  } catch {
    return null;
  }
}

export function publicWebsite(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  parsed.search = "";
  parsed.hash = "";
  const url = validPublicWebsite(parsed.toString());
  return url?.toString() ?? null;
}

export function collectTechnologyNames(data: any): string[] {
  const candidates = [
    data?.technologies,
    data?.results,
    data?.result?.technologies,
    data?.result?.results,
  ];
  const names = new Set<string>();
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const name = typeof item === "string"
          ? item
          : item?.name ?? item?.technology ?? item?.title;
        const clean = normalizedText(name, 100);
        if (clean) names.add(clean);
      }
    }
  }
  return [...names].slice(0, 50);
}

export function mapWhatCmsResponse(data: any) {
  const code = Number(data?.result?.code ?? data?.code);
  const technologies = collectTechnologyNames(data);
  const resultName = normalizedText(data?.result?.name ?? data?.cms, 100);
  const cms = resultName || technologies.find((name) => /wordpress|drupal|joomla|shopify|wix|squarespace/i.test(name)) || null;
  const language = normalizedText(data?.language ?? data?.result?.language, 100) || null;
  const isWordPressOpportunity = /wordpress/i.test([cms, ...technologies].filter(Boolean).join(" "));

  if ([120, 121, 124, 125].includes(code)) {
    return { status: "rate_limited" as const, cms: null, language: null, technologies: [], isWordPressOpportunity: false, message: "WhatCMS request limit reached. Please try again later." };
  }
  if (code === 201) {
    return { status: "not_detected" as const, cms: null, language, technologies, isWordPressOpportunity: false, message: "No supported content management system was detected." };
  }
  if (code === 202) {
    return { status: "unavailable" as const, cms: null, language, technologies, isWordPressOpportunity: false, message: "The site could not be checked by the provider." };
  }
  if (code !== 200 && !cms && technologies.length === 0) {
    return { status: "unavailable" as const, cms: null, language, technologies: [], isWordPressOpportunity: false, message: "The provider returned an unrecognized result." };
  }
  return {
    status: "success" as const,
    cms,
    language,
    technologies,
    isWordPressOpportunity,
    message: null,
  };
}

const MILES_PER_DEGREE_LAT = 69;

/** "south,west,north,east" box around a point, for Overpass `[bbox:...]`. */
export function boundingBox(lat: number, lon: number, radiusMiles: number): string {
  const dLat = radiusMiles / MILES_PER_DEGREE_LAT;
  const dLon = radiusMiles / (MILES_PER_DEGREE_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((n) => n.toFixed(5)).join(",");
}

/**
 * One bounding-box query for repair / electronics / IT businesses. Far cheaper
 * for the public Overpass servers than per-tag `around` searches with regexes;
 * the website requirement is applied to the results instead of in the query.
 */
export function overpassBusinessQuery(lat: number, lon: number, radiusMiles: number): string {
  return `[out:json][timeout:25][bbox:${boundingBox(lat, lon, radiusMiles)}];
(
  nwr["name"]["craft"="computer_repair"];
  nwr["name"]["shop"~"^(computer|electronics|mobile_phone)$"];
  nwr["name"]["office"="it"];
);
out center tags;`;
}

/** Overloaded / unreachable Overpass responses worth trying another server for. */
export function isRetryableOverpassFailure(error: any): boolean {
  const status = Number(error?.response?.status);
  if ([429, 502, 503, 504].includes(status)) return true;
  return ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code);
}

/** Cache key for a search: ~100 m grid cell plus radius. */
export function osmSearchCacheKey(lat: number, lon: number, radiusMiles: number): string {
  return `osm-discovery:${lat.toFixed(3)},${lon.toFixed(3)}:${radiusMiles}`;
}
