import { isTwilioConfigured } from "./twilio";

/**
 * Normalized A2P 10DLC verdict the Messages page and background monitor act on.
 *
 * Status mapping (so callers don't have to read the body):
 *  - `not_registered` — no brand and no campaign found on the Twilio account.
 *  - `pending`        — brand or campaign exists but neither is fully approved/verified yet.
 *  - `approved`       — at least one brand APPROVED *and* at least one campaign VERIFIED.
 *  - `rejected`       — Twilio actually rejected the registration: brand is
 *                       `FAILED`/`SUSPENDED`, or campaign is `FAILED`.
 *  - `failed`         — we could not determine the verdict because the Twilio
 *                       API call itself failed (`result.error` will be set).
 *                       This is a *lookup* failure, not a registration failure.
 */
export type A2PStatus = "not_registered" | "pending" | "approved" | "rejected" | "failed";

export interface A2PBrandSummary {
  sid: string;
  status: string;
  brandType?: string;
  failureReason: string | null;
  // Customer profile + A2P trust product bundles this brand was built from.
  // Used by the UI to map bundle-level rejection reasons back to their brand.
  customerProfileBundleSid?: string;
  a2pProfileBundleSid?: string;
}

export interface A2PCampaignSummary {
  sid: string;
  messagingServiceSid: string;
  messagingServiceName?: string;
  brandRegistrationSid?: string;
  campaignStatus: string;
  usAppToPersonUsecase?: string;
  description?: string;
  failureReason?: string | null;
}

/**
 * Field-level rejection coming back from a Trust Hub bundle evaluation. Each
 * entry is one specific thing the customer needs to fix (e.g. "EIN doesn't
 * match legal name", "missing website").
 */
export interface A2PBundleRejection {
  bundleSid: string;
  bundleType: "customer_profile" | "trust_product";
  // Which field section the rejection belongs to so the UI can render it next
  // to the right wizard step ("business" -> step 1, "rep" -> step 2,
  // "address" -> step 1, "campaign" -> step 3, "other" -> general banner).
  section: "business" | "rep" | "address" | "campaign" | "other";
  objectType?: string;   // e.g. "customer_profile_business_information"
  field?: string;        // e.g. "business_name"
  failureReason: string;
}

export interface A2PStatusResult {
  status: A2PStatus;
  configured: boolean;
  useCase: string | null;
  brands: A2PBrandSummary[];
  campaigns: A2PCampaignSummary[];
  bundleRejections: A2PBundleRejection[];
  phoneNumbers: string[];
  note: string | null;
  error?: string;
}

const BLOCKED_NOTE =
  "Outbound SMS may be blocked by carriers with error 30034 until A2P 10DLC is fully approved.";

interface TwilioBrand {
  sid: string;
  status: string;
  brandType?: string;
  failureReason?: string | null;
  customerProfileBundleSid?: string;
  a2pProfileBundleSid?: string;
}

interface TwilioEvaluationFieldResult {
  object_field?: string;
  passed?: boolean;
  failure_reason?: string;
}
interface TwilioEvaluationResult {
  object_type?: string;
  passed?: boolean;
  failure_reason?: string;
  fields?: TwilioEvaluationFieldResult[];
}
interface TwilioBundleEvaluation {
  sid: string;
  status?: string;
  results?: TwilioEvaluationResult[];
  dateCreated?: string;
}
interface TwilioCampaign {
  sid: string;
  brandRegistrationSid?: string;
  campaignStatus: string;
  usAppToPersonUsecase?: string;
  description?: string;
  // Twilio surfaces campaign rejection details on the usAppToPerson resource
  // under one of these fields depending on SDK version. We accept all.
  rejectionReason?: string | null;
  errors?: Array<{ code?: string; description?: string }> | null;
  failureReason?: string | null;
}
interface TwilioService {
  sid: string;
  friendlyName?: string;
}
interface TwilioServicePhone {
  phoneNumber?: string;
}

