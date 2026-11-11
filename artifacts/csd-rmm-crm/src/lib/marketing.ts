/**
 * Marketing department logic — pure functions only (no React, no `@/` imports)
 * so `node --test` can run them directly. The Marketing hub
 * (`pages/marketing.tsx`) feeds these from data the CRM already collects:
 *   - `crm_leads.source` / `.campaign`
 *   - `csd_intake_records.source` / `.campaign`
 *   - call-tracking analytics (`tracking_numbers.source_channel` / `.campaign_name`)
 *   - `crm_jobs.lead_id` for revenue that came from a lead
 */

export type DateLike = string | Date | null | undefined;

export type MarketingLead = {
  id: number;
  source: string | null;
  campaign: string | null;
  intakeRecordId?: number | null;
  status: string;
  estimatedValue: number | null;
  createdAt: DateLike;
};

export type MarketingIntake = {
  id?: number;
  howDidYouHear?: string | null;
  source: string | null;
  campaign: string | null;
  createdAt: DateLike;
};

export type MarketingJob = {
  leadId: number | null;
  status: string;
  finalAmount: number | null;
  estimatedAmount: number | null;
};

export type ChannelCalls = { sourceChannel: string | null; totalCalls: number; uniqueCallers: number };

export type NumberCalls = {
  campaignName: string | null;
  sourceChannel: string | null;
  phoneNumber: string | null;
  totalCalls: number;
  uniqueCallers: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function since<T extends { createdAt: DateLike }>(items: T[], days: number, now = new Date()): T[] {
  const cutoff = now.getTime() - days * DAY_MS;
  return items.filter((item) => {
    if (!item.createdAt) return false;
    const at = new Date(item.createdAt).getTime();
    return !Number.isNaN(at) && at >= cutoff && at <= now.getTime();
  });
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const CHANNEL_ALIASES: [RegExp, string][] = [
  [/^(website[ _-]?intake([ _-]?form)?|web|website|intake)$/, "Website"],
  [/^(google[ _-]?search|google|organic|seo)$/, "Google Search"],
  [/^(existing[ _-]?customer|repeat[ _-]?customer|returning)$/, "Existing Customer"],
  [/^(flyer\/advertisement|advertisement|ad|ads)$/, "Flyers & Ads"],
  [/^(yellow[ _-]?pages)$/, "Yellow Pages"],
  [/^(other)$/, "Other"],
  [/^(phone[ _-]?call|phone|phone[ _-]?link|call|calls|inbound[ _-]?call)$/, "Phone"],
  [/^(google[ _-]?(ads|ppc|cpc)|ppc|cpc|adwords|paid[ _-]?search)$/, "Google Ads"],
  [/^(google[ _-]?(business|maps|gbp|my[ _-]?business)|gbp|gmb|maps)$/, "Google Business"],
  [/^(facebook|fb|instagram|ig|meta|social|social[ _-]?media)$/, "Social Media"],
  [/^(referral|referred|referral[ _-]?from[ _-]?friend\/family|word[ _-]?of[ _-]?mouth)$/, "Referral"],
  [/^(yelp)$/, "Yelp"],
  [/^(nextdoor)$/, "Nextdoor"],
  [/^(email|newsletter)$/, "Email"],
  [/^(direct[ _-]?mail|mailer|postcard|flyer|print)$/, "Direct Mail"],
  [/^(portal|customer[ _-]?portal)$/, "Customer Portal"],
  [/^(marketplace)$/, "Marketplace"],
  [/^(voice[ _-]?intake)$/, "Voice Intake"],
  [/^(unattributed|unknown|none|direct|null|unconfigured)$/, "Unattributed"],
];

/** Collapses the many spellings of a lead source into one channel label. */
export function channelLabel(raw: string | null | undefined): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "Unattributed";
  for (const [pattern, label] of CHANNEL_ALIASES) {
    if (pattern.test(value)) return label;
  }
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Values `buildIntakeAttribution` writes to `crm_leads.source` — the path the
// request arrived by, not the marketing channel.
const ARRIVAL_SOURCES = new Set(["website_intake", "phone_call"]);
const VOICE_INTAKE_TAG = "voice_intake";

/** The marketing channel a lead came from (see the note at the top of this file). */
export function leadChannel(lead: Pick<MarketingLead, "source" | "campaign">): string {
  if (lead.source && ARRIVAL_SOURCES.has(lead.source) && lead.campaign?.trim()) return channelLabel(lead.campaign);
  return channelLabel(lead.source);
}

export function intakeChannel(intake: MarketingIntake): string {
  return channelLabel(intake.howDidYouHear?.trim() || intake.source);
}

/** The campaign an intake was tagged with, ignoring the internal voice-intake marker. */
export function intakeCampaign(intake: MarketingIntake): string | null {
  const campaign = intake.campaign?.trim();
  return campaign && campaign !== VOICE_INTAKE_TAG ? campaign : null;
}

/** A lead's campaign: the UTM campaign of its intake, or the campaign typed on a manually entered lead. */
export function leadCampaign(lead: MarketingLead, intakeCampaigns: Map<number, string>): string | null {
  if (lead.intakeRecordId != null) {
    const fromIntake = intakeCampaigns.get(lead.intakeRecordId);
    if (fromIntake) return fromIntake;
  }
  if (lead.source && ARRIVAL_SOURCES.has(lead.source)) return null;
  return lead.campaign?.trim() || null;
}

function intakeCampaignIndex(intakes: MarketingIntake[]): Map<number, string> {
  const index = new Map<number, string>();
  for (const intake of intakes) {
    const campaign = intakeCampaign(intake);
    if (intake.id != null && campaign) index.set(intake.id, campaign);
  }
  return index;
}

export type AttributionRow = {
  channel: string;
  leads: number;
  won: number;
  /** Won ÷ leads, 0–1. Null when the channel produced no leads. */
  winRate: number | null;
  /** Estimated value of leads still open (not won or lost). */
  pipelineValue: number;
  /** Completed-job revenue traced back to a lead from this channel. */
  revenue: number;
  intakes: number;
  calls: number;
  uniqueCallers: number;
  /** Every touch the channel produced: leads + service requests + calls. */
  touches: number;
};

const CLOSED_LEAD_STATUSES = new Set(["won", "lost"]);

export function buildAttribution({
  leads,
  intakes,
  calls,
  jobs,
}: {
  leads: MarketingLead[];
  intakes: MarketingIntake[];
  calls: ChannelCalls[];
  jobs: MarketingJob[];
}): AttributionRow[] {
  const rows = new Map<string, AttributionRow>();
  const row = (channel: string) => {
    let existing = rows.get(channel);
    if (!existing) {
      existing = { channel, leads: 0, won: 0, winRate: null, pipelineValue: 0, revenue: 0, intakes: 0, calls: 0, uniqueCallers: 0, touches: 0 };
      rows.set(channel, existing);
    }
    return existing;
  };

  const channelByLead = new Map<number, string>();
  for (const lead of leads) {
    const channel = leadChannel(lead);
    channelByLead.set(lead.id, channel);
    const r = row(channel);
    r.leads += 1;
    if (lead.status === "won") r.won += 1;
    if (!CLOSED_LEAD_STATUSES.has(lead.status)) r.pipelineValue += lead.estimatedValue ?? 0;
  }
  for (const job of jobs) {
    if (job.status !== "completed" || job.leadId == null) continue;
    const channel = channelByLead.get(job.leadId);
    if (channel) row(channel).revenue += job.finalAmount ?? job.estimatedAmount ?? 0;
  }
  for (const intake of intakes) row(intakeChannel(intake)).intakes += 1;
  for (const call of calls) {
    const r = row(channelLabel(call.sourceChannel));
    r.calls += call.totalCalls;
    r.uniqueCallers += call.uniqueCallers;
  }

  return [...rows.values()]
    .map((r) => ({ ...r, winRate: r.leads ? r.won / r.leads : null, touches: r.leads + r.intakes + r.calls }))
    .sort((a, b) => b.touches - a.touches || b.revenue - a.revenue || a.channel.localeCompare(b.channel));
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export const FUNNEL_STAGES = [
  { id: "new", label: "New" },
  { id: "contacted", label: "Contacted" },
  { id: "qualified", label: "Qualified" },
  { id: "quoted", label: "Quoted" },
  { id: "won", label: "Won" },
] as const;

export type FunnelStage = { id: string; label: string; reached: number; rate: number };

/**
 * How many leads reached each stage. A lead counts toward its current stage
 * and every stage before it; lost leads only count as "New" because the
 * stage they were lost at isn't recorded.
 */
export function leadFunnel(leads: MarketingLead[]): { stages: FunnelStage[]; lost: number } {
  const order: Record<string, number> = Object.fromEntries(FUNNEL_STAGES.map((stage, i) => [stage.id, i]));
  const reached = FUNNEL_STAGES.map(() => 0);
  let lost = 0;
  for (const lead of leads) {
    if (lead.status === "lost") lost += 1;
    const depth = order[lead.status] ?? 0;
    for (let i = 0; i <= depth; i++) reached[i] += 1;
  }
  const top = reached[0] || 0;
  return {
    stages: FUNNEL_STAGES.map((stage, i) => ({ id: stage.id, label: stage.label, reached: reached[i], rate: top ? reached[i] / top : 0 })),
    lost,
  };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export type CampaignRow = {
  campaign: string;
  channels: string[];
  leads: number;
  won: number;
  pipelineValue: number;
  intakes: number;
  calls: number;
  trackingNumbers: string[];
};

/**
 * Groups leads, service requests and tracked calls by campaign name
 * (case- and spacing-insensitive). Pass every intake the leads may link to, so a lead
 * inherits its intake's UTM campaign.
 */
export function campaignPerformance({
  leads,
  intakes,
  numbers,
}: {
  leads: MarketingLead[];
  intakes: MarketingIntake[];
  numbers: NumberCalls[];
}): CampaignRow[] {
  const rows = new Map<string, CampaignRow & { channelSet: Set<string> }>();
  const row = (name: string | null) => {
    const label = name?.trim();
    if (!label) return null;
    // Same normalization as tracked links, so "Fall Promo" on a tracking
    // number and utm_campaign=fall-promo are one campaign.
    const key = utmValue(label);
    let existing = rows.get(key);
    if (!existing) {
      existing = { campaign: label, channels: [], channelSet: new Set(), leads: 0, won: 0, pipelineValue: 0, intakes: 0, calls: 0, trackingNumbers: [] };
      rows.set(key, existing);
    } else if (label !== key && existing.campaign === key) {
      existing.campaign = label; // prefer the human-typed name for display
    }
    return existing;
  };

  const intakeCampaigns = intakeCampaignIndex(intakes);
  for (const lead of leads) {
    const r = row(leadCampaign(lead, intakeCampaigns));
    if (!r) continue;
    r.leads += 1;
    if (lead.status === "won") r.won += 1;
    if (!CLOSED_LEAD_STATUSES.has(lead.status)) r.pipelineValue += lead.estimatedValue ?? 0;
    r.channelSet.add(leadChannel(lead));
  }
  for (const intake of intakes) {
    const r = row(intakeCampaign(intake));
    if (!r) continue;
    r.intakes += 1;
    r.channelSet.add(intakeChannel(intake));
  }
  for (const number of numbers) {
    const r = row(number.campaignName);
    if (!r) continue;
    r.calls += number.totalCalls;
    if (number.phoneNumber) r.trackingNumbers.push(number.phoneNumber);
    if (number.sourceChannel) r.channelSet.add(channelLabel(number.sourceChannel));
  }

  return [...rows.values()]
    .map(({ channelSet, ...r }) => ({ ...r, channels: [...channelSet].sort() }))
    .sort((a, b) => b.leads + b.intakes + b.calls - (a.leads + a.intakes + a.calls) || a.campaign.localeCompare(b.campaign));
}

// ---------------------------------------------------------------------------
// Daily trend
// ---------------------------------------------------------------------------

export type TrendPoint = { day: string; leads: number; intakes: number; calls: number };

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** One point per local calendar day for the last `days` days, oldest first. */
export function dailyTrend({
  leads,
  intakes,
  callsByDay,
  days,
  now = new Date(),
}: {
  leads: { createdAt: DateLike }[];
  intakes: { createdAt: DateLike }[];
  callsByDay: { day: string; count: number }[];
  days: number;
  now?: Date;
}): TrendPoint[] {
  const points = new Map<string, TrendPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKey(date);
    points.set(key, { day: key, leads: 0, intakes: 0, calls: 0 });
  }
  for (const lead of leads) {
    if (!lead.createdAt) continue;
    const point = points.get(dayKey(new Date(lead.createdAt)));
    if (point) point.leads += 1;
  }
  for (const intake of intakes) {
    if (!intake.createdAt) continue;
    const point = points.get(dayKey(new Date(intake.createdAt)));
    if (point) point.intakes += 1;
  }
  for (const entry of callsByDay) {
    const point = points.get(entry.day.slice(0, 10));
    if (point) point.calls += entry.count;
  }
  return [...points.values()];
}

// ---------------------------------------------------------------------------
// UTM link builder
// ---------------------------------------------------------------------------

export type UtmInput = {
  url: string;
  source: string;
  medium: string;
  campaign: string;
  term?: string;
  content?: string;
};

/** Lowercase, trimmed, spaces → dashes: keeps analytics reports from splitting "Spring Promo" and "spring promo". */
export function utmValue(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

export function buildUtmUrl(input: UtmInput): { url: string | null; error: string | null } {
  const raw = input.url.trim();
  if (!raw) return { url: null, error: "Enter the page URL to track." };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { url: null, error: "That doesn't look like a valid web address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { url: null, error: "Only http and https links can be tracked." };
  }
  const required: [keyof UtmInput, string][] = [["source", "Source"], ["medium", "Medium"], ["campaign", "Campaign"]];
  for (const [key, label] of required) {
    if (!utmValue(input[key])) return { url: null, error: `${label} is required.` };
  }
  const params: [string, string | undefined][] = [
    ["utm_source", input.source],
    ["utm_medium", input.medium],
    ["utm_campaign", input.campaign],
    ["utm_term", input.term],
    ["utm_content", input.content],
  ];
  for (const [key, value] of params) {
    const clean = utmValue(value);
    if (clean) url.searchParams.set(key, clean);
    else url.searchParams.delete(key);
  }
  return { url: url.toString(), error: null };
}

export const UTM_PRESETS: { id: string; label: string; source: string; medium: string }[] = [
  { id: "gbp", label: "Google Business post", source: "google", medium: "gbp" },
  { id: "facebook", label: "Facebook / Instagram", source: "facebook", medium: "social" },
  { id: "nextdoor", label: "Nextdoor", source: "nextdoor", medium: "social" },
  { id: "email", label: "Email newsletter", source: "newsletter", medium: "email" },
  { id: "sms", label: "Text message", source: "sms", medium: "sms" },
  { id: "flyer", label: "Flyer / QR code", source: "flyer", medium: "print" },
  { id: "google-ads", label: "Google Ads", source: "google", medium: "cpc" },
];

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type BrandKit = {
  business: string;
  phone: string;
  website: string;
  reviewLink: string;
  bookingLink: string;
  area: string;
};

export const DEFAULT_BRAND_KIT: BrandKit = {
  business: "Computer Systems Depot",
  phone: "954-637-7300",
  website: "https://support.computersystemsdepot.com",
  reviewLink: "",
  bookingLink: "https://support.computersystemsdepot.com/intake",
  area: "Lauderhill & South Florida",
};

/** Replaces `{{name}}` placeholders; unknown or empty values collapse to an empty string. */
export function fillTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => (vars[key] ?? "").trim())
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// GSM-7 basic set plus the extension table characters (which cost two septets).
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

/** SMS length and segment count, so staff can see when a text will be billed as several messages. */
export function smsSegments(text: string): { encoding: "GSM-7" | "UCS-2"; length: number; segments: number } {
  let septets = 0;
  let gsm = true;
  for (const char of text) {
    if (GSM_BASIC.includes(char)) septets += 1;
    else if (GSM_EXTENDED.includes(char)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    return { encoding: "GSM-7", length: septets, segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153) };
  }
  // UCS-2 counts UTF-16 code units (emoji take two).
  const units = text.length;
  return { encoding: "UCS-2", length: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

export type MessageTemplate = {
  id: string;
  label: string;
  channel: "sms" | "email" | "social";
  subject?: string;
  body: string;
};

export const REVIEW_TEMPLATES: MessageTemplate[] = [
  {
    id: "sms-thanks",
    label: "Text — thank you",
    channel: "sms",
    body: "Hi {{first}}, thanks for choosing {{business}} for your {{service}}! If we earned it, a quick review helps neighbors find us: {{reviewLink}} Reply STOP to opt out.",
  },
  {
    id: "sms-short",
    label: "Text — short",
    channel: "sms",
    body: "{{business}}: Hi {{first}}, how did we do? Leave a quick review: {{reviewLink}} Reply STOP to opt out.",
  },
  {
    id: "email",
    label: "Email — personal",
    channel: "email",
    subject: "How did we do, {{first}}?",
    body: "Hi {{first}},\n\nThank you for trusting {{business}} with your {{service}}. We hope everything is running smoothly.\n\nIf you have a minute, would you share how it went? Reviews help other people in {{area}} find honest tech help:\n{{reviewLink}}\n\nIf anything isn't right, just reply to this email or call {{phone}} and we'll make it right.\n\nThank you,\nThe {{business}} team",
  },
];

export type ContentIdea = {
  id: string;
  label: string;
  category: "Tip" | "Promotion" | "Safety" | "Social proof" | "Seasonal" | "Marketplace";
  body: string;
  hashtags: string[];
};

export const CONTENT_TEMPLATES: ContentIdea[] = [
  {
    id: "tip-backup",
    label: "Backup reminder",
    category: "Tip",
    body: "Quick tech tip: when was your last backup? 💾 Photos, tax files and business records can vanish with one failed drive. Set up an automatic backup today — or let {{business}} do it for you. Call {{phone}} or book online: {{link}}",
    hashtags: ["TechTip", "DataBackup", "ComputerRepair"],
  },
  {
    id: "tip-slow-pc",
    label: "Slow computer fixes",
    category: "Tip",
    body: "Is your computer crawling? 🐢 Three things to try: restart it (really!), uninstall programs you don't use, and check your free disk space. Still slow? {{business}} offers {{service}} in {{area}} — {{link}}",
    hashtags: ["SlowComputer", "PCRepair", "TechHelp"],
  },
  {
    id: "promo-offer",
    label: "Limited-time offer",
    category: "Promotion",
    body: "This week only at {{business}}: {{offer}} 🔧 Walk-ins welcome or book your spot: {{link}} 📞 {{phone}}",
    hashtags: ["LocalBusiness", "ComputerRepair", "Deal"],
  },
  {
    id: "safety-scam",
    label: "Scam alert",
    category: "Safety",
    body: "⚠️ Scam alert: Microsoft, Apple and your bank will never call to say your computer is infected — and never ask for gift cards or remote access out of the blue. Not sure? Hang up and call {{business}} at {{phone}}. Free scam-check guide: {{link}}",
    hashtags: ["ScamAlert", "CyberSecurity", "StaySafe"],
  },
  {
    id: "proof-before-after",
    label: "Before & after repair",
    category: "Social proof",
    body: "Before ➡️ after! This {{service}} came in today and left good as new. Thanks for trusting {{business}} — proudly serving {{area}} since 1996. {{link}}",
    hashtags: ["BeforeAndAfter", "RepairShop", "SmallBusiness"],
  },
  {
    id: "proof-review",
    label: "Share a 5-star review",
    category: "Social proof",
    body: "⭐⭐⭐⭐⭐ \"{{offer}}\" — thank you for the kind words! Reviews like this keep our small team going. Need help? {{phone}} · {{link}}",
    hashtags: ["CustomerLove", "Reviews", "ShopLocal"],
  },
  {
    id: "seasonal-school",
    label: "Back to school / tax season",
    category: "Seasonal",
    body: "Getting ready for the season? 📚 Have {{business}} tune up laptops, remove viruses and set up backups before the rush. {{offer}} Book now: {{link}}",
    hashtags: ["BackToSchool", "LaptopRepair", "TechTuneUp"],
  },
  {
    id: "marketplace",
    label: "Community marketplace",
    category: "Marketplace",
    body: "Buying or selling used tech? 🖥️ List it free on the {{business}} community marketplace — staff-verified listings and no seller account needed. {{link}}",
    hashtags: ["BuyLocal", "UsedTech", "Marketplace"],
  },
];

export const SOCIAL_LIMITS: { id: string; label: string; limit: number }[] = [
  { id: "x", label: "X", limit: 280 },
  { id: "gbp", label: "Google Business", limit: 1500 },
  { id: "instagram", label: "Instagram", limit: 2200 },
  { id: "facebook", label: "Facebook", limit: 63206 },
];

// ---------------------------------------------------------------------------
// Playbook
// ---------------------------------------------------------------------------

export type PlaybookTask = {
  id: string;
  cadence: "weekly" | "monthly";
  title: string;
  detail: string;
  href?: string;
  /** Staff feature the linked page requires. */
  feature?: string;
};

export const MARKETING_PLAYBOOK: PlaybookTask[] = [
  { id: "w-reviews", cadence: "weekly", title: "Request reviews from completed jobs", detail: "Send a review request to every customer whose job closed this week.", href: "/marketing/tools?tool=reviews", feature: "crm" },
  { id: "w-reply", cadence: "weekly", title: "Reply to every new online review", detail: "Thank happy customers by name; take unhappy ones offline with a phone number." },
  { id: "w-social", cadence: "weekly", title: "Publish two social posts", detail: "One tip or safety post plus one offer or before/after from the Content Studio.", href: "/marketing/tools?tool=content", feature: "crm" },
  { id: "w-leads", cadence: "weekly", title: "Follow up every new lead within one business day", detail: "Work the New column until it's empty.", href: "/crm/leads", feature: "crm" },
  { id: "w-missed", cadence: "weekly", title: "Call back missed calls", detail: "Missed calls are the most expensive lost leads.", href: "/comms", feature: "communications" },
  { id: "w-marketplace", cadence: "weekly", title: "Approve pending marketplace listings", detail: "Fresh listings keep the community page worth visiting.", href: "/marketplace", feature: "marketplace" },
  { id: "m-attribution", cadence: "monthly", title: "Review channel attribution", detail: "Shift time and budget toward the channels producing won jobs, not just calls.", href: "/marketing", feature: "crm" },
  { id: "m-tracking", cadence: "monthly", title: "Audit tracking numbers", detail: "Every ad, flyer and listing should use its own tracking number with a campaign name.", href: "/admin/call-tracking", feature: "communications" },
  { id: "m-gbp", cadence: "monthly", title: "Refresh Google Business Profile", detail: "New photos, current hours, and an offer post. Check name, address and phone match the website." },
  { id: "m-citations", cadence: "monthly", title: "Check directory listings", detail: "Yelp, Nextdoor, Apple Maps and Bing Places should show the same name, address and phone." },
  { id: "m-landing", cadence: "monthly", title: "Update landing page offers", detail: "Make sure seasonal offers on the public pages are still current.", href: "/local-service" },
  { id: "m-newsletter", cadence: "monthly", title: "Send a customer email", detail: "A short tip, one offer, and a link to book — only to customers who opted in.", href: "/comms/email", feature: "communications" },
];

/** Monday-based week key (e.g. `2026-W44`) for weekly checklist progress. */
export function weekKey(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
