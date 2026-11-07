import type { Express, Request, Response } from "express";
import axios from "axios";
import { z } from "zod/v4";
import { pool } from "./db";
import { collectTechnologyNames, mapWhatCmsResponse, publicWebsite, validPublicWebsite } from "./local-website-intelligence-core";

const GOOGLE_PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const WHATCMS_URL = "https://whatcms.org/API/Tech";
const DEFAULT_LOCATION = "Lauderhill, FL";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 50;
const MILES_TO_METERS = 1609.344;

const discoveryInput = z.object({
  searchLocation: z.string().trim().min(2).max(200),
  radiusMiles: z.number().int().min(1).max(25),
}).strict();

const businessSchema = z.object({
  id: z.string().min(1).max(300),
  externalId: z.string().min(1).max(300),
  provider: z.enum(["google_places", "openstreetmap"]),
  name: z.string().trim().min(1).max(200),
  website: z.string().url().max(2048),
  category: z.string().trim().max(200),
  location: z.string().trim().max(500),
  mapsUrl: z.string().url().nullable(),
  osmUrl: z.string().url().nullable(),
}).strict();

const saveLeadInput = z.object({ business: businessSchema }).strict();
const auditInput = z.object({
  website: z.string().trim().url().max(2048),
  authorizationConfirmed: z.literal(true),
}).strict();

type Coordinates = { lat: number; lon: number; label: string };
type Business = z.infer<typeof businessSchema>;
type AuditResult = {
  id: string;
  website: string;
  status: "success" | "not_detected" | "unavailable" | "rate_limited";
  cms: string | null;
  language: string | null;
  technologies: string[];
  isWordPressOpportunity: boolean;
  message: string | null;
  createdAt: string;
};

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

async function searchOpenStreetMap(radiusMiles: number, center: Coordinates): Promise<Business[]> {
  const radius = Math.round(radiusMiles * MILES_TO_METERS);
  const query = `[out:json][timeout:20];
(
  nwr(around:${radius},${center.lat},${center.lon})["website"]["name"]["craft"="computer_repair"];
  nwr(around:${radius},${center.lat},${center.lon})["contact:website"]["name"]["craft"="computer_repair"];
  nwr(around:${radius},${center.lat},${center.lon})["website"]["name"]["shop"~"computer|electronics|mobile_phone"];
  nwr(around:${radius},${center.lat},${center.lon})["contact:website"]["name"]["shop"~"computer|electronics|mobile_phone"];
  nwr(around:${radius},${center.lat},${center.lon})["website"]["name"]["office"="it"];
  nwr(around:${radius},${center.lat},${center.lon})["contact:website"]["name"]["office"="it"];
);
out center tags;`;
  const { data } = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30_000,
    maxRedirects: 0,
  });
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, external_id)
    );

    CREATE INDEX IF NOT EXISTS local_business_saved_leads_created_idx
      ON local_business_saved_leads (created_at DESC);

    CREATE TABLE IF NOT EXISTS local_website_audit_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

    CREATE INDEX IF NOT EXISTS local_website_audit_reports_created_idx
      ON local_website_audit_reports (created_at DESC);
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
        businesses = await searchOpenStreetMap(radiusMiles, center);
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
    } catch {
      res.status(502).json({ message: "Business search is temporarily unavailable. Please try again shortly." });
    }
  });

  app.post("/api/crm/local-opportunities/audit", async (req, res) => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const parsed = auditInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Confirm you are authorized to request a passive technology lookup and enter a valid HTTPS website." });
      return;
    }
    if (!allowUserAction(`audit:${userId}`, 15_000)) {
      res.status(429).json({ message: "Please wait before checking another website." });
      return;
    }
    const website = validPublicWebsite(parsed.data.website, true);
    if (!website) {
      res.status(400).json({ message: "Use a public HTTPS website without a URL query, fragment, or credentials." });
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
      const result = await pool.query(
        `INSERT INTO local_website_audit_reports
          (website, status, cms, language, technologies, is_wordpress_opportunity, message, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         RETURNING id, website, status, cms, language, technologies, is_wordpress_opportunity, message, created_at`,
        [
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
      res.json({
        id: row.id,
        website: row.website,
        status: row.status,
        cms: row.cms,
        language: row.language,
        technologies: row.technologies,
        isWordPressOpportunity: row.is_wordpress_opportunity,
        message: row.message,
        createdAt: new Date(row.created_at).toISOString(),
      } satisfies AuditResult);
    } catch (error: any) {
      const status = Number(error?.response?.status);
      if (status === 429) {
        res.status(429).json({ message: "WhatCMS request limit reached. Please try again later." });
        return;
      }
      res.status(502).json({ message: "WhatCMS could not complete the passive website check." });
    }
  });

  app.get("/api/crm/local-opportunities/reports", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, website, status, cms, language, technologies, is_wordpress_opportunity, message, created_at
         FROM local_website_audit_reports ORDER BY created_at DESC LIMIT 100`,
      );
      res.json({
        reports: result.rows.map((row: any) => ({
          id: row.id,
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

  app.get("/api/crm/local-opportunities/leads", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, provider, external_id, name, website, category, location, maps_url, osm_url, created_at
         FROM local_business_saved_leads ORDER BY created_at DESC LIMIT 500`,
      );
      res.json({
        leads: result.rows.map((row: any) => ({
          id: `${row.provider}:${row.external_id}`,
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
    const business = parsed.data.business;
    const website = publicWebsite(business.website);
    if (!website) {
      res.status(400).json({ message: "The business website is not a valid public address." });
      return;
    }
    try {
      const result = await pool.query(
        `INSERT INTO local_business_saved_leads
          (provider, external_id, name, website, category, location, maps_url, osm_url, saved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (provider, external_id) DO UPDATE SET
           name = EXCLUDED.name, website = EXCLUDED.website, category = EXCLUDED.category,
           location = EXCLUDED.location, maps_url = EXCLUDED.maps_url, osm_url = EXCLUDED.osm_url
         RETURNING provider, external_id, name, website, category, location, maps_url, osm_url, created_at`,
        [business.provider, business.externalId, business.name, website, business.category, business.location, business.mapsUrl, business.osmUrl, userId],
      );
      const row = result.rows[0];
      res.json({
        id: `${row.provider}:${row.external_id}`,
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
}

export const localWebsiteIntelligenceInternals = {
  collectTechnologyNames,
  validPublicWebsite,
  publicWebsite,
  mapWhatCmsResponse,
  googlePlaceBusiness,
  osmBusiness,
};
