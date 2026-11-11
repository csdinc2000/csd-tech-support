import type { Express } from "express";
import express from "express";
import { storage } from "../storage";
import { z } from "zod/v4";
import { requireAuth } from "../middlewares/clerkAuth";
import { getTwilioClient, getTwilioFromPhoneNumber } from "../twilio";
import { getAppStateWithLegacyFile, setAppState } from "../app-state";
import { requireOwner, resolveActor } from "./owner-auth";

// app_state key for the last A2P registration body ("Fix and resubmit" pre-fill).
const A2P_LAST_SUBMISSION_KEY = "a2p-last-submission";

export type A2pRouteOptions = {
  isTwilioConfigured: () => boolean | Promise<boolean>;
};

// A2P 10DLC: registration status + live events for the Messages banner,
// owner snooze, incident history, rejection-suggestion feedback, and the
// guided registration wizard. Paths are gated in security.ts (communications,
// with registration owner-only).
export function registerA2pRoutes(app: Express, { isTwilioConfigured }: A2pRouteOptions): void {
  // A2P 10DLC registration status. Surfaces brand + campaign state from Twilio
  // so the Messages page can warn the account owner before carriers start
  // dropping outbound texts with error 30034. The actual lookup lives in
  // `server/a2p-status.ts` so the scheduled monitor in `server/a2p-monitor.ts`
  // can reuse the exact same logic.
  app.get("/api/twilio/a2p/status", async (_req, res) => {
    const { getA2PStatus } = await import("../a2p-status");
    const result = await getA2PStatus();
    res.json(result);
  });

  // Server-Sent Events stream that pushes a `status` event whenever the
  // background monitor (server/a2p-monitor.ts) observes the A2P verdict or
  // rejection set change. The Messages page banner subscribes here so it
  // can refresh within seconds of a Twilio update instead of waiting up to
  // 5 minutes for its next poll. If the EventSource fails (proxy strips
  // SSE, browser tab throttled, etc.) the client keeps its 5-minute poll
  // as a fallback.
  // Requires auth (long-lived socket — gate it behind a session to avoid
  // anonymous connection abuse) even though the snapshot endpoint above
  // is open. Snooze GET is already isAuthenticated, so banner viewers
  // already have a session.
  app.get("/api/twilio/a2p/events", requireAuth, async (req, res) => {
    const { addA2PEventClient } = await import("../a2p-events");
    const cleanup = addA2PEventClient(res);
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  // GET is open to any authenticated user so the whole team can see when
  // A2P paging is muted — but we redact `snoozeStartedBy` for non-owners
  // and add an `allowed` flag the UI uses to decide whether to render the
  // snooze/resume buttons.
  app.get("/api/twilio/a2p/snooze", requireAuth, async (req, res) => {
    const { getA2PSnoozeStatus } = await import("../a2p-monitor");
    const [status, actor] = await Promise.all([
      getA2PSnoozeStatus(),
      resolveActor(req),
    ]);
    res.json({
      ...status,
      snoozeStartedBy: actor.isOwner ? status.snoozeStartedBy : null,
      allowed: actor.isOwner,
    });
  });

  const snoozeBodySchema = z.object({ hours: z.coerce.number().positive() });
  app.post("/api/twilio/a2p/snooze", requireAuth, requireOwner, async (req, res) => {
    const { snoozeA2PAlerts } = await import("../a2p-monitor");
    const parsed = snoozeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "hours must be a positive number" });
      return;
    }
    // Actor was resolved + verified by requireOwner, attached to req.
    const actor = (req as import("express").Request & {
      actor?: { email: string | null; sub: string | null };
    }).actor;
    const startedBy = actor?.email || actor?.sub || null;
    try {
      const status = await snoozeA2PAlerts(parsed.data.hours, startedBy);
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: (err as Error)?.message || "Failed to snooze" });
    }
  });

  app.delete("/api/twilio/a2p/snooze", requireAuth, requireOwner, async (_req, res) => {
    const { clearA2PSnooze } = await import("../a2p-monitor");
    res.json(await clearA2PSnooze());
  });

  // Incident history for the Messages page. Returns the last ~10 alerts the
  // A2P background monitor opened, with start/end times, duration, and how
  // each one was resolved (auto by the monitor vs acknowledged by a human).
  // Restricted to owners/admins — same gate as the snooze controls — because
  // it exposes operational reliability data the rest of the team doesn't
  // need to act on.
  app.get(
    "/api/twilio/a2p/incidents",
    requireAuth,
    requireOwner,
    async (_req, res) => {
      try {
        const list = await storage.getAlertsBySource("a2p-monitor", 10);
        const incidents = list.map((a) => {
          const startedAt = a.createdAt ?? null;
          const resolvedAt = a.resolvedAt ?? null;
          let durationMs: number | null = null;
          if (startedAt && resolvedAt) {
            durationMs = new Date(resolvedAt).getTime() - new Date(startedAt).getTime();
          }
          // Heuristic: the background monitor's auto-resolve path only sets
          // `status` + `resolvedAt`. When a human resolves an alert through
          // the Alerts UI they ack first (acknowledgedBy is set). Use that
          // to distinguish the two outcomes.
          let outcome: "active" | "auto-resolved" | "human-resolved";
          if (a.status !== "resolved") {
            outcome = "active";
          } else if (a.acknowledgedBy != null) {
            outcome = "human-resolved";
          } else {
            outcome = "auto-resolved";
          }
          return {
            id: a.id,
            title: a.title,
            severity: a.severity,
            status: a.status,
            startedAt,
            resolvedAt,
            durationMs,
            outcome,
          };
        });
        res.json(incidents);
      } catch (err) {
        console.error(
          "[a2p/incidents] failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to fetch A2P incidents" });
      }
    },
  );

  // A2P rejection-suggestion feedback loop. When Twilio returns a rejection
  // reason that doesn't match any pattern in `client/src/lib/a2p-rejections.ts`,
  // staff can submit a proposed plain-English remediation. Submissions land
  // in `a2p_rejection_suggestions` for owners/admins to review and use to
  // extend the curated KB.
  const suggestionInputSchema = z.object({
    reasonText: z.string().trim().min(1).max(2000),
    suggestedTitle: z.string().trim().min(3).max(200),
    suggestedRemediation: z.string().trim().min(10).max(2000),
    docUrl: z.string().trim().url().max(500).optional().or(z.literal("")),
  });

  app.post(
    "/api/twilio/a2p/rejection-suggestions",
    requireAuth,
    async (req, res) => {
      const parsed = suggestionInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message || "Invalid suggestion" });
        return;
      }
      try {
        const actor = await resolveActor(req);
        // De-dup: if a pending suggestion already covers this exact rejection
        // (ignoring case/whitespace), don't add another row — just tell the
        // submitter it's already reported and point at the existing entry.
        const existing = await storage.getPendingA2pRejectionSuggestionByReason(
          parsed.data.reasonText,
        );
        if (existing) {
          res.json({
            ok: true,
            id: existing.id,
            duplicate: true,
            message:
              "Thanks — someone already reported this rejection. It's waiting for review.",
          });
          return;
        }
        const created = await storage.createA2pRejectionSuggestion({
          reasonText: parsed.data.reasonText,
          suggestedTitle: parsed.data.suggestedTitle,
          suggestedRemediation: parsed.data.suggestedRemediation,
          docUrl: parsed.data.docUrl || undefined,
          submittedBy: actor.email || actor.sub || null,
        });
        res.json({ ok: true, id: created.id, duplicate: false });
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] create failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to save suggestion" });
      }
    },
  );

  app.get(
    "/api/twilio/a2p/rejection-suggestions",
    requireAuth,
    requireOwner,
    async (req, res) => {
      try {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const list = await storage.getA2pRejectionSuggestions(
          status ? { status } : undefined,
        );
        res.json(list);
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] list failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to load suggestions" });
      }
    },
  );

  const suggestionUpdateSchema = z.object({
    status: z.enum(["pending", "reviewed", "merged", "dismissed"]).optional(),
    reviewerNotes: z.string().trim().max(2000).nullable().optional(),
  });
  app.patch(
    "/api/twilio/a2p/rejection-suggestions/:id",
    requireAuth,
    requireOwner,
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      const parsed = suggestionUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message || "Invalid update" });
        return;
      }
      try {
        const updated = await storage.updateA2pRejectionSuggestion(id, parsed.data);
        if (!updated) {
          res.status(404).json({ error: "Not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] update failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to update suggestion" });
      }
    },
  );

  // A2P 10DLC guided registration. The Messages page wizard collects business
  // profile + campaign details and posts them here. We attempt each Trust Hub /
  // messaging step in order and return a per-step result so the UI can show
  // exactly what got created and what failed (e.g. brand creation often errors
  // until a customer profile bundle is approved by Twilio review).
  app.post("/api/twilio/a2p/register", async (req, res) => {
    interface RegisterBody {
      business?: {
        legalName?: string;
        ein?: string;
        businessType?: string; // LLC, Corporation, ...
        industry?: string;
        website?: string;
        regionsOfOperation?: string; // comma separated ISO codes e.g. "USA"
        address?: {
          street?: string;
          city?: string;
          region?: string;
          postalCode?: string;
          isoCountry?: string;
        };
        contact?: {
          firstName?: string;
          lastName?: string;
          email?: string;
          phone?: string;
          jobTitle?: string;
        };
      };
      campaign?: {
        description?: string;
        usAppToPersonUsecase?: string; // MIXED, CUSTOMER_CARE, MARKETING, ...
        messageSamples?: string[];
        optInMessage?: string;
        optInKeywords?: string[];
        messageFlow?: string;
        hasEmbeddedLinks?: boolean;
        hasEmbeddedPhone?: boolean;
        brandType?: string; // STANDARD or SOLE_PROPRIETOR
      };
      // Optional explicit PN... SID to attach to the messaging service. When
      // omitted we fall back to the configured TWILIO_PHONE_NUMBER's SID.
      phoneNumberSid?: string;
    }

    type StepResult =
      | { ok: true; sid: string; note?: string; reused?: boolean; phoneNumber?: string }
      | { ok: false; error: string; skipped?: boolean };

    const result: {
      configured: boolean;
      customerProfile: StepResult | null;
      brand: StepResult | null;
      messagingService: StepResult | null;
      phoneNumber: StepResult | null;
      campaign: StepResult | null;
    } = {
      configured: false,
      customerProfile: null,
      brand: null,
      messagingService: null,
      phoneNumber: null,
      campaign: null,
    };

    try {
      const body = (req.body || {}) as RegisterBody;
      const business = body.business || {};
      const campaign = body.campaign || {};
      const contact = business.contact || {};
      const address = business.address || {};

      // Light validation. Carriers + Twilio will reject anything thin so we
      // refuse early instead of submitting garbage.
      const missing: string[] = [];
      if (!business.legalName) missing.push("business.legalName");
      if (!business.ein) missing.push("business.ein");
      if (!business.website) missing.push("business.website");
      if (!contact.email) missing.push("business.contact.email");
      if (!campaign.description) missing.push("campaign.description");
      if (!campaign.usAppToPersonUsecase) missing.push("campaign.usAppToPersonUsecase");
      if (!campaign.messageSamples || campaign.messageSamples.filter(Boolean).length < 1) {
        missing.push("campaign.messageSamples");
      }
      if (!campaign.messageFlow) missing.push("campaign.messageFlow");
      if (missing.length) {
        res.status(400).json({ error: "Missing required fields", missing });
        return;
      }

      const configured = await isTwilioConfigured();
      result.configured = configured;
      if (!configured) {
        res.status(400).json({ error: "Twilio is not configured on this account", ...result });
        return;
      }

      const { getTwilioClient } = await import("../twilio");
      const client = await getTwilioClient();

      // The Twilio Node SDK doesn't expose typed namespaces for trusthub.v1
      // or messaging.v1.brandRegistrations / usAppToPerson, so we narrow to
      // just the fields we actually call. This keeps the SDK strongly typed
      // at the call site instead of relying on a blanket `any`.
      interface SidObject { sid: string }
      interface CustomerProfileInstance extends SidObject {
        update(opts: { status: string }): Promise<SidObject>;
        customerProfilesEntityAssignments: {
          create(opts: { objectSid: string }): Promise<SidObject>;
        };
      }
      interface TrustProductInstance extends SidObject {
        update(opts: { status: string }): Promise<SidObject>;
        trustProductsEntityAssignments: {
          create(opts: { objectSid: string }): Promise<SidObject>;
        };
        trustProductsChannelEndpointAssignment: {
          create(opts: { channelEndpointType: string; channelEndpointSid: string }): Promise<SidObject>;
        };
      }
      interface ListedServicePhoneNumber { sid: string; phoneNumberSid?: string; phoneNumber?: string }
      interface MessagingServiceInstance extends SidObject {
        usAppToPerson: {
          create(opts: {
            brandRegistrationSid: string;
            description: string;
            messageSamples: string[];
            usAppToPersonUsecase: string;
            hasEmbeddedLinks: boolean;
            hasEmbeddedPhone: boolean;
            messageFlow: string;
            optInMessage?: string;
            optInKeywords?: string[];
          }): Promise<SidObject>;
        };
        phoneNumbers: {
          create(opts: { phoneNumberSid: string }): Promise<SidObject>;
          list(opts: { limit: number }): Promise<ListedServicePhoneNumber[]>;
        };
      }
      interface ListedCustomerProfile { sid: string; friendlyName?: string; policySid?: string; status?: string }
      interface ListedTrustProduct { sid: string; friendlyName?: string; policySid?: string; status?: string }
      interface ListedBrandRegistration {
        sid: string;
        customerProfileBundleSid?: string;
        a2pProfileBundleSid?: string;
        status?: string;
      }
      interface ListedService { sid: string; friendlyName?: string }
      interface ListedCampaign {
        sid: string;
        brandRegistrationSid?: string;
        campaignStatus?: string;
      }
      interface MessagingServiceInstanceFull extends MessagingServiceInstance {
        usAppToPerson: MessagingServiceInstance["usAppToPerson"] & {
          list(opts: { limit: number }): Promise<ListedCampaign[]>;
          (sid: string): {
            update(opts: {
              hasEmbeddedLinks: boolean;
              hasEmbeddedPhone: boolean;
              messageSamples: string[];
              messageFlow: string;
              optInMessage?: string;
              optInKeywords?: string[];
              description: string;
              ageGated: boolean;
              directLending: boolean;
            }): Promise<SidObject>;
          };
        };
      }
      interface TwilioApi {
        addresses: {
          create(opts: {
            customerName: string;
            street: string;
            city: string;
            region: string;
            postalCode: string;
            isoCountry: string;
          }): Promise<SidObject>;
        };
        trusthub: {
          v1: {
            customerProfiles: {
              create(opts: { friendlyName: string; email: string; policySid: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedCustomerProfile[]>;
              (sid: string): CustomerProfileInstance;
            };
            trustProducts: {
              create(opts: { friendlyName: string; email: string; policySid: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedTrustProduct[]>;
              (sid: string): TrustProductInstance;
            };
            endUsers: {
              create(opts: { friendlyName: string; type: string; attributes: Record<string, unknown> }): Promise<SidObject>;
            };
          };
        };
        messaging: {
          v1: {
            brandRegistrations: {
              create(opts: {
                customerProfileBundleSid: string;
                a2PProfileBundleSid: string;
                brandType: string;
              }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedBrandRegistration[]>;
            };
            services: {
              create(opts: { friendlyName: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedService[]>;
              (sid: string): MessagingServiceInstanceFull;
            };
          };
        };
      }
      const c = client as unknown as TwilioApi;

      // Well-known Twilio policy SIDs published in the A2P 10DLC onboarding
      // docs. These are stable values that identify the regulatory policy
      // bundle templates and aren't account-specific.
      // https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
      const SECONDARY_CP_POLICY_SID = "RNdfbf3fae0e1107f8aded728e92e0289"; // Secondary Customer Profile
      const A2P_TRUST_PRODUCT_POLICY_SID = "RNb0d4771c2c98518d916a3d4cd70a8f8b"; // A2P Messaging Trust Product

      // ---- Step 1: Customer Profile (Trust Hub) ----------------------------
      // Discover any existing secondary customer profile bundle for this org
      // (matched by friendly name + policy SID) so re-runs after Twilio
      // review don't pile up duplicate unapproved bundles. Only create a new
      // one if none exists.
      const cpFriendlyName = `${business.legalName} Customer Profile`;
      let customerProfileSid: string | null = null;
      let customerProfileReused = false;
      let businessEndUserSid: string | null = null;
      let repEndUserSid: string | null = null;
      let addressSid: string | null = null;
      try {
        let cp: SidObject | null = null;
        try {
          const existing = await c.trusthub.v1.customerProfiles.list({ limit: 100 });
          const match = existing.find(
            (b) => b.policySid === SECONDARY_CP_POLICY_SID && b.friendlyName === cpFriendlyName,
          );
          if (match) {
            cp = { sid: match.sid };
            customerProfileReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] customerProfiles.list failed:", (listErr as Error)?.message);
        }
        if (!cp) {
          cp = await c.trusthub.v1.customerProfiles.create({
            friendlyName: cpFriendlyName,
            email: contact.email!,
            policySid: SECONDARY_CP_POLICY_SID,
          });
        }
        customerProfileSid = cp.sid;

        // On a re-run, the existing bundle already has end users + address
        // attached and is mid-review (or approved). Skip attach/submit work
        // entirely — repeating it produces duplicate end users and Twilio
        // rejects status updates on already-submitted bundles.
        let submitted = false;
        if (!customerProfileReused) {
          try {
            const eu = await c.trusthub.v1.endUsers.create({
              friendlyName: `${business.legalName} business info`,
              type: "customer_profile_business_information",
              attributes: {
                business_name: business.legalName,
                business_type: business.businessType || "LLC",
                business_registration_identifier: "EIN",
                business_registration_number: business.ein,
                business_identity: "direct_customer",
                business_industry: business.industry || "PROFESSIONAL_SERVICES",
                business_regions_of_operation: business.regionsOfOperation || "USA",
                website_url: business.website,
              },
            });
            businessEndUserSid = eu.sid;
            await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: eu.sid });
          } catch (assignErr) {
            console.warn("[a2p/register] business end user attach failed:", (assignErr as Error)?.message);
          }

          try {
            const rep = await c.trusthub.v1.endUsers.create({
              friendlyName: `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || "Authorized Rep",
              type: "authorized_representative_1",
              attributes: {
                first_name: contact.firstName,
                last_name: contact.lastName,
                email: contact.email,
                phone_number: contact.phone,
                business_title: contact.jobTitle || "Owner",
                job_position: "Director",
              },
            });
            repEndUserSid = rep.sid;
            await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: rep.sid });
          } catch (repErr) {
            console.warn("[a2p/register] rep attach failed:", (repErr as Error)?.message);
          }

          if (address.street && address.city && address.region && address.postalCode) {
            try {
              const addr = await c.addresses.create({
                customerName: business.legalName!,
                street: address.street,
                city: address.city,
                region: address.region,
                postalCode: address.postalCode,
                isoCountry: address.isoCountry || "US",
              });
              addressSid = addr.sid;
              await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: addr.sid });
            } catch (addrErr) {
              console.warn("[a2p/register] address attach failed:", (addrErr as Error)?.message);
            }
          }

          try {
            await c.trusthub.v1.customerProfiles(cp.sid).update({ status: "pending-review" });
            submitted = true;
          } catch (subErr) {
            console.warn("[a2p/register] cp submit failed:", (subErr as Error)?.message);
          }
        }

        result.customerProfile = {
          ok: true,
          sid: cp.sid,
          reused: customerProfileReused,
          note: customerProfileReused
            ? "Reusing existing customer profile bundle from a previous submission."
            : submitted
              ? "Customer profile bundle submitted for Twilio review."
              : "Customer profile bundle created. Finish review submission in Twilio Console.",
        };
      } catch (cpErr) {
        result.customerProfile = { ok: false, error: (cpErr as Error)?.message || "customer profile create failed" };
      }

      // ---- Step 1b: A2P Trust Product bundle -------------------------------
      // Same idempotent pattern as the customer profile: look up an existing
      // A2P Messaging Trust Product bundle by friendly name + policy SID and
      // reuse it. Only create + attach + submit when none exists.
      const tpFriendlyName = `${business.legalName} A2P Trust Product`;
      let a2pTrustProductSid: string | null = null;
      let a2pTrustProductReused = false;
      try {
        let tp: SidObject | null = null;
        try {
          const existing = await c.trusthub.v1.trustProducts.list({ limit: 100 });
          const match = existing.find(
            (b) => b.policySid === A2P_TRUST_PRODUCT_POLICY_SID && b.friendlyName === tpFriendlyName,
          );
          if (match) {
            tp = { sid: match.sid };
            a2pTrustProductReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] trustProducts.list failed:", (listErr as Error)?.message);
        }
        if (!tp) {
          tp = await c.trusthub.v1.trustProducts.create({
            friendlyName: tpFriendlyName,
            email: contact.email!,
            policySid: A2P_TRUST_PRODUCT_POLICY_SID,
          });
        }
        a2pTrustProductSid = tp.sid;

        if (!a2pTrustProductReused) {
          for (const objectSid of [businessEndUserSid, repEndUserSid, addressSid, customerProfileSid].filter(
            (s): s is string => !!s,
          )) {
            try {
              await c.trusthub.v1.trustProducts(tp.sid).trustProductsEntityAssignments.create({ objectSid });
            } catch (attachErr) {
              console.warn("[a2p/register] tp attach failed for", objectSid, (attachErr as Error)?.message);
            }
          }

          try {
            await c.trusthub.v1.trustProducts(tp.sid).update({ status: "pending-review" });
          } catch (subErr) {
            console.warn("[a2p/register] tp submit failed:", (subErr as Error)?.message);
          }
        }
      } catch (tpErr) {
        console.warn("[a2p/register] trust product create failed:", (tpErr as Error)?.message);
      }

      // ---- Step 2: Brand registration --------------------------------------
      // Discover an existing brand registration matching our two bundle SIDs
      // before attempting to create one. Brand creation only succeeds after
      // both bundles are approved (1–3 weeks); reusing the existing brand on
      // re-run lets Step 4 (campaign) finally go through without piling up
      // duplicates.
      if (customerProfileSid && a2pTrustProductSid) {
        let brandReused = false;
        let brandSid: string | null = null;
        let brandStatus: string | undefined;
        try {
          const existingBrands = await c.messaging.v1.brandRegistrations.list({ limit: 100 });
          const match = existingBrands.find(
            (b) =>
              b.customerProfileBundleSid === customerProfileSid &&
              b.a2pProfileBundleSid === a2pTrustProductSid,
          );
          if (match) {
            brandSid = match.sid;
            brandStatus = match.status;
            brandReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] brandRegistrations.list failed:", (listErr as Error)?.message);
        }

        if (brandSid) {
          // Reuse — surface the upstream status (APPROVED / PENDING / FAILED).
          // When the brand exists but isn't approved, we still want to expose
          // its SID to the UI without lying about success, so we report
          // ok:true with a status note for APPROVED and ok:false with a
          // "still in review" error otherwise. Step 4 keys off ok:true.
          if (brandStatus === "APPROVED") {
            result.brand = {
              ok: true,
              sid: brandSid,
              reused: true,
              note: "Reusing existing approved brand registration.",
            };
          } else {
            result.brand = {
              ok: false,
              error: `Reusing existing brand ${brandSid} — status is ${brandStatus || "unknown"}. Campaign will be attempted on re-run after Twilio approves the brand.`,
              skipped: true,
            };
          }
        } else {
          try {
            const brand = await c.messaging.v1.brandRegistrations.create({
              customerProfileBundleSid: customerProfileSid,
              a2PProfileBundleSid: a2pTrustProductSid,
              brandType: campaign.brandType || "STANDARD",
            });
            result.brand = { ok: true, sid: brand.sid, reused: false, note: "Brand registration submitted." };
          } catch (brandErr) {
            result.brand = {
              ok: false,
              error: (brandErr as Error)?.message || "brandRegistrations.create failed",
              skipped: false,
            };
          }
        }
      } else {
        result.brand = {
          ok: false,
          error: !customerProfileSid
            ? "Skipped: customer profile bundle was not created."
            : "Skipped: A2P trust product bundle was not created.",
          skipped: true,
        };
      }

      // ---- Step 3: Messaging Service ---------------------------------------
      // Idempotent reuse: discover existing service by friendly name before
      // creating a new one. Independent of brand status — owner needs the
      // service available regardless.
      const svcFriendlyName = `${business.legalName} A2P`;
      let messagingServiceSid: string | null = null;
      let messagingServiceReused = false;
      try {
        try {
          const existingServices = await c.messaging.v1.services.list({ limit: 100 });
          const match = existingServices.find((s) => s.friendlyName === svcFriendlyName);
          if (match) {
            messagingServiceSid = match.sid;
            messagingServiceReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] services.list failed:", (listErr as Error)?.message);
        }
        if (!messagingServiceSid) {
          const svc = await c.messaging.v1.services.create({ friendlyName: svcFriendlyName });
          messagingServiceSid = svc.sid;
        }
        result.messagingService = {
          ok: true,
          sid: messagingServiceSid,
          reused: messagingServiceReused,
          note: messagingServiceReused ? "Reusing existing messaging service." : undefined,
        };
      } catch (svcErr) {
        result.messagingService = { ok: false, error: (svcErr as Error)?.message || "messagingService create failed" };
      }

      // ---- Step 3b: attach the configured From number ----------------------
      // Carriers only enforce A2P rules on traffic sent through a Messaging
      // Service tied to an approved campaign — so the number must live on
      // the service or outbound texts keep hitting 30034 even after approval.
      if (messagingServiceSid) {
        try {
          const { getTwilioFromPhoneNumberSid, getTwilioFromPhoneNumber, listTwilioSmsNumbers } = await import("../twilio");
          const requestedSid = (body.phoneNumberSid || "").trim();
          const phoneNumberSid = requestedSid || (await getTwilioFromPhoneNumberSid());
          if (!phoneNumberSid) {
            result.phoneNumber = {
              ok: false,
              skipped: true,
              error: "Skipped: no Twilio phone number configured to attach.",
            };
          } else {
            // Re-check current attachments so re-runs don't error with
            // "phone number already in service".
            let existingAttachmentSid: string | null = null;
            let existingPhoneNumber: string | undefined;
            try {
              const attached = await c.messaging.v1.services(messagingServiceSid).phoneNumbers.list({ limit: 100 });
              const match = attached.find((p) => p.phoneNumberSid === phoneNumberSid || p.sid === phoneNumberSid);
              if (match) {
                existingAttachmentSid = match.sid;
                existingPhoneNumber = match.phoneNumber;
              }
            } catch (listErr) {
              console.warn("[a2p/register] service phoneNumbers.list failed:", (listErr as Error)?.message);
            }
            // Resolve the E.164 string for *this specific* SID so the result
            // panel doesn't misreport when the owner picked a number other
            // than the default configured one.
            const resolvePhoneNumberFor = async (sid: string): Promise<string | undefined> => {
              try {
                const all = await listTwilioSmsNumbers();
                const hit = all.find((n) => n.sid === sid);
                if (hit) return hit.phoneNumber;
              } catch { /* fall through */ }
              return (await getTwilioFromPhoneNumber()) || undefined;
            };
            if (existingAttachmentSid) {
              result.phoneNumber = {
                ok: true,
                sid: existingAttachmentSid,
                reused: true,
                phoneNumber: existingPhoneNumber || (await resolvePhoneNumberFor(phoneNumberSid)),
                note: "Phone number already attached to this messaging service.",
              };
            } else {
              const attached = await c.messaging.v1.services(messagingServiceSid).phoneNumbers.create({ phoneNumberSid });
              result.phoneNumber = {
                ok: true,
                sid: attached.sid,
                phoneNumber: await resolvePhoneNumberFor(phoneNumberSid),
              };
            }
          }
        } catch (attachErr) {
          result.phoneNumber = {
            ok: false,
            error: (attachErr as Error)?.message || "phoneNumbers.create failed",
          };
        }
      } else {
        result.phoneNumber = {
          ok: false,
          skipped: true,
          error: "Skipped: messaging service was not created.",
        };
      }

      // ---- Step 4: us_app_to_person campaign -------------------------------
      // Requires brand SID (APPROVED) + a messaging service SID. Re-uses an
      // existing campaign on the service when present so re-runs don't
      // duplicate. Only attempts creation when brand registration is
      // ok:true (i.e. approved or freshly created — Twilio itself rejects
      // campaign create when the brand isn't approved yet).
      if (messagingServiceSid && result.brand?.ok && "sid" in result.brand && result.brand.sid) {
        const brandSid = result.brand.sid;
        try {
          let existingCampaignSid: string | null = null;
          let existingCampaignStatus: string | undefined;
          try {
            const existing = await c.messaging.v1.services(messagingServiceSid).usAppToPerson.list({ limit: 10 });
            const match = existing.find((u) => u.brandRegistrationSid === brandSid);
            if (match) {
              existingCampaignSid = match.sid;
              existingCampaignStatus = match.campaignStatus;
            }
          } catch (listErr) {
            console.warn("[a2p/register] usAppToPerson.list failed:", (listErr as Error)?.message);
          }

          if (existingCampaignSid && existingCampaignStatus?.toUpperCase() === "FAILED") {
            try {
              const updated = await c.messaging.v1
                .services(messagingServiceSid)
                .usAppToPerson(existingCampaignSid)
                .update({
                  hasEmbeddedLinks: !!campaign.hasEmbeddedLinks,
                  hasEmbeddedPhone: !!campaign.hasEmbeddedPhone,
                  messageSamples: (campaign.messageSamples || []).filter(Boolean),
                  messageFlow: campaign.messageFlow!,
                  optInMessage: campaign.optInMessage,
                  optInKeywords: (campaign.optInKeywords || []).filter(Boolean),
                  description: campaign.description!,
                  ageGated: false,
                  directLending: false,
                });
              result.campaign = {
                ok: true,
                sid: updated.sid,
                reused: true,
                note: "Updated the rejected campaign with the revised CTA and resubmitted it for review.",
              };
            } catch (updateErr) {
              result.campaign = {
                ok: false,
                error: (updateErr as Error)?.message || "Failed to update the rejected campaign.",
              };
            }
          } else if (existingCampaignSid) {
            result.campaign = {
              ok: true,
              sid: existingCampaignSid,
              reused: true,
              note: "Reusing existing campaign on this messaging service.",
            };
          } else {
            const usaps = await c.messaging.v1.services(messagingServiceSid).usAppToPerson.create({
              brandRegistrationSid: brandSid,
              description: campaign.description!,
              messageSamples: (campaign.messageSamples || []).filter(Boolean),
              usAppToPersonUsecase: campaign.usAppToPersonUsecase!,
              hasEmbeddedLinks: !!campaign.hasEmbeddedLinks,
              hasEmbeddedPhone: !!campaign.hasEmbeddedPhone,
              messageFlow: campaign.messageFlow!,
              optInMessage: campaign.optInMessage,
              optInKeywords: (campaign.optInKeywords || []).filter(Boolean),
            });
            result.campaign = { ok: true, sid: usaps.sid, reused: false };
          }
        } catch (capErr) {
          result.campaign = { ok: false, error: (capErr as Error)?.message || "usAppToPerson.create failed" };
        }
      } else {
        result.campaign = {
          ok: false,
          skipped: true,
          error: !messagingServiceSid
            ? "Skipped: messaging service was not created."
            : "Skipped: brand registration is not yet approved. Re-run the wizard once Twilio approves the brand to submit the campaign.",
        };
      }

      // Persist the submitted body so the Messages page "Fix and resubmit"
      // action can pre-fill the wizard with what the owner sent last time,
      // instead of forcing them to retype everything after a rejection.
      try {
        await setAppState(A2P_LAST_SUBMISSION_KEY, { savedAt: new Date().toISOString(), body });
      } catch (persistErr) {
        console.warn("[a2p/register] failed to persist last submission:", (persistErr as Error)?.message);
      }

      // Kick the background monitor so any change Twilio reports is
      // pushed to the Messages page banner over SSE within seconds, plus
      // a short burst of follow-ups since Twilio reviews can land a few
      // minutes after a resubmit. The monitor de-dupes by fingerprint, so
      // a no-change cycle won't spam connected clients.
      try {
        const { runA2PMonitorOnce } = await import("../a2p-monitor");
        const kick = (delayMs: number) => {
          setTimeout(() => {
            runA2PMonitorOnce().catch((e) =>
              console.warn("[a2p/register] post-submit monitor run failed:", (e as Error)?.message),
            );
          }, delayMs).unref?.();
        };
        kick(0);
        kick(30_000);
        kick(2 * 60_000);
        kick(5 * 60_000);
      } catch (kickErr) {
        console.warn("[a2p/register] could not schedule post-submit monitor runs:", (kickErr as Error)?.message);
      }

      res.json(result);
    } catch (err: any) {
      console.error("[a2p/register] failed:", err);
      res.status(500).json({ error: err?.message || "registration failed", ...result });
    }
  });

  // Returns the most recent A2P registration submission so the wizard can
  // pre-fill itself for "Fix and resubmit". 404 when nothing has been
  // submitted yet — caller falls back to empty defaults.
  app.get("/api/twilio/a2p/prefill", async (_req, res) => {
    try {
      const parsed = await getAppStateWithLegacyFile<{ savedAt?: string; body?: unknown }>(
        A2P_LAST_SUBMISSION_KEY,
        "a2p-last-submission.json",
      );
      if (!parsed?.body) {
        res.status(404).json({ error: "no prior submission" });
        return;
      }
      res.json({ savedAt: parsed.savedAt || null, body: parsed.body });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "failed to read prefill" });
    }
  });
}
