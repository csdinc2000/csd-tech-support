import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import axios from "axios";
import { z } from "zod/v4";
import {
  AuditLocalBusinessWebsiteBody,
  AuditLocalBusinessWebsiteResponse,
  DraftLocalBusinessProposalBody,
  DraftLocalBusinessProposalResponse,
  SaveLocalBusinessLeadBody,
} from "@workspace/api-zod";
import { pool } from "./db";
import { getCsdApprovedCatalogService } from "./catalog";
import {
  collectTechnologyNames,
  isRetryableOverpassFailure,
  mapWhatCmsResponse,
  osmSearchCacheKey,
  overpassBusinessQuery,
  publicWebsite,
  validPublicWebsite,
} from "./local-website-intelligence-core";
import { getAppState, setAppState } from "./app-state";
import { logger } from "./lib/logger";
import { draftProposal } from "./website-intelligence";

const GOOGLE_PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// Public Overpass servers, tried in order. They are free, shared and often
// overloaded ("at capacity" 502/504s, timeouts); override with OVERPASS_URLS
// (comma-separated). Google Places (GOOGLE_PLACES_API_KEY) is the reliable path.
const OVERPASS_URLS = (process.env.OVERPASS_URLS || [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
].join(","))
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
// Whole OpenStreetMap search must finish inside proxy request limits. The
// main server often needs ~40 s when busy, so it gets the most time; mirrors
// share what's left.
const OVERPASS_TOTAL_BUDGET_MS = 55_000;
const OVERPASS_FIRST_ATTEMPT_TIMEOUT_MS = 40_000;
// Fresh results are reused without asking Overpass; older ones (up to a week)
// are only served when every server is failing.
const OSM_CACHE_FRESH_MS = 24 * 60 * 60_000;
const OSM_CACHE_STALE_MS = 7 * 24 * 60 * 60_000;
const WHATCMS_URL = "https://whatcms.org/API/Tech";
const DEFAULT_LOCATION = "Lauderhill, FL";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 50;
const MILES_TO_METERS = 1609.344;

const discoveryInput = z.object({
  searchLocation: z.string().trim().min(2).max(200),
  radiusMiles: z.number().int().min(1).max(25),
}).strict();

const saveLeadInput = SaveLocalBusinessLeadBody;
const auditInput = AuditLocalBusinessWebsiteBody;
const proposalInput = DraftLocalBusinessProposalBody;

type Coordinates = { lat: number; lon: number; label: string };
type Business = {
  id: string;
  externalId: string;
  provider: "google_places" | "openstreetmap";
  name: string;
  website: string;
  category: string;
  location: string;
  mapsUrl: string | null;
  osmUrl: string | null;
};
type AuditResult = {
  id: string;
  leadId: string;
  leadName: string;
  website: string;
  status: "success" | "not_detected" | "unavailable" | "rate_limited";
  cms: string | null;
  language: string | null;
  technologies: string[];
  isWordPressOpportunity: boolean;
  message: string | null;
  createdAt: string;
};
type ProposalResult = z.infer<typeof DraftLocalBusinessProposalResponse>;

const geocodeCache = new Map<string, { value: Coordinates; expiresAt: number }>();
const userLastAction = new Map<string, number>();
let nextNominatimRequestAt = 0;

function allowUserAction(userId: string, cooldownMs: number): boolean {
  const now = Date.now();
  if (userLastAction.size > 1000) {
    for (const [key, time] of userLastAction) {
      if (now - time > 60 * 60_000) userLastAction.delete(key);
    }
  }
  const previous = userLastAction.get(userId) ?? 0;
  if (now - previous < cooldownMs) return false;
  userLastAction.set(userId, now);
  return true;
}

function normalizedText(value: unknown, maxLength = 200): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