/**
 * Look up A2P 10DLC brand + campaign status from Twilio and normalize it to a
 * single verdict the UI (and background monitor) can act on.
 *
 * Extracted from `GET /api/twilio/a2p/status` so the scheduled monitor in
 * `server/a2p-monitor.ts` can run the exact same logic on a timer.
 */
export async function getA2PStatus(): Promise<A2PStatusResult> {
  const configured = await isTwilioConfigured();
  if (!configured) {
    return {
      status: "not_registered",
      configured: false,
      useCase: null,
      brands: [],
      campaigns: [],
      bundleRejections: [],
      phoneNumbers: [],
      note: BLOCKED_NOTE,
    };
  }

  try {
    const { getTwilioClient, getTwilioFromPhoneNumber } = await import("./twilio");
    const client = await getTwilioClient();
    const twilioClient = client as unknown as {
      messaging: {
        v1: {
          brandRegistrations: { list: (opts: { limit: number }) => Promise<TwilioBrand[]> };
          services: {
            list: (opts: { limit: number }) => Promise<TwilioService[]>;
            (sid: string): {
              usAppToPerson: { list: (opts: { limit: number }) => Promise<TwilioCampaign[]> };
              phoneNumbers: { list: (opts: { limit: number }) => Promise<TwilioServicePhone[]> };
            };
          };
        };
      };
      trusthub: {
        v1: {
          customerProfiles: (sid: string) => {
            customerProfilesEvaluations: {
              list: (opts: { limit: number }) => Promise<TwilioBundleEvaluation[]>;
            };
          };
          trustProducts: (sid: string) => {
            trustProductsEvaluations: {
              list: (opts: { limit: number }) => Promise<TwilioBundleEvaluation[]>;
            };
          };
        };
      };
    };
    const messagingV1 = twilioClient.messaging.v1;
    // Trust Hub namespace may not exist on every Twilio SDK build. Guard the
    // lookup so missing namespaces degrade to "no bundle rejections" instead
    // of taking the whole /status endpoint down with a thrown TypeError.
    let trusthubV1: typeof twilioClient.trusthub.v1 | null = null;
    try {
      trusthubV1 = twilioClient.trusthub?.v1 || null;
    } catch {
      trusthubV1 = null;
    }

    let upstreamError: string | null = null;

    let brands: TwilioBrand[] = [];
    try {
      brands = await messagingV1.brandRegistrations.list({ limit: 20 });
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      if (status === 404) {
        brands = [];
      } else {
        upstreamError = (e as Error)?.message || "brandRegistrations.list failed";
      }
    }

    let services: TwilioService[] = [];
    try {
      services = await messagingV1.services.list({ limit: 50 });
    } catch (e: unknown) {
      upstreamError = upstreamError || ((e as Error)?.message || "services.list failed");
    }

    const campaigns: A2PCampaignSummary[] = [];
    const phoneNumbers = new Set<string>();
    for (const svc of services) {
      try {
        const usaps = await messagingV1.services(svc.sid).usAppToPerson.list({ limit: 10 });
        for (const c of usaps) {
          const campaignFailureReason =
            c.rejectionReason ||
            c.failureReason ||
            (Array.isArray(c.errors) && c.errors.length > 0
              ? c.errors
                  .map((e) => [e.code, e.description].filter(Boolean).join(": "))
                  .filter(Boolean)
                  .join("; ")
              : null) ||
            null;
          campaigns.push({
            sid: c.sid,
            messagingServiceSid: svc.sid,
            messagingServiceName: svc.friendlyName,
            brandRegistrationSid: c.brandRegistrationSid,
            campaignStatus: c.campaignStatus,
            usAppToPersonUsecase: c.usAppToPersonUsecase,
            description: c.description,
            failureReason: campaignFailureReason,
          });
        }
      } catch (e: unknown) {
        const status = (e as { status?: number })?.status;
        if (status !== 404) {
          upstreamError = upstreamError || ((e as Error)?.message || "usAppToPerson.list failed");
        }
      }
      try {
        const nums = await messagingV1.services(svc.sid).phoneNumbers.list({ limit: 50 });
        for (const n of nums) if (n.phoneNumber) phoneNumbers.add(n.phoneNumber);
      } catch (e: unknown) {
        console.warn("[a2p/status] phoneNumbers.list failed for service", svc.sid, (e as Error)?.message);
      }
    }

    if (upstreamError) {
      console.error("[a2p/status] upstream error:", upstreamError);
      return {
        status: "failed",
        configured: true,
        useCase: null,
        brands: [],
        campaigns: [],
        bundleRejections: [],
        phoneNumbers: [],
        error: upstreamError,
        note: BLOCKED_NOTE,
      };
    }

    if (phoneNumbers.size === 0) {
      const from = await getTwilioFromPhoneNumber();
      if (from) phoneNumbers.add(from);
    }

    const brandSummary: A2PBrandSummary[] = brands.map((b) => ({
      sid: b.sid,
      status: b.status,
      brandType: b.brandType,
      failureReason: b.failureReason || null,
      customerProfileBundleSid: b.customerProfileBundleSid,
      a2pProfileBundleSid: b.a2pProfileBundleSid,
    }));

    // Collect bundle-level rejections. Twilio exposes per-field failure
    // reasons on the latest evaluation of a customer profile / trust product
    // bundle. We only pull these when the brand isn't approved — there's no
    // point surfacing stale evaluation noise on a healthy registration.
    const bundleRejections: A2PBundleRejection[] = [];
    const sectionForObjectType = (objectType?: string): A2PBundleRejection["section"] => {
      const t = (objectType || "").toLowerCase();
      if (t.includes("authorized_representative")) return "rep";
      if (t.includes("address")) return "address";
      if (t.includes("business")) return "business";
      if (t.includes("messaging") || t.includes("us_a2p") || t.includes("a2p")) return "campaign";
      return "other";
    };
    const sectionForField = (field?: string): A2PBundleRejection["section"] | null => {
      const f = (field || "").toLowerCase();
      if (!f) return null;
      if (f.startsWith("first_name") || f.startsWith("last_name") || f === "email" || f === "phone_number" || f.includes("job_position") || f.includes("business_title")) return "rep";
      if (f.startsWith("street") || f === "city" || f === "region" || f === "postal_code" || f === "iso_country") return "address";
      if (f.startsWith("business_") || f === "website_url" || f === "ein") return "business";
      return null;
    };
    const collectEvalRejections = (
      bundleSid: string,
      bundleType: A2PBundleRejection["bundleType"],
      evals: TwilioBundleEvaluation[],
    ) => {
      // Twilio returns evaluations in reverse chronological order. The
      // newest one is what reflects the current review verdict.
      const latest = evals[0];
      if (!latest || !Array.isArray(latest.results)) return;
      for (const r of latest.results) {
        if (r.passed) continue;
        if (Array.isArray(r.fields)) {
          for (const f of r.fields) {
            if (f.passed) continue;
            if (!f.failure_reason) continue;
            bundleRejections.push({
              bundleSid,
              bundleType,
              section: sectionForField(f.object_field) || sectionForObjectType(r.object_type),
              objectType: r.object_type,
              field: f.object_field,
              failureReason: f.failure_reason,
            });
          }
        } else if (r.failure_reason) {
          bundleRejections.push({
            bundleSid,
            bundleType,
            section: sectionForObjectType(r.object_type),
            objectType: r.object_type,
            failureReason: r.failure_reason,
          });
        }
      }
    };

    const seenBundles = new Set<string>();
    if (trusthubV1) {
      for (const b of brands) {
        if (b.status === "APPROVED") continue;
        if (b.customerProfileBundleSid && !seenBundles.has(b.customerProfileBundleSid)) {
          seenBundles.add(b.customerProfileBundleSid);
          try {
            const evals = await trusthubV1
              .customerProfiles(b.customerProfileBundleSid)
              .customerProfilesEvaluations.list({ limit: 5 });
            collectEvalRejections(b.customerProfileBundleSid, "customer_profile", evals);
          } catch (e: unknown) {
            console.warn(
              "[a2p/status] customerProfilesEvaluations.list failed for",
              b.customerProfileBundleSid,
              (e as Error)?.message,
            );
          }
        }
        if (b.a2pProfileBundleSid && !seenBundles.has(b.a2pProfileBundleSid)) {
          seenBundles.add(b.a2pProfileBundleSid);
          try {
            const evals = await trusthubV1
              .trustProducts(b.a2pProfileBundleSid)
              .trustProductsEvaluations.list({ limit: 5 });
            collectEvalRejections(b.a2pProfileBundleSid, "trust_product", evals);
          } catch (e: unknown) {
            console.warn(
              "[a2p/status] trustProductsEvaluations.list failed for",
              b.a2pProfileBundleSid,
              (e as Error)?.message,
            );
          }
        }
      }
    } else {
      console.warn("[a2p/status] trusthub namespace unavailable on Twilio SDK; skipping bundle evaluations");
    }

    let status: A2PStatus;
    if (brandSummary.length === 0 && campaigns.length === 0) {
      status = "not_registered";
    } else {
      const anyApprovedBrand = brandSummary.some((b) => b.status === "APPROVED");
      const anyFailedBrand = brandSummary.some((b) => b.status === "FAILED" || b.status === "SUSPENDED");
      const anyVerifiedCampaign = campaigns.some((c) => c.campaignStatus === "VERIFIED");
      const anyFailedCampaign = campaigns.some((c) => c.campaignStatus === "FAILED");
      if (anyApprovedBrand && anyVerifiedCampaign) status = "approved";
      else if (anyFailedCampaign || anyFailedBrand) status = "rejected";
      else status = "pending";
    }

    const useCase = campaigns.find((c) => c.usAppToPersonUsecase)?.usAppToPersonUsecase || null;

    return {
      status,
      configured: true,
      useCase,
      brands: brandSummary,
      campaigns,
      bundleRejections,
      phoneNumbers: Array.from(phoneNumbers),
      note: status === "approved" ? null : BLOCKED_NOTE,
    };
  } catch (err: unknown) {
    const message = (err as Error)?.message || "twilio a2p lookup failed";
    console.error("[a2p/status] failed:", message);
    return {
      status: "failed",
      configured: true,
      useCase: null,
      brands: [],
      campaigns: [],
      bundleRejections: [],
      phoneNumbers: [],
      error: message,
      note: BLOCKED_NOTE,
    };
  }
}

