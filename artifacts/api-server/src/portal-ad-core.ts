import { z } from "zod/v4";

// Pure rules for portal popup ads (no database), shared by the routes and tests.

export const AD_DELAY_MAX_SECONDS = 120;
/** 0 = hidden for the rest of the browser session only. Max one year. */
export const AD_SUPPRESS_MAX_HOURS = 24 * 365;
export const AD_EVENT_TYPES = ["impression", "dismiss", "click"] as const;
export type AdEventType = (typeof AD_EVENT_TYPES)[number];

/**
 * Links may go to another portal page ("/portal/referrals") or a web page
 * (http/https). Anything else (javascript:, data:, mailto: …) is rejected.
 */
export function safeAdLink(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw.slice(0, 500);
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

const optionalDate = z
  .union([z.iso.datetime({ offset: true }), z.literal(""), z.null()])
  .optional()
  .transform((value) => (value ? new Date(value) : null));

export const adInputSchema = z
  .object({
    title: z.string().trim().min(1, "Add a headline").max(120),
    body: z.string().trim().max(1000).default(""),
    imageAlt: z.string().trim().max(200).default(""),
    linkUrl: z.string().trim().max(500).optional().nullable(),
    linkLabel: z.string().trim().max(60).optional().nullable(),
    isActive: z.boolean().default(true),
    startsAt: optionalDate,
    endsAt: optionalDate,
    priority: z.number().int().min(0).max(100).default(0),
    delaySeconds: z.number().int().min(0).max(AD_DELAY_MAX_SECONDS).default(3),
    suppressHours: z.number().int().min(0).max(AD_SUPPRESS_MAX_HOURS).default(24),
    imageBase64: z.string().max(1_500_000).optional(),
    removeImage: z.boolean().optional(),
  })
  .strict()
  .superRefine((ad, ctx) => {
    if (ad.linkUrl && !safeAdLink(ad.linkUrl)) {
      ctx.addIssue({ code: "custom", path: ["linkUrl"], message: "Use a web address (https://…) or a portal page (/portal/…)" });
    }
    if (ad.startsAt && ad.endsAt && ad.endsAt <= ad.startsAt) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end date must be after the start date" });
    }
  });

export type AdInput = z.infer<typeof adInputSchema>;

/** Whether an ad should be offered to customers right now. */
export function isAdLive(
  ad: { isActive: boolean; startsAt: Date | null; endsAt: Date | null },
  now = new Date(),
): boolean {
  if (!ad.isActive) return false;
  if (ad.startsAt && ad.startsAt > now) return false;
  if (ad.endsAt && ad.endsAt <= now) return false;
  return true;
}

/** "scheduled" / "live" / "ended" / "off", for the staff list. */
export function adState(
  ad: { isActive: boolean; startsAt: Date | null; endsAt: Date | null },
  now = new Date(),
): "live" | "scheduled" | "ended" | "off" {
  if (!ad.isActive) return "off";
  if (ad.endsAt && ad.endsAt <= now) return "ended";
  if (ad.startsAt && ad.startsAt > now) return "scheduled";
  return "live";
}