async function geocodeLocation(searchLocation: string): Promise<Coordinates | null> {
  const normalized = searchLocation.trim().toLowerCase();
  const cached = geocodeCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const delay = Math.max(0, nextNominatimRequestAt - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  nextNominatimRequestAt = Date.now() + 1_100;

  const { data } = await axios.get(NOMINATIM_URL, {
    params: { q: searchLocation, format: "jsonv2", limit: 1 },
    headers: { "User-Agent": "CSD-WebsiteIntelligence/1.0 (support@computersystemsdepot.com)" },
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
  });
  const first = Array.isArray(data) ? data[0] : null;
  const lat = Number(first?.lat);
  const lon = Number(first?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !first) return null;
  const value = { lat, lon, label: normalizedText(first.display_name, 300) || searchLocation };
  if (geocodeCache.size > 1000) {
    for (const [key, entry] of geocodeCache) {
      if (entry.expiresAt <= Date.now()) geocodeCache.delete(key);
    }
    while (geocodeCache.size >= 1000) geocodeCache.delete(geocodeCache.keys().next().value!);
  }
  geocodeCache.set(normalized, { value, expiresAt: Date.now() + 24 * 60 * 60_000 });
  return value;
}

function googlePlaceBusiness(place: any): Business | null {
  const website = publicWebsite(place?.websiteUri);
  const id = normalizedText(place?.id, 300);
  const name = normalizedText(place?.displayName?.text, 200);
  if (!website || !id || !name) return null;
  return {
    id: `google:${id}`,
    externalId: id,
    provider: "google_places",
    name,
    website,
    category: normalizedText(place?.primaryTypeDisplayName?.text, 200) || "Local business",
    location: normalizedText(place?.formattedAddress, 500),
    mapsUrl: publicWebsite(place?.googleMapsUri),
    osmUrl: null,
  };
}

async function searchGooglePlaces(
  searchLocation: string,
  radiusMiles: number,
  center: Coordinates,
): Promise<Business[]> {
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) return [];
  const { data } = await axios.post(GOOGLE_PLACES_URL, {
    textQuery: `computer repair, IT support, and electronics service businesses in ${searchLocation}`,
    maxResultCount: 20,
    locationBias: {
      circle: {
        center: { latitude: center.lat, longitude: center.lon },
        radius: Math.min(radiusMiles * MILES_TO_METERS, 50_000),
      },
    },
  }, {
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.websiteUri,places.primaryTypeDisplayName,places.formattedAddress,places.googleMapsUri,places.location",
    },
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
  });
  const maxDistanceMeters = radiusMiles * MILES_TO_METERS;
  return (Array.isArray(data?.places) ? data.places : [])
    .filter((place: any) => {
      const lat = Number(place?.location?.latitude);
      const lon = Number(place?.location?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
      const toRadians = (degrees: number) => degrees * Math.PI / 180;
      const dLat = toRadians(lat - center.lat);
      const dLon = toRadians(lon - center.lon);
      const value = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(center.lat)) * Math.cos(toRadians(lat)) * Math.sin(dLon / 2) ** 2;
      return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)) <= maxDistanceMeters;
    })
    .map(googlePlaceBusiness)
    .filter((business: Business | null): business is Business => business !== null)
    .slice(0, MAX_RESULTS);
}

function osmBusiness(element: any): Business | null {
  const tags = element?.tags ?? {};
  const website = publicWebsite(tags.website ?? tags["contact:website"]);
  const name = normalizedText(tags.name, 200);
  const elementType = ["node", "way", "relation"].includes(element?.type) ? element.type : null;
  const osmId = Number(element?.id);
  if (!website || !name || !elementType || !Number.isSafeInteger(osmId)) return null;
  const category = normalizedText(
    tags.craft ?? tags.shop ?? tags.office ?? tags.amenity ?? tags.service,
    200,
  ) || "Local business";
  const locality = [tags["addr:city"], tags["addr:state"]].filter(Boolean).join(", ");
  const osmUrl = `https://www.openstreetmap.org/${elementType}/${osmId}`;
  return {
    id: `osm:${elementType}:${osmId}`,
    externalId: `${elementType}/${osmId}`,
    provider: "openstreetmap",
    name,
    website,
    category,
    location: normalizedText(locality, 500),
    mapsUrl: null,
    osmUrl,
  };
}

