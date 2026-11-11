/**
 * Types and small pure helpers for the Sales Agents hub (/sales). Shapes mirror
 * the server modules lead-gen-agent.ts, speed-to-lead.ts and lead-research.ts.
 */

export type LeadGenStatus = { configured: boolean; webSearch: boolean };

export type LeadGenRun = {
  id: number;
  target: string;
  location: string;
  maxResults: number;
  status: "running" | "completed" | "failed";
  error: string | null;
  summary: string | null;
  prospectCount: number;
  createdAt: string;
  finishedAt: string | null;
};

export type Prospect = {
  id: number;
  runId: number;
  businessName: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  industry: string | null;
  employeeEstimate: string | null;
  fitScore: number;
  fitReasons: string;
  suggestedServices: string;
  openingLine: string;
  sources: string[];
  status: "new" | "imported" | "dismissed";
  contactId: number | null;
  leadId: number | null;
  createdAt: string;
};

export type SpeedToLeadSettings = {
  enabled: boolean;
  enabledAt: string | null;
  autoTextEnabled: boolean;
  autoTextTemplate: string;
  targetMinutes: number;
  escalateSlack: boolean;
  escalationPhones: string[];
  businessHoursOnly: boolean;
  businessStartHour: number;
  businessEndHour: number;
  businessDays: number[];
  timezone: string;
  excludedSources: string[];
  updatedAt: string | null;
};

export type SpeedToLeadLead = {
  leadId: number;
  contactId: number | null;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  serviceType: string | null;
  source: string | null;
  leadStatus: string;
  leadCreatedAt: string;
  waitingMinutes: number | null;
  responseMinutes: number | null;
  overdue: boolean;
  autoTextStatus: "pending" | "sending" | "sent" | "skipped" | "failed";
  autoTextDetail: string | null;
  firstContactAt: string | null;
  firstContactBy: string | null;
  firstContactKind: string | null;
  escalatedAt: string | null;
};

export type SpeedToLeadMetrics = {
  total: number;
  contacted: number;
  waiting: number;
  medianMinutes: number | null;
  withinTargetPct: number | null;
  autoTextsSent: number;
  escalations: number;
};

export type SpeedToLeadData = {
  settings: SpeedToLeadSettings;
  leads: SpeedToLeadLead[];
  metrics: SpeedToLeadMetrics;
  twilioConfigured: boolean;
  preview: string;
};

export type CopilotLeadRow = {
  id: number;
  name: string;
  company: string | null;
  serviceType: string | null;
  status: string;
  source: string | null;
  createdAt: string;
  briefStatus: "running" | "completed" | "failed" | null;
  briefAt: string | null;
};

export type LeadBrief = {
  headline: string;
  summary: string;
  customerType: string;
  companyProfile: Partial<Record<"name" | "industry" | "size" | "website" | "location" | "notes", string | null>>;
  needs: string[];
  recommendedServices: { service: string; why: string }[];
  talkingPoints: string[];
  discoveryQuestions: string[];
  objections: { objection: string; response: string }[];
  risks: string[];
  nextBestAction: { action: string; timing: string; channel: string };
  leadScore: number;
  draftEmail: { subject: string; body: string };
  draftText: string;
};

export type BriefRecord = {
  id: number;
  leadId: number;
  status: "running" | "completed" | "failed";
  brief: LeadBrief | null;
  sources: string[];
  grounded: boolean;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type CopilotLeadDetail = {
  lead: {
    id: number;
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    contactId: number | null;
    serviceType: string | null;
    status: string;
    source: string | null;
    problem: string | null;
    createdAt: string | null;
  };
  brief: BriefRecord | null;
};

/** Client-side mirror of the server's renderAutoText, for the live preview. */
export function renderAutoTextPreview(
  template: string,
  values: { firstName?: string; service?: string; company?: string } = { firstName: "Maria", service: "Computer Repair", company: "" },
): string {
  let out = template;
  const fallbacks = { firstName: "there", service: "your request", company: "" } as const;
  for (const token of ["firstName", "service", "company"] as const) {
    out = out.split(`{${token}}`).join((values[token] ?? "").trim() || fallbacks[token]);
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/ ([,.!?])/g, "$1").trim();
}

export function minutesLabel(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  if (minutes < 60) return `${Math.round(minutes * 10) / 10} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fitScoreTone(score: number): string {
  if (score >= 75) return "bg-green-100 text-green-800 border-green-200";
  if (score >= 50) return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-gray-100 text-gray-700 border-gray-200";
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.replace(/^\d{3}:\s*/, "") || "Something went wrong.";
}