/**
 * Collect human-readable failure reasons from brands and campaigns so the
 * monitor (and any future UI) can surface why Twilio rejected the registration.
 */
export function collectFailureReasons(result: A2PStatusResult): string[] {
  const reasons: string[] = [];
  for (const b of result.brands) {
    if ((b.status === "FAILED" || b.status === "SUSPENDED") && b.failureReason) {
      reasons.push(`Brand ${b.sid}: ${b.failureReason}`);
    } else if (b.status === "FAILED" || b.status === "SUSPENDED") {
      reasons.push(`Brand ${b.sid}: ${b.status}`);
    }
  }
  for (const c of result.campaigns) {
    if (c.campaignStatus === "FAILED") {
      const label = c.messagingServiceName || c.messagingServiceSid;
      const detail = c.failureReason ? `FAILED — ${c.failureReason}` : "FAILED";
      reasons.push(`Campaign ${c.sid} (${label}): ${detail}`);
    }
  }
  for (const r of result.bundleRejections) {
    const where = r.field
      ? `${r.bundleType === "trust_product" ? "A2P bundle" : "Customer profile"} → ${r.field}`
      : `${r.bundleType === "trust_product" ? "A2P bundle" : "Customer profile"}${r.objectType ? ` → ${r.objectType}` : ""}`;
    reasons.push(`${where}: ${r.failureReason}`);
  }
  if (result.error) reasons.push(result.error);
  return reasons;
}