export class OpenStreetMapUnavailableError extends Error {
  constructor() {
    super("All OpenStreetMap (Overpass) servers failed or timed out");
    this.name = "OpenStreetMapUnavailableError";
  }
}

type OsmSearch = { businesses: Business[]; cachedAt: string | null; stale: boolean };
type OsmCacheEntry = { savedAt: string; businesses: Business[] };

function businessesFromOverpass(data: any): Business[] {
  const seen = new Set<string>();
  return (Array.isArray(data?.elements) ? data.elements : [])
    .map(osmBusiness)
    .filter((business: Business | null): business is Business => {
      if (!business || seen.has(business.website)) return false;
      seen.add(business.website);
      return true;
    })
    .slice(0, MAX_RESULTS);
}

async function queryOverpass(query: string): Promise<Business[]> {
  const deadline = Date.now() + OVERPASS_TOTAL_BUDGET_MS;
  let lastError: unknown;
  for (const [index, url] of OVERPASS_URLS.entries()) {
    const remaining = deadline - Date.now();
    if (remaining < 3_000) break;
    try {
      const { data } = await axios.post(url, `data=${encodeURIComponent(query)}`, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "CSD-WebsiteIntelligence/1.0 (support@computersystemsdepot.com)",
        },
        timeout: index === 0 ? Math.min(OVERPASS_FIRST_ATTEMPT_TIMEOUT_MS, remaining) : remaining,
        maxRedirects: 0,
      });
      if (!Array.isArray(data?.elements)) throw Object.assign(new Error("Overpass returned no JSON elements"), { code: "EBADRESPONSE" });
      return businessesFromOverpass(data);
    } catch (error: any) {
      lastError = error;
      logger.warn(
        { server: new URL(url).host, status: error?.response?.status, code: error?.code },
        "OpenStreetMap search server failed; trying the next one",
      );
      if (!isRetryableOverpassFailure(error) && error?.code !== "EBADRESPONSE") break;
      // Overloaded servers ask for backoff before the next attempt.
      if (index < OVERPASS_URLS.length - 1) await new Promise((resolve) => setTimeout(resolve, 1_000 * (index + 1)));
    }
  }
  const last = lastError as { code?: string; response?: { status?: number } } | undefined;
  logger.error({ status: last?.response?.status, code: last?.code }, "Every OpenStreetMap search server failed");
  throw new OpenStreetMapUnavailableError();
}

async function searchOpenStreetMap(radiusMiles: number, center: Coordinates): Promise<OsmSearch> {
  const cacheKey = osmSearchCacheKey(center.lat, center.lon, radiusMiles);
  const cached = await getAppState<OsmCacheEntry>(cacheKey).catch(() => null);
  const cachedAge = cached ? Date.now() - Date.parse(cached.savedAt) : Infinity;
  if (cached && cachedAge < OSM_CACHE_FRESH_MS) {
    return { businesses: cached.businesses, cachedAt: cached.savedAt, stale: false };
  }
  try {
    const businesses = await queryOverpass(overpassBusinessQuery(center.lat, center.lon, radiusMiles));
    const entry: OsmCacheEntry = { savedAt: new Date().toISOString(), businesses };
    await setAppState(cacheKey, entry).catch((error) => logger.warn({ err: error }, "Could not cache OpenStreetMap results"));
    return { businesses, cachedAt: null, stale: false };
  } catch (error) {
    if (cached && cachedAge < OSM_CACHE_STALE_MS) {
      return { businesses: cached.businesses, cachedAt: cached.savedAt, stale: true };
    }
    throw error;
  }
}

function googlePlacesConfiguredMessage(): string {
  return process.env.GOOGLE_PLACES_API_KEY?.trim()
    ? "Google Places and the free OpenStreetMap servers are both unavailable right now. Please try again in a minute."
    : "The free OpenStreetMap servers are overloaded right now. Try again in a minute, or add a GOOGLE_PLACES_API_KEY secret for reliable business search.";
}

function requireUserId(req: Request, res: Response): string | null {
  const id = req.dbUser?.id;
  if (!id) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }
  return id;
}

export async function applyLocalWebsiteIntelligenceMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS local_business_saved_leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL CHECK (provider IN ('google_places', 'openstreetmap')),
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      website TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      maps_url TEXT,
      osm_url TEXT,
      saved_by TEXT NOT NULL,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, external_id)
    );

    ALTER TABLE local_business_saved_leads
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS local_business_saved_leads_created_idx
      ON local_business_saved_leads (created_at DESC);

    CREATE TABLE IF NOT EXISTS local_business_discovery_results (
      provider TEXT NOT NULL CHECK (provider IN ('google_places', 'openstreetmap')),
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      website TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      maps_url TEXT,
      osm_url TEXT,
      searched_by TEXT NOT NULL,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, external_id)
    );

    CREATE TABLE IF NOT EXISTS local_website_audit_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES local_business_saved_leads(id) ON DELETE CASCADE,
      website TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'not_detected', 'unavailable', 'rate_limited')),
      cms TEXT,
      language TEXT,
      technologies JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_wordpress_opportunity BOOLEAN NOT NULL DEFAULT FALSE,
      message TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE local_website_audit_reports
      ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES local_business_saved_leads(id) ON DELETE CASCADE;

    CREATE INDEX IF NOT EXISTS local_website_audit_reports_created_idx
      ON local_website_audit_reports (created_at DESC);

    CREATE INDEX IF NOT EXISTS local_website_audit_reports_lead_idx
      ON local_website_audit_reports (lead_id, created_at DESC);
  `);
}

export function registerLocalWebsiteIntelligenceRoutes(app: Express): void {
  app.get("/api/crm/local-opportunities/status", (_req, res) => {
    res.json({
      defaultSearchLocation: DEFAULT_LOCATION,
      googlePlacesConfigured: Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim()),
      openStreetMapAvailable: true,
      whatCmsConfigured: Boolean(process.env.WHATCMS_API_KEY?.trim()),
      activeSecurityTestsAvailable: false,
    });
  });

  app.post("/api/crm/local-opportunities/discover", async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const parsed = discoveryInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Enter a location and a radius from 1 to 25 miles." });
      return;
    }
    if (!allowUserAction(`discover:${userId}`, 10_000)) {
      res.status(429).json({ message: "Please wait before running another business search." });
      return;
    }

    const { searchLocation, radiusMiles } = parsed.data;
    try {
      const center = await geocodeLocation(searchLocation);
      if (!center) {
        res.status(400).json({ message: "That location could not be found. Try a city and state." });
        return;
      }
      const googlePlacesConfigured = Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());
      let businesses: Business[] = [];
      let source: "google_places" | "openstreetmap" = "openstreetmap";
      let providerNote = "Google Places is not configured; results came from OpenStreetMap.";
      if (googlePlacesConfigured) {
        try {
          businesses = await searchGooglePlaces(searchLocation, radiusMiles, center);
          if (businesses.length > 0) {
            source = "google_places";
            providerNote = "Primary provider: Google Places.";
          } else {
            providerNote = "Google Places returned no businesses with public websites; OpenStreetMap supplied the results.";
          }
        } catch {
          providerNote = "Google Places was unavailable; OpenStreetMap supplied the fallback results.";
        }
      }
      if (businesses.length === 0) {
        source = "openstreetmap";
        const osm = await searchOpenStreetMap(radiusMiles, center);
        businesses = osm.businesses;
        if (osm.cachedAt) {
          const when = new Date(osm.cachedAt).toLocaleString("en-US", { timeZone: process.env.BUSINESS_TIMEZONE || "America/New_York" });
          providerNote = osm.stale
            ? `OpenStreetMap's servers are busy, so these are the last results saved for this area (${when}).`
            : `${providerNote} Showing results saved ${when}; OpenStreetMap is checked again after 24 hours.`;
        }
      }
      await pool.query(
        `DELETE FROM local_business_discovery_results
          WHERE checked_at < NOW() - INTERVAL '7 days'`,
      );
      if (businesses.length > 0) {
        const rows = businesses.map((business) => ({
          provider: business.provider,
          external_id: business.externalId,
          name: business.name,
          website: business.website,
          category: business.category,
          location: business.location,
          maps_url: business.mapsUrl,
          osm_url: business.osmUrl,
        }));
        await pool.query(
          `INSERT INTO local_business_discovery_results
             (provider, external_id, name, website, category, location, maps_url, osm_url, searched_by, checked_at)
           SELECT provider, external_id, name, website, category, location, maps_url, osm_url, $2, NOW()
             FROM jsonb_to_recordset($1::jsonb) AS item(
               provider text, external_id text, name text, website text, category text,
               location text, maps_url text, osm_url text
             )
           ON CONFLICT (provider, external_id) DO UPDATE SET
             name = EXCLUDED.name, website = EXCLUDED.website, category = EXCLUDED.category,
             location = EXCLUDED.location, maps_url = EXCLUDED.maps_url, osm_url = EXCLUDED.osm_url,
             searched_by = EXCLUDED.searched_by, checked_at = NOW()`,
          [JSON.stringify(rows), userId],
        );
      }
      res.json({
        businesses,
        total: businesses.length,
        radiusMiles,
        searchLocation: center.label,
        source,
        providerNote,
        googlePlacesConfigured,
        whatCmsConfigured: Boolean(process.env.WHATCMS_API_KEY?.trim()),
        activeSecurityTestsAvailable: false,
      });
    } catch (error) {
      if (error instanceof OpenStreetMapUnavailableError) {
        res.setHeader("Retry-After", "60");
        res.status(503).json({
          message: googlePlacesConfiguredMessage(),
        });
        return;
      }
      req.log.error({ err: error }, "Business search failed");
      res.status(502).json({ message: "Business search is temporarily unavailable. Please try again shortly." });
    }
  });

  app.post("/api/crm/local-opportunities/audit", async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const parsed = auditInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Select a saved business lead and confirm you are authorized to request a passive technology lookup." });
      return;
    }
    if (!allowUserAction(`audit:${userId}`, 15_000)) {
      res.status(429).json({ message: "Please wait before checking another website." });
      return;
    }
    const leadResult = await pool.query(
      `SELECT id, name, website
         FROM local_business_saved_leads
        WHERE id = $1 AND verified_at IS NOT NULL
        LIMIT 1`,
      [parsed.data.leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) {
      res.status(404).json({ message: "Save this discovered business as a prospect before requesting a technology report." });
      return;
    }
    const website = validPublicWebsite(lead.website, true);
    if (!website) {
      res.status(400).json({ message: "This lead does not have a valid public HTTPS website for a passive technology lookup." });
      return;
    }
    const apiKey = process.env.WHATCMS_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({ message: "WhatCMS is not configured. Add WHATCMS_API_KEY in Replit Secrets to enable passive technology checks." });
      return;
    }

    try {
      const response = await axios.get(WHATCMS_URL, {
        params: { key: apiKey, url: website.toString(), private: "true" },
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 0,
      });
      const mapped = mapWhatCmsResponse(response.data);
      if (mapped.status === "rate_limited") {
        res.status(429).json({ message: mapped.message });
        return;
      }
      if (mapped.status === "unavailable") {
        res.status(502).json({ message: mapped.message });
        return;
      }
      const hasEvidence = Boolean(mapped.cms || mapped.language || mapped.technologies.length > 0);
      if (!hasEvidence) {
        res.json({
          id: randomUUID(),
          leadId: lead.id,
          leadName: lead.name,
          website: website.toString(),
          ...mapped,
          message: mapped.message || "The provider returned no supporting technology evidence; no report was saved.",
          createdAt: new Date().toISOString(),
        } satisfies AuditResult);
        return;
      }
      const result = await pool.query(
        `INSERT INTO local_website_audit_reports
          (lead_id, website, status, cms, language, technologies, is_wordpress_opportunity, message, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         RETURNING id, website, status, cms, language, technologies, is_wordpress_opportunity, message, created_at`,
        [
          lead.id,
          website.toString(),
          mapped.status,
          mapped.cms,
          mapped.language,
          JSON.stringify(mapped.technologies),
          mapped.isWordPressOpportunity,
          mapped.message,
          userId,
        ],
      );
      const row = result.rows[0];
      res.json(AuditLocalBusinessWebsiteResponse.parse({
        id: row.id,
        leadId: lead.id,
        leadName: lead.name,
        website: row.website,
        status: row.status,
        cms: row.cms,
        language: row.language,
        technologies: row.technologies,
        isWordPressOpportunity: row.is_wordpress_opportunity,
        message: row.message,
        createdAt: new Date(row.created_at).toISOString(),
      }));
    } catch (error: any) {
      const status = Number(error?.response?.status);
      if (status === 429) {
        res.status(429).json({ message: "WhatCMS request limit reached. Please try again later." });
        return;
      }
      req.log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "Passive technology lookup failed");
      res.status(502).json({ message: "WhatCMS could not complete the passive website check." });
    }
  });

  app.get("/api/crm/local-opportunities/reports", async (req, res) => {
    if (!requireUserId(req, res)) return;
    try {
      const result = await pool.query(
        `SELECT report.id, report.lead_id, lead.name AS lead_name, report.website, report.status,
                report.cms, report.language, report.technologies, report.is_wordpress_opportunity,
                report.message, report.created_at
           FROM local_website_audit_reports report
           JOIN local_business_saved_leads lead ON lead.id = report.lead_id
          WHERE report.lead_id IS NOT NULL
            AND (report.cms IS NOT NULL OR report.language IS NOT NULL OR jsonb_array_length(report.technologies) > 0)
          ORDER BY report.created_at DESC LIMIT 100`,
      );
      res.json({
        reports: result.rows.map((row: any) => ({
          id: row.id,
          leadId: row.lead_id,
          leadName: row.lead_name,
          website: row.website,
          status: row.status,
          cms: row.cms,
          language: row.language,
          technologies: row.technologies,
          isWordPressOpportunity: row.is_wordpress_opportunity,
          message: row.message,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      });
    } catch {
      res.status(500).json({ message: "Audit reports could not be loaded." });
    }
  });

  app.get("/api/crm/local-opportunities/leads", async (req, res) => {
    if (!requireUserId(req, res)) return;
    try {
      const result = await pool.query(
        `SELECT id, provider, external_id, name, website, category, location, maps_url, osm_url, created_at
         FROM local_business_saved_leads
        WHERE verified_at IS NOT NULL
        ORDER BY created_at DESC LIMIT 500`,
      );
      res.json({
        leads: result.rows.map((row: any) => ({
          id: row.id,
          externalId: row.external_id,
          provider: row.provider,
          name: row.name,
          website: row.website,
          category: row.category,
          location: row.location,
          mapsUrl: row.maps_url,
          osmUrl: row.osm_url,
          savedAt: new Date(row.created_at).toISOString(),
        })),
      });
    } catch {
      res.status(500).json({ message: "Saved business prospects could not be loaded." });
    }
  });

  app.post("/api/crm/local-opportunities/leads", async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const parsed = saveLeadInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Select a valid discovered business to save." });
      return;
    }
    try {
      const verified = await pool.query(
        `SELECT provider, external_id, name, website, category, location, maps_url, osm_url
           FROM local_business_discovery_results
          WHERE provider = $1 AND external_id = $2
            AND checked_at > NOW() - INTERVAL '24 hours'
          LIMIT 1`,
        [parsed.data.business.provider, parsed.data.business.externalId],
      );
      const business = verified.rows[0];
      if (!business) {
        res.status(404).json({ message: "This listing is no longer verified. Search again to refresh provider results before saving it." });
        return;
      }
      const website = publicWebsite(business.website);
      if (!website) {
        res.status(400).json({ message: "The discovered business website is not a valid public address." });
        return;
      }
      const result = await pool.query(
        `INSERT INTO local_business_saved_leads
          (provider, external_id, name, website, category, location, maps_url, osm_url, saved_by, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (provider, external_id) DO UPDATE SET
           name = EXCLUDED.name, website = EXCLUDED.website, category = EXCLUDED.category,
            location = EXCLUDED.location, maps_url = EXCLUDED.maps_url, osm_url = EXCLUDED.osm_url,
            saved_by = EXCLUDED.saved_by, verified_at = NOW()
          RETURNING id, provider, external_id, name, website, category, location, maps_url, osm_url, created_at`,
        [business.provider, business.external_id, business.name, website, business.category, business.location, business.maps_url, business.osm_url, userId],
      );
      const row = result.rows[0];
      res.json({
        id: row.id,
        externalId: row.external_id,
        provider: row.provider,
        name: row.name,
        website: row.website,
        category: row.category,
        location: row.location,
        mapsUrl: row.maps_url,
        osmUrl: row.osm_url,
        savedAt: new Date(row.created_at).toISOString(),
      });
    } catch {
      res.status(500).json({ message: "This business could not be saved." });
    }
  });

  app.post("/api/crm/local-opportunities/proposals", async (req, res) => {
    if (!requireUserId(req, res)) return;
    const parsed = proposalInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Choose a saved business and an active CSD service catalog item." });
      return;
    }

    try {
      const leadResult = await pool.query(
        `SELECT id, name, website
           FROM local_business_saved_leads
          WHERE id = $1 AND verified_at IS NOT NULL
          LIMIT 1`,
        [parsed.data.leadId],
      );
      const lead = leadResult.rows[0];
      if (!lead) {
        res.status(404).json({ message: "The saved business lead was not found." });
        return;
      }

      const evidenceResult = await pool.query(
        `SELECT cms, language, technologies
           FROM local_website_audit_reports
          WHERE lead_id = $1
            AND (cms IS NOT NULL OR language IS NOT NULL OR jsonb_array_length(technologies) > 0)
          ORDER BY created_at DESC
          LIMIT 1`,
        [lead.id],
      );
      const report = evidenceResult.rows[0];
      if (!report) {
        res.status(409).json({ message: "Run an authorized technology check with returned evidence before drafting a proposal." });
        return;
      }

      const evidence = [
        ...(report.cms ? [`CMS detected by WhatCMS: ${report.cms}`] : []),
        ...(report.language ? [`Language detected by WhatCMS: ${report.language}`] : []),
        ...(Array.isArray(report.technologies) ? report.technologies.slice(0, 8).map((technology: string) => `Technology detected by WhatCMS: ${technology}`) : []),
      ].slice(0, 10);
      if (evidence.length === 0) {
        res.status(409).json({ message: "The technology report does not contain supporting evidence." });
        return;
      }

      const service = await getCsdApprovedCatalogService(parsed.data.catalogItemId);
      if (!service) {
        res.status(409).json({ message: "Choose an active CSD service with an owner-managed catalog price." });
        return;
      }
      const draft = draftProposal([{
        label: service.name,
        unitPriceCents: service.unitAmountCents,
        quantity: 1,
      }]);
      res.json(DraftLocalBusinessProposalResponse.parse({
        leadId: lead.id,
        leadName: lead.name,
        website: lead.website,
        evidence,
        serviceId: service.id,
        serviceName: service.name,
        unitAmountCents: service.unitAmountCents,
        subtotalCents: draft.subtotalCents,
        status: "draft_needs_review",
      } satisfies ProposalResult));
    } catch (error) {
      req.log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "Website proposal draft could not be prepared");
      res.status(500).json({ message: "The proposal draft could not be prepared." });
    }
  });
}

export const localWebsiteIntelligenceInternals = {
  collectTechnologyNames,
  validPublicWebsite,
  publicWebsite,
  mapWhatCmsResponse,
  googlePlaceBusiness,
  osmBusiness,
};
