import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { Loader2, Send, MessageSquare, Search, Plus, RefreshCw, User as UserIcon, ShieldCheck, ShieldAlert, ShieldQuestion, ExternalLink, AlertTriangle, CheckCircle2, XCircle, Circle, BellOff, History, Bot, Lightbulb, Inbox, Clock, Copy, Wand2, Check, Trash2, Download, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDistanceToNow, format } from "date-fns";
import type { SmsMessage } from "@shared/schema";
import { normalizeRejectionReason } from "@shared/schema";
import { matchA2pRejection, getA2pRejectionStrings, resolveA2pLocale, slugifyHintId, suggestPatternFromReason, buildA2pHintSnippet, buildA2pHintBatchSnippet, isA2pSuggestionExportEligible, type A2pLocale } from "@/lib/a2p-rejections";
import ComplianceNotice from "@/components/compliance-notice";
import { MAIN_LINE_DISPLAY, SharedInbox, threadKeyFor } from "@/components/communications/shared-inbox";

interface BulkRecipient {
  contactId: number;
  name: string;
  mobilePhone: string | null;
  eligible: boolean;
  reason: string | null;
}

interface BulkSendResult {
  sent: number;
  skipped: number;
  failed: number;
}

// Inline "what does this mean / how do I fix it" note rendered under a
// verbatim Twilio rejection reason when the text matches one of our curated
// patterns. Unmatched reasons render a small "Suggest a plain-English note"
// link so staff can capture proposed remediation copy for the curated KB.
// Tiny UI string table for the static labels around the localized hint.
// Kept inline so we don't pull in an i18n framework just for two strings.
import { subscribeA2PLive } from "@/lib/a2p-live";
const REJECTION_UI_STRINGS: Record<A2pLocale, { learnMore: string; suggest: string }> = {
  en: {
    learnMore: "Learn more",
    suggest: "Was this confusing? Suggest a plain-English note",
  },
  es: {
    learnMore: "Más información",
    suggest: "¿Te resultó confuso? Sugiere una nota en lenguaje sencillo",
  },
};

function useA2pLocale(): A2pLocale {
  const [locale, setLocale] = useState<A2pLocale>(() => resolveA2pLocale());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "preferredLanguage") setLocale(resolveA2pLocale());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return locale;
}

function RejectionHint({ reason }: { reason: string }) {
  const match = matchA2pRejection(reason);
  const locale = useA2pLocale();
  const ui = REJECTION_UI_STRINGS[locale] ?? REJECTION_UI_STRINGS.en;
  const [suggestOpen, setSuggestOpen] = useState(false);
  if (!match) {
    return (
      <>
        <button
          type="button"
          onClick={() => setSuggestOpen(true)}
          className="mt-1 inline-flex items-center gap-1 text-[11px] underline opacity-70 hover:opacity-100"
          data-testid="button-suggest-rejection-note"
        >
          <Lightbulb className="h-3 w-3" /> {ui.suggest}
        </button>
        <RejectionSuggestionDialog
          open={suggestOpen}
          onOpenChange={setSuggestOpen}
          reason={reason}
        />
      </>
    );
  }
  const { hint } = match;
  const strings = getA2pRejectionStrings(hint, locale);
  return (
    <div
      className="mt-1 rounded-md border border-current/20 bg-background/60 px-2 py-1.5 text-[11px] font-normal not-italic opacity-90"
      data-testid={`rejection-hint-${hint.id}`}
      lang={locale}
    >
      <div className="font-semibold">{strings.title}</div>
      <div className="mt-0.5 leading-snug">{strings.remediation}</div>
      <a
        href={hint.docUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-1 inline-flex items-center gap-1 underline"
      >
        {ui.learnMore} <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

// Dialog where staff capture a proposed plain-English note for an unmatched
// Twilio rejection reason. Posts to /api/twilio/a2p/rejection-suggestions.
function RejectionSuggestionDialog({
  open,
  onOpenChange,
  reason,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  reason: string;
}) {
  const { toast } = useToast();
  const [reasonText, setReasonText] = useState(reason);
  const [title, setTitle] = useState("");
  const [remediation, setRemediation] = useState("");
  const [docUrl, setDocUrl] = useState("");

  useEffect(() => {
    if (open) {
      setReasonText(reason);
      setTitle("");
      setRemediation("");
      setDocUrl("");
    }
  }, [open, reason]);

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/twilio/a2p/rejection-suggestions", {
        reasonText: reasonText.trim(),
        suggestedTitle: title.trim(),
        suggestedRemediation: remediation.trim(),
        docUrl: docUrl.trim() || undefined,
      });
      return (await res.json()) as { ok: boolean; id: number; duplicate?: boolean; message?: string };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/rejection-suggestions"] });
      toast(
        result?.duplicate
          ? {
              title: "Already reported",
              description:
                result.message || "Someone already flagged this rejection — it's waiting for review.",
            }
          : { title: "Thanks — suggestion sent to the team" },
      );
      onOpenChange(false);
    },
    onError: (e: any) =>
      toast({
        title: "Couldn't save suggestion",
        description: e?.message,
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-suggest-rejection">
        <DialogHeader>
          <DialogTitle>Suggest a plain-English note</DialogTitle>
          <DialogDescription>
            This rejection didn't match any of our curated notes. Capture what
            it really means so we can add it to the knowledge base.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="rs-reason">Verbatim rejection text</Label>
            <Textarea
              id="rs-reason"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              rows={3}
              data-testid="input-suggest-reason"
            />
          </div>
          <div>
            <Label htmlFor="rs-title">Short title</Label>
            <Input
              id="rs-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. EIN doesn't match IRS records"
              data-testid="input-suggest-title"
            />
          </div>
          <div>
            <Label htmlFor="rs-rem">Plain-English fix</Label>
            <Textarea
              id="rs-rem"
              value={remediation}
              onChange={(e) => setRemediation(e.target.value)}
              rows={4}
              placeholder="What should the owner actually do to fix this?"
              data-testid="input-suggest-remediation"
            />
          </div>
          <div>
            <Label htmlFor="rs-doc">Doc URL (optional)</Label>
            <Input
              id="rs-doc"
              value={docUrl}
              onChange={(e) => setDocUrl(e.target.value)}
              placeholder="https://help.twilio.com/..."
              data-testid="input-suggest-docurl"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => submit.mutate()}
            disabled={submit.isPending}
            data-testid="button-submit-suggestion"
          >
            {submit.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Send suggestion
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface A2pBundleRejection {
  bundleSid: string;
  bundleType: "customer_profile" | "trust_product";
  section: "business" | "rep" | "address" | "campaign" | "other";
  objectType?: string;
  field?: string;
  failureReason: string;
}
interface A2pStatus {
  status: "not_registered" | "pending" | "approved" | "rejected" | "failed";
  configured: boolean;
  useCase?: string | null;
  brands?: { sid: string; status: string; failureReason?: string | null }[];
  campaigns?: {
    sid: string;
    campaignStatus: string;
    usAppToPersonUsecase?: string;
    messagingServiceName?: string;
    messagingServiceSid?: string;
    failureReason?: string | null;
  }[];
  bundleRejections?: A2pBundleRejection[];
  phoneNumbers?: string[];
  error?: string;
}

interface A2pPrefillResponse {
  savedAt: string | null;
  body: {
    business?: {
      legalName?: string;
      ein?: string;
      businessType?: string;
      industry?: string;
      website?: string;
      address?: { street?: string; city?: string; region?: string; postalCode?: string };
      contact?: { firstName?: string; lastName?: string; email?: string; phone?: string; jobTitle?: string };
    };
    campaign?: {
      description?: string;
      usAppToPersonUsecase?: string;
      brandType?: string;
      messageSamples?: string[];
      messageFlow?: string;
      optInMessage?: string;
      optInKeywords?: string[];
      hasEmbeddedLinks?: boolean;
      hasEmbeddedPhone?: boolean;
    };
  };
}

interface RegisterStepResult {
  ok: boolean;
  sid?: string;
  error?: string;
  note?: string;
  skipped?: boolean;
  reused?: boolean;
  phoneNumber?: string;
}
interface RegisterResponse {
  customerProfile: RegisterStepResult | null;
  brand: RegisterStepResult | null;
  messagingService: RegisterStepResult | null;
  phoneNumber: RegisterStepResult | null;
  campaign: RegisterStepResult | null;
}

interface TwilioPhoneNumbersResponse {
  configured: boolean;
  numbers: { sid: string; phoneNumber: string; friendlyName?: string }[];
  configuredPhoneNumber: string | null;
}

interface WizardForm {
  legalName: string;
  ein: string;
  businessType: string;
  industry: string;
  website: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
  usecase: string;
  brandType: string;
  description: string;
  messageSample1: string;
  messageSample2: string;
  messageFlow: string;
  optInMessage: string;
  optInKeywords: string;
  hasEmbeddedLinks: boolean;
  hasEmbeddedPhone: boolean;
}

const A2P_CTA_MESSAGE_FLOW =
  "Customers opt in to receive text messages from Computer Systems Depot Inc. in one of two ways. (1) Web form CTA: Customers visit https://support.computersystemsdepot.com/intake and enter their mobile number. The form displays an unchecked-by-default consent checkbox labeled exactly: \"I agree to receive text messages from Computer Systems Depot Inc. at the mobile number provided, regarding my service request — including repair and ticket status updates, appointment reminders, and service alerts. Message frequency varies. Message & data rates may apply. Consent is not a condition of purchase. Reply STOP to unsubscribe or HELP for help.\" The checkbox is optional and appears alongside clickable Privacy Policy (https://www.computersystemsdepot.com/privacy-policy/) and Terms and Conditions (https://www.computersystemsdepot.com/terms-and-conditions/) links. (2) Keyword CTA: End users may text START to 954-637-7300. Upon either opt-in method, the end user immediately receives an automated confirmation identifying Computer Systems Depot Inc. and explaining that recurring service messages may be sent, message and data rates may apply, and replying STOP unsubscribes or HELP provides help. Consent is voluntary and is not a condition of purchase or receiving service.";

const EMPTY_WIZARD_FORM: WizardForm = {
  legalName: "",
  ein: "",
  businessType: "LLC",
  industry: "PROFESSIONAL_SERVICES",
  website: "",
  street: "",
  city: "",
  region: "",
  postalCode: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "+19542533135",
  jobTitle: "Owner",
  usecase: "CUSTOMER_CARE",
  brandType: "STANDARD",
  description: "",
  messageSample1: "",
  messageSample2: "",
  messageFlow: A2P_CTA_MESSAGE_FLOW,
  optInMessage:
    "Computer Systems Depot Inc.: You are opted in to recurring service update texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
  optInKeywords: "START,YES,JOIN",
  hasEmbeddedLinks: false,
  hasEmbeddedPhone: false,
};

function prefillToForm(p: A2pPrefillResponse["body"]): WizardForm {
  const b = p.business || {};
  const a = b.address || {};
  const co = b.contact || {};
  const c = p.campaign || {};
  return {
    ...EMPTY_WIZARD_FORM,
    legalName: b.legalName ?? "",
    ein: b.ein ?? "",
    businessType: b.businessType ?? EMPTY_WIZARD_FORM.businessType,
    industry: b.industry ?? EMPTY_WIZARD_FORM.industry,
    website: b.website ?? "",
    street: a.street ?? "",
    city: a.city ?? "",
    region: a.region ?? "",
    postalCode: a.postalCode ?? "",
    firstName: co.firstName ?? "",
    lastName: co.lastName ?? "",
    email: co.email ?? "",
    phone: co.phone ?? EMPTY_WIZARD_FORM.phone,
    jobTitle: co.jobTitle ?? EMPTY_WIZARD_FORM.jobTitle,
    usecase: c.usAppToPersonUsecase ?? EMPTY_WIZARD_FORM.usecase,
    brandType: c.brandType ?? EMPTY_WIZARD_FORM.brandType,
    description: c.description ?? "",
    messageSample1: c.messageSamples?.[0] ?? "",
    messageSample2: c.messageSamples?.[1] ?? "",
    messageFlow:
      c.messageFlow && c.messageFlow.toLowerCase().includes("terms-and-conditions")
        ? c.messageFlow
        : EMPTY_WIZARD_FORM.messageFlow,
    optInMessage:
      c.optInMessage &&
      c.optInMessage.toLowerCase().includes("computer systems depot") &&
      c.optInMessage.toLowerCase().includes("recurring")
        ? c.optInMessage
        : EMPTY_WIZARD_FORM.optInMessage,
    optInKeywords: (c.optInKeywords ?? []).join(",") || EMPTY_WIZARD_FORM.optInKeywords,
    hasEmbeddedLinks: !!c.hasEmbeddedLinks,
    hasEmbeddedPhone: !!c.hasEmbeddedPhone,
  };
}

// Renders per-field rejection reasons (from bundle evaluations + campaign
// rejection text) above the relevant wizard step so the owner can fix things
// inline instead of guessing which field Twilio complained about.
function StepRejectionList({
  rejections,
  campaignFailureReasons,
}: {
  rejections: A2pBundleRejection[];
  campaignFailureReasons?: string[];
}) {
  if (rejections.length === 0 && (!campaignFailureReasons || campaignFailureReasons.length === 0)) return null;
  return (
    <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-3 text-xs space-y-1" data-testid="wizard-step-rejections">
      <div className="font-medium text-red-700 dark:text-red-300 flex items-center gap-1">
        <ShieldAlert className="h-3.5 w-3.5" /> Twilio flagged the following — please fix and resubmit:
      </div>
      <ul className="list-disc pl-5 space-y-1.5 text-red-800 dark:text-red-200">
        {rejections.map((r, i) => (
          <li key={`b-${i}`}>
            {r.field ? <span className="font-mono">{r.field}</span> : null}
            {r.field ? ": " : ""}
            {r.failureReason}
            <RejectionHint reason={r.failureReason} />
          </li>
        ))}
        {(campaignFailureReasons || []).map((reason, i) => (
          <li key={`c-${i}`}>
            {reason}
            <RejectionHint reason={reason} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function A2pRegistrationWizard({
  open,
  onOpenChange,
  prefill,
  rejections,
  campaignFailureReasons,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  prefill?: A2pPrefillResponse["body"] | null;
  rejections?: A2pBundleRejection[];
  campaignFailureReasons?: string[];
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [form, setForm] = useState<WizardForm>(EMPTY_WIZARD_FORM);
  const [result, setResult] = useState<RegisterResponse | null>(null);
  const [phoneNumberSid, setPhoneNumberSid] = useState<string>("");

  // Load the account's SMS-capable numbers so the owner can pick which one
  // gets attached to the new messaging service. Only meaningful when more
  // than one number exists; otherwise we silently auto-attach the only one.
  const { data: numbersData } = useQuery<TwilioPhoneNumbersResponse>({
    queryKey: ["/api/twilio/phone-numbers"],
    enabled: open,
  });
  const availableNumbers = numbersData?.numbers ?? [];

  // Default the picker to the configured From number whenever the list
  // arrives so single-number accounts don't need to touch the field.
  useEffect(() => {
    if (!phoneNumberSid && availableNumbers.length > 0) {
      const configured = numbersData?.configuredPhoneNumber;
      const match = configured
        ? availableNumbers.find((n) => n.phoneNumber === configured)
        : null;
      setPhoneNumberSid((match || availableNumbers[0]).sid);
    }
  }, [availableNumbers, numbersData?.configuredPhoneNumber, phoneNumberSid]);

  // Hydrate the form from the prior submission whenever the dialog opens with
  // a fresh prefill. Resetting on close (below) puts us back to defaults.
  useEffect(() => {
    if (open && prefill) {
      setForm(prefillToForm(prefill));
    }
  }, [open, prefill]);

  const rj = rejections || [];
  const businessRej = rj.filter((r) => r.section === "business" || r.section === "address" || r.section === "other");
  const repRej = rj.filter((r) => r.section === "rep");
  const campaignRej = rj.filter((r) => r.section === "campaign");

  const set = <K extends keyof WizardForm>(k: K, v: WizardForm[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const submit = useMutation({
    mutationFn: async () => {
      const payload = {
        business: {
          legalName: form.legalName.trim(),
          ein: form.ein.trim(),
          businessType: form.businessType,
          industry: form.industry,
          website: form.website.trim(),
          regionsOfOperation: "USA",
          address: {
            street: form.street.trim(),
            city: form.city.trim(),
            region: form.region.trim(),
            postalCode: form.postalCode.trim(),
            isoCountry: "US",
          },
          contact: {
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
            jobTitle: form.jobTitle.trim(),
          },
        },
        campaign: {
          description: form.description.trim(),
          usAppToPersonUsecase: form.usecase,
          brandType: form.brandType,
          messageSamples: [form.messageSample1, form.messageSample2].map((s) => s.trim()).filter(Boolean),
          messageFlow: form.messageFlow.trim(),
          optInMessage: form.optInMessage.trim(),
          optInKeywords: form.optInKeywords.split(",").map((s) => s.trim()).filter(Boolean),
          hasEmbeddedLinks: form.hasEmbeddedLinks,
          hasEmbeddedPhone: form.hasEmbeddedPhone,
        },
        phoneNumberSid: phoneNumberSid || undefined,
      };
      const res = await apiRequest("POST", "/api/twilio/a2p/register", payload);
      return (await res.json()) as RegisterResponse;
    },
    onSuccess: async (data) => {
      setResult(data);
      setStep(4);
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/status"] });
    },
    onError: (e: any) => {
      toast({ title: "Submission failed", description: e?.message || "Could not submit registration", variant: "destructive" });
    },
  });

  const canStep1Next =
    form.legalName.trim() && form.ein.trim() && form.website.trim() && form.businessType && form.industry;
  const canStep2Next =
    form.firstName.trim() && form.lastName.trim() && form.email.trim();
  const canSubmit =
    form.description.trim() &&
    form.messageSample1.trim() &&
    form.messageFlow.trim() &&
    form.usecase;

  const resetAndClose = () => {
    onOpenChange(false);
    setTimeout(() => {
      setStep(1);
      setResult(null);
      setForm(EMPTY_WIZARD_FORM);
      setPhoneNumberSid("");
    }, 300);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : resetAndClose())}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-a2p-wizard">
        <DialogHeader>
          <DialogTitle>Register for A2P 10DLC</DialogTitle>
          <DialogDescription>
            Submits your brand and campaign to Twilio so US carriers stop blocking your texts.
            {step < 4 ? ` Step ${step} of 3.` : ""}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            <StepRejectionList rejections={businessRej} />
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label htmlFor="legalName">Legal business name *</Label>
                <Input id="legalName" value={form.legalName} onChange={(e) => set("legalName", e.target.value)} data-testid="input-legal-name" />
              </div>
              <div>
                <Label htmlFor="ein">EIN (Tax ID) *</Label>
                <Input id="ein" placeholder="12-3456789" value={form.ein} onChange={(e) => set("ein", e.target.value)} data-testid="input-ein" />
              </div>
              <div>
                <Label htmlFor="website">Website *</Label>
                <Input id="website" placeholder="https://example.com" value={form.website} onChange={(e) => set("website", e.target.value)} data-testid="input-website" />
              </div>
              <div>
                <Label>Business type</Label>
                <Select value={form.businessType} onValueChange={(v) => set("businessType", v)}>
                  <SelectTrigger data-testid="select-business-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Sole Proprietorship">Sole Proprietorship</SelectItem>
                    <SelectItem value="Partnership">Partnership</SelectItem>
                    <SelectItem value="LLC">LLC</SelectItem>
                    <SelectItem value="Corporation">Corporation</SelectItem>
                    <SelectItem value="Co-operative">Co-operative</SelectItem>
                    <SelectItem value="Non-profit">Non-profit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Industry</Label>
                <Select value={form.industry} onValueChange={(v) => set("industry", v)}>
                  <SelectTrigger data-testid="select-industry"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PROFESSIONAL_SERVICES">Professional Services</SelectItem>
                    <SelectItem value="TECHNOLOGY">Technology</SelectItem>
                    <SelectItem value="RETAIL">Retail</SelectItem>
                    <SelectItem value="HEALTHCARE">Healthcare</SelectItem>
                    <SelectItem value="FINANCIAL">Financial</SelectItem>
                    <SelectItem value="REAL_ESTATE">Real Estate</SelectItem>
                    <SelectItem value="EDUCATION">Education</SelectItem>
                    <SelectItem value="HOSPITALITY">Hospitality</SelectItem>
                    <SelectItem value="MANUFACTURING">Manufacturing</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label htmlFor="street">Street address</Label>
                <Input id="street" value={form.street} onChange={(e) => set("street", e.target.value)} data-testid="input-street" />
              </div>
              <div>
                <Label htmlFor="city">City</Label>
                <Input id="city" value={form.city} onChange={(e) => set("city", e.target.value)} data-testid="input-city" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="region">State</Label>
                  <Input id="region" placeholder="FL" value={form.region} onChange={(e) => set("region", e.target.value)} data-testid="input-region" />
                </div>
                <div>
                  <Label htmlFor="postalCode">ZIP</Label>
                  <Input id="postalCode" value={form.postalCode} onChange={(e) => set("postalCode", e.target.value)} data-testid="input-postal" />
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <StepRejectionList rejections={repRej} />
            <p className="text-sm text-muted-foreground">Authorized representative — Twilio will email this person about review status.</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="firstName">First name *</Label>
                <Input id="firstName" value={form.firstName} onChange={(e) => set("firstName", e.target.value)} data-testid="input-first-name" />
              </div>
              <div>
                <Label htmlFor="lastName">Last name *</Label>
                <Input id="lastName" value={form.lastName} onChange={(e) => set("lastName", e.target.value)} data-testid="input-last-name" />
              </div>
              <div className="col-span-2">
                <Label htmlFor="email">Email *</Label>
                <Input id="email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} data-testid="input-email" />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" placeholder="+19545551234" value={form.phone} onChange={(e) => set("phone", e.target.value)} data-testid="input-rep-phone" />
              </div>
              <div>
                <Label htmlFor="jobTitle">Job title</Label>
                <Input id="jobTitle" value={form.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} data-testid="input-job-title" />
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <StepRejectionList rejections={campaignRej} campaignFailureReasons={campaignFailureReasons} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Brand type</Label>
                <Select value={form.brandType} onValueChange={(v) => set("brandType", v)}>
                  <SelectTrigger data-testid="select-brand-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STANDARD">Standard (recommended)</SelectItem>
                    <SelectItem value="SOLE_PROPRIETOR">Sole Proprietor (low volume)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Use case</Label>
                <Select value={form.usecase} onValueChange={(v) => set("usecase", v)}>
                  <SelectTrigger data-testid="select-usecase"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CUSTOMER_CARE">Customer Care</SelectItem>
                    <SelectItem value="MARKETING">Marketing</SelectItem>
                    <SelectItem value="MIXED">Mixed</SelectItem>
                    <SelectItem value="ACCOUNT_NOTIFICATION">Account Notifications</SelectItem>
                    <SelectItem value="DELIVERY_NOTIFICATION">Delivery Notifications</SelectItem>
                    <SelectItem value="HIGHER_EDUCATION">Higher Education</SelectItem>
                    <SelectItem value="POLLING_VOTING">Polling / Voting</SelectItem>
                    <SelectItem value="PUBLIC_SERVICE_ANNOUNCEMENT">Public Service Announcement</SelectItem>
                    <SelectItem value="SECURITY_ALERT">Security Alert</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="description">Campaign description *</Label>
              <Textarea
                id="description"
                rows={2}
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="We send service appointment confirmations and follow-ups to customers who have requested IT support."
                data-testid="input-description"
              />
            </div>
            <div>
              <Label htmlFor="sample1">Sample message 1 *</Label>
              <Textarea id="sample1" rows={2} value={form.messageSample1} onChange={(e) => set("messageSample1", e.target.value)} data-testid="input-sample-1" placeholder="Hi {{1}}, your appointment with our tech is confirmed for {{2}}. Reply STOP to unsubscribe." />
            </div>
            <div>
              <Label htmlFor="sample2">Sample message 2</Label>
              <Textarea id="sample2" rows={2} value={form.messageSample2} onChange={(e) => set("messageSample2", e.target.value)} data-testid="input-sample-2" placeholder="Your invoice {{1}} for ${{2}} is ready. View at example.com/i/{{3}}. Reply STOP to opt out." />
            </div>
            <div>
              <Label htmlFor="optInMessage">Opt-in confirmation message</Label>
              <Textarea id="optInMessage" rows={2} value={form.optInMessage} onChange={(e) => set("optInMessage", e.target.value)} data-testid="input-optin-msg" />
            </div>
            <div>
              <Label htmlFor="messageFlow">How do customers opt in? *</Label>
              <Textarea id="messageFlow" rows={3} value={form.messageFlow} onChange={(e) => set("messageFlow", e.target.value)} data-testid="input-message-flow" />
                <p className="mt-1 text-xs text-muted-foreground">
                  Include the public CTA URL, exact unchecked consent checkbox,
                  optional consent language, message frequency/rates, STOP/HELP
                  instructions, and links to both the Privacy Policy and Terms and
                  Conditions. The default text above is written for this intake form.
                </p>
            </div>
            <div>
              <Label htmlFor="optInKeywords">Opt-in keywords (comma separated)</Label>
              <Input id="optInKeywords" value={form.optInKeywords} onChange={(e) => set("optInKeywords", e.target.value)} data-testid="input-optin-keywords" />
            </div>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.hasEmbeddedLinks} onChange={(e) => set("hasEmbeddedLinks", e.target.checked)} data-testid="check-embedded-links" />
                Messages contain links
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.hasEmbeddedPhone} onChange={(e) => set("hasEmbeddedPhone", e.target.checked)} data-testid="check-embedded-phone" />
                Messages contain phone numbers
              </label>
            </div>
            {availableNumbers.length > 0 && (
              <div>
                <Label>Phone number to attach</Label>
                {availableNumbers.length === 1 ? (
                  <div
                    className="mt-1 rounded-md border px-3 py-2 text-sm text-muted-foreground"
                    data-testid="text-attach-number"
                  >
                    {availableNumbers[0].phoneNumber}
                    {availableNumbers[0].friendlyName ? ` — ${availableNumbers[0].friendlyName}` : ""}
                  </div>
                ) : (
                  <Select value={phoneNumberSid} onValueChange={setPhoneNumberSid}>
                    <SelectTrigger data-testid="select-attach-number"><SelectValue placeholder="Pick a number" /></SelectTrigger>
                    <SelectContent>
                      {availableNumbers.map((n) => (
                        <SelectItem key={n.sid} value={n.sid}>
                          {n.phoneNumber}{n.friendlyName ? ` — ${n.friendlyName}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Outbound texts go through this number's messaging service so they get the approved A2P campaign.
                </p>
              </div>
            )}
          </div>
        )}

        {step === 4 && result && (
          <div className="space-y-3" data-testid="wizard-result">
            <p className="text-sm text-muted-foreground">Submission results. Live status will refresh on the Messages banner.</p>
            {([
              ["Customer profile", result.customerProfile],
              ["Brand registration", result.brand],
              ["Messaging service", result.messagingService],
              ["Phone number attached", result.phoneNumber],
              ["Campaign (us_app_to_person)", result.campaign],
            ] as [string, RegisterStepResult | null][]).map(([label, r]) => (
              <div key={label} className="flex items-start gap-2 rounded-md border p-3 text-sm" data-testid={`result-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
                <div className="mt-0.5">
                  {!r ? <Circle className="h-4 w-4 text-muted-foreground" /> :
                    r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> :
                    r.skipped ? <Circle className="h-4 w-4 text-amber-500" /> :
                    <XCircle className="h-4 w-4 text-red-600" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium flex items-center gap-2">
                    <span>{label}</span>
                    {r?.reused && <Badge variant="outline" className="text-[10px]">Reused</Badge>}
                  </div>
                  {r?.phoneNumber && (
                    <div className="text-xs text-foreground mt-0.5" data-testid="text-attached-phone">
                      {r.phoneNumber}
                    </div>
                  )}
                  {r?.sid && <div className="text-xs text-muted-foreground font-mono truncate">{r.sid}</div>}
                  {r?.note && <div className="text-xs text-muted-foreground mt-0.5">{r.note}</div>}
                  {r?.error && <div className="text-xs text-red-600 dark:text-red-400 mt-0.5">{r.error}</div>}
                </div>
              </div>
            ))}
            <div className="rounded-md bg-muted p-3 text-xs">
              Brand and campaign approval takes 1–3 weeks. Twilio will email your authorized representative when review completes. You can re-run this wizard after the brand is approved to retry any skipped steps.
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step > 1 && step < 4 && (
            <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)} data-testid="button-wizard-back">Back</Button>
          )}
          {step === 1 && (
            <Button onClick={() => setStep(2)} disabled={!canStep1Next} data-testid="button-wizard-next">Next</Button>
          )}
          {step === 2 && (
            <Button onClick={() => setStep(3)} disabled={!canStep2Next} data-testid="button-wizard-next">Next</Button>
          )}
          {step === 3 && (
            <Button onClick={() => submit.mutate()} disabled={!canSubmit || submit.isPending} data-testid="button-wizard-submit">
              {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Submit registration
            </Button>
          )}
          {step === 4 && (
            <Button onClick={resetAndClose} data-testid="button-wizard-done">Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface A2pSnoozeStatus {
  active: boolean;
  snoozeUntil: string | null;
  snoozeStartedAt: string | null;
  snoozeStartedBy: string | null;
  // Synthesized client-side: false when GET returned 403, signalling the
  // current viewer is not an owner and snooze controls should be hidden.
  allowed: boolean;
}

async function fetchA2pSnooze(): Promise<A2pSnoozeStatus> {
  try {
    const res = await apiRequest("GET", "/api/twilio/a2p/snooze");
    return (await res.json()) as A2pSnoozeStatus;
  } catch (error) {
    if (error instanceof Error && /^(401|403):/.test(error.message)) {
      return { active: false, snoozeUntil: null, snoozeStartedAt: null, snoozeStartedBy: null, allowed: false };
    }
    throw error;
  }
}

function A2pStatusBanner() {
  const { toast } = useToast();
  const { isAdmin, isLoading: isAdminLoading } = useAdminAccess();
  const [wizardOpen, setWizardOpen] = useState(false);
  // When the owner clicks "Fix and resubmit" we lazily fetch the prefill and
  // open the wizard with it. We keep the loaded prefill in local state so the
  // wizard hydrates only once per open.
  const [prefill, setPrefill] = useState<A2pPrefillResponse["body"] | null>(null);
  const [loadingPrefill, setLoadingPrefill] = useState(false);

  const { data, isLoading } = useQuery<A2pStatus>({
    queryKey: ["/api/twilio/a2p/status"],
    enabled: isAdmin,
    // Fallback poll. The SSE subscription below normally surfaces changes
    // within seconds; this keeps the banner correct if the stream is
    // unavailable (proxy strips SSE, tab throttled, etc.).
    refetchInterval: 5 * 60 * 1000,
  });

  // Tracks whether our EventSource is currently OPEN. Drives the small
  // "Live" vs "Auto-refresh every 5 min" indicator on the banner so owners
  // can tell which mode they're in after clicking Fix and resubmit.
  // `null` means we never tried (SSR / no EventSource support) — we render
  // nothing in that case to avoid lying about the mode.
  const [liveConnected, setLiveConnected] = useState<boolean | null>(null);

  // Subscribe to the server-sent event stream the A2P background monitor
  // publishes to. When Twilio's verdict or rejection set changes we get a
  // `status` event and immediately refetch the banner data instead of
  // waiting for the next poll cycle. EventSource is built into modern
  // browsers and auto-reconnects on transient drops; if it can't connect
  // at all we silently fall back to the 5-minute poll above.
  useEffect(() => {
    if (!isAdmin) return;
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
      return;
    }
    return subscribeA2PLive({
      createEventSource: () =>
        new EventSource("/api/twilio/a2p/events", { withCredentials: true }),
      onStatus: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/status"] });
        queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/snooze"] });
      },
      onConnectedChange: setLiveConnected,
      openState: EventSource.OPEN,
    });
  }, [isAdmin]);
  const { data: snooze } = useQuery<A2pSnoozeStatus>({
    queryKey: ["/api/twilio/a2p/snooze"],
    queryFn: fetchA2pSnooze,
    enabled: isAdmin,
    refetchInterval: 60 * 1000,
  });

  const snoozeMutation = useMutation({
    mutationFn: async (hours: number) => {
      const res = await apiRequest("POST", "/api/twilio/a2p/snooze", { hours });
      const body = (await res.json()) as Omit<A2pSnoozeStatus, "allowed">;
      return { ...body, allowed: true } as A2pSnoozeStatus;
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/snooze"] });
      const until = data.snoozeUntil ? new Date(data.snoozeUntil) : null;
      toast({
        title: "A2P alerts snoozed",
        description: until ? `New alerts paused until ${format(until, "PPp")}.` : "New alerts paused.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't snooze alerts", description: e.message, variant: "destructive" }),
  });

  const unsnoozeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/twilio/a2p/snooze");
      const body = (await res.json()) as Omit<A2pSnoozeStatus, "allowed">;
      return { ...body, allowed: true } as A2pSnoozeStatus;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/snooze"] });
      toast({ title: "A2P alerts resumed" });
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't resume alerts", description: e.message, variant: "destructive" }),
  });

  const openWizardFresh = () => {
    setPrefill(null);
    setWizardOpen(true);
  };
  const openWizardWithPrefill = async () => {
    setLoadingPrefill(true);
    try {
      const res = await apiRequest("GET", "/api/twilio/a2p/prefill");
      const parsed = (await res.json()) as A2pPrefillResponse;
      setPrefill(parsed.body);
    } catch {
      setPrefill(null);
    } finally {
      setLoadingPrefill(false);
      setWizardOpen(true);
    }
  };

  if (isAdminLoading || !isAdmin || isLoading || !data) return null;

  const snoozeAllowed = snooze?.allowed === true;
  const snoozedUntil =
    snoozeAllowed && snooze?.active && snooze.snoozeUntil ? new Date(snooze.snoozeUntil) : null;
  const canSnooze =
    snoozeAllowed &&
    (data.status === "rejected" || data.status === "failed" || data.status === "pending");

  const consoleUrl = "https://console.twilio.com/us1/develop/sms/regulatory-compliance/onboarding";
  const phones = (data.phoneNumbers || []).map(formatPhone).join(", ");

  // Per-section rejection reasons surfaced from Twilio (bundle evaluations,
  // brand failureReason, campaign rejection objects). Owners need the actual
  // text so they know which field to fix.
  const bundleRejections = data.bundleRejections || [];
  const brandReasons = (data.brands || [])
    .filter((b) => (b.status === "FAILED" || b.status === "SUSPENDED") && b.failureReason)
    .map((b) => b.failureReason as string);
  const campaignReasonObjs = (data.campaigns || [])
    .filter((c) => c.campaignStatus === "FAILED")
    .map((c) => ({
      label: c.messagingServiceName || c.messagingServiceSid || c.sid,
      reason: c.failureReason || "FAILED (no reason returned)",
    }));
  const campaignReasonStrings = campaignReasonObjs.map((c) => `${c.label}: ${c.reason}`);
  const hasAnyRejection =
    bundleRejections.length > 0 || brandReasons.length > 0 || campaignReasonObjs.length > 0;

  let icon = <ShieldQuestion className="h-4 w-4" />;
  let tone = "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-900";
  let title = "A2P 10DLC: Not registered";
  let body = "Your Twilio number isn't registered for A2P 10DLC. Outbound SMS may be blocked by US carriers with error 30034 until brand + campaign registration is complete.";
  let showWizard = false;
  let showFixResubmit = false;
  let showConsole = false;

  if (data.status === "approved") {
    icon = <ShieldCheck className="h-4 w-4" />;
    tone = "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100 dark:border-emerald-900";
    title = "A2P 10DLC: Approved";
    body = `Your number${(data.phoneNumbers?.length || 0) > 1 ? "s" : ""}${phones ? ` (${phones})` : ""} ${data.useCase ? `is approved for the ${data.useCase} use case.` : "is approved to send."}`;
  } else if (data.status === "pending") {
    icon = <ShieldQuestion className="h-4 w-4" />;
    tone = "border-blue-300 bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-900";
    title = "A2P 10DLC: Pending review";
    body = "Your brand or campaign registration is still being reviewed by Twilio / The Campaign Registry. Until it's approved, outbound SMS may be rate-limited or blocked by carriers with error 30034.";
    showConsole = true;
  } else if (data.status === "rejected") {
    icon = <ShieldAlert className="h-4 w-4" />;
    tone = "border-red-300 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100 dark:border-red-900";
    title = "A2P 10DLC: Rejected";
    body = "Registration was rejected. Outbound SMS will be blocked by carriers with error 30034 until each item below is fixed.";
    showWizard = true;
    showFixResubmit = true;
    showConsole = true;
  } else if (data.status === "failed") {
    icon = <AlertTriangle className="h-4 w-4" />;
    tone = "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-900";
    title = "A2P 10DLC: Status unavailable";
    const reason = data.error ? ` (${data.error})` : "";
    body = `Couldn't reach Twilio to check A2P status${reason}. Until registration is confirmed approved, outbound SMS may be blocked by carriers with error 30034.`;
    showConsole = true;
  } else {
    // not_registered
    showWizard = true;
  }

  return (
    <>
      <div
        className={`mb-4 rounded-md border px-3 py-2 text-sm flex items-start gap-2 ${tone}`}
        data-testid={`banner-a2p-${data.status}`}
      >
        <div className="mt-0.5">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-medium flex items-center gap-2 flex-wrap">
            <span>{title}</span>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              {data.status.replace("_", " ")}
            </Badge>
            {liveConnected === true ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-normal opacity-80"
                data-testid="indicator-a2p-live"
                title="Connected to live updates — changes appear within seconds."
              >
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                Live
              </span>
            ) : liveConnected === false ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-normal opacity-70"
                data-testid="indicator-a2p-polling"
                title="Live updates unavailable — refreshing every 5 minutes."
              >
                <Clock className="h-3 w-3" />
                Auto-refresh every 5 min
              </span>
            ) : null}
          </div>
          <div className="text-xs opacity-90 mt-0.5">{body}</div>

          {hasAnyRejection && (
            <div className="mt-2 space-y-2" data-testid="banner-a2p-rejections">
              {brandReasons.length > 0 && (
                <RejectionGroup
                  title="Brand"
                  items={brandReasons.map((r) => ({ text: r }))}
                />
              )}
              {bundleRejections.filter((r) => r.section === "business" || r.section === "address").length > 0 && (
                <RejectionGroup
                  title="Business profile (step 1)"
                  items={bundleRejections
                    .filter((r) => r.section === "business" || r.section === "address")
                    .map((r) => ({ field: r.field, text: r.failureReason }))}
                />
              )}
              {bundleRejections.filter((r) => r.section === "rep").length > 0 && (
                <RejectionGroup
                  title="Authorized representative (step 2)"
                  items={bundleRejections
                    .filter((r) => r.section === "rep")
                    .map((r) => ({ field: r.field, text: r.failureReason }))}
                />
              )}
              {(bundleRejections.filter((r) => r.section === "campaign").length > 0 ||
                campaignReasonStrings.length > 0) && (
                <RejectionGroup
                  title="Campaign (step 3)"
                  items={[
                    ...bundleRejections
                      .filter((r) => r.section === "campaign")
                      .map((r) => ({ field: r.field, text: r.failureReason })),
                    ...campaignReasonObjs.map((c) => ({ field: c.label, text: c.reason })),
                  ]}
                />
              )}
              {bundleRejections.filter((r) => r.section === "other").length > 0 && (
                <RejectionGroup
                  title="Other"
                  items={bundleRejections
                    .filter((r) => r.section === "other")
                    .map((r) => ({ field: r.objectType, text: r.failureReason }))}
                />
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 whitespace-nowrap">
          {snoozedUntil ? (
            <div
              className="inline-flex items-center gap-1.5 rounded-md border border-current/30 bg-background/40 px-2 py-1 text-xs font-medium"
              data-testid="badge-a2p-snoozed"
              title={
                snooze?.snoozeStartedBy
                  ? `Snoozed by ${snooze.snoozeStartedBy}`
                  : "Snoozed"
              }
            >
              <BellOff className="h-3 w-3" />
              Alerts muted until {format(snoozedUntil, "MMM d, h:mm a")}
              <button
                type="button"
                onClick={() => unsnoozeMutation.mutate()}
                disabled={unsnoozeMutation.isPending}
                className="ml-1 underline disabled:opacity-60"
                data-testid="button-a2p-unsnooze"
              >
                {unsnoozeMutation.isPending ? "Resuming…" : "Resume"}
              </button>
            </div>
          ) : canSnooze && data.configured ? (
            <button
              type="button"
              onClick={() => snoozeMutation.mutate(24)}
              disabled={snoozeMutation.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-current/30 px-2 py-1 text-xs font-medium hover:bg-background/40 disabled:opacity-60"
              data-testid="button-a2p-snooze"
              title="Pause repeat A2P alerts for 24 hours while you work with Twilio support"
            >
              {snoozeMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <BellOff className="h-3 w-3" />
              )}
              Snooze 24h
            </button>
          ) : null}
          {showFixResubmit && data.configured && (
            <button
              type="button"
              onClick={openWizardWithPrefill}
              disabled={loadingPrefill}
              className="inline-flex items-center gap-1 rounded-md bg-foreground text-background px-2.5 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-60"
              data-testid="button-a2p-fix-resubmit"
            >
              {loadingPrefill ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Fix and resubmit
            </button>
          )}
          {showWizard && data.configured && !showFixResubmit && (
            <button
              type="button"
              onClick={openWizardFresh}
              className="inline-flex items-center gap-1 rounded-md bg-foreground text-background px-2.5 py-1 text-xs font-medium hover:opacity-90"
              data-testid="button-a2p-wizard"
            >
              Register for A2P 10DLC
            </button>
          )}
          {showConsole && (
            <a
              href={consoleUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs font-medium underline"
              data-testid="link-a2p-console"
            >
              Open Twilio Console <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
      <A2pIncidentHistory allowed={snoozeAllowed} />
      <A2pRegistrationWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        prefill={prefill}
        rejections={bundleRejections}
        campaignFailureReasons={campaignReasonStrings}
      />
    </>
  );
}

interface A2pIncident {
  id: number;
  title: string;
  severity: string;
  status: string;
  startedAt: string | null;
  resolvedAt: string | null;
  durationMs: number | null;
  outcome: "active" | "auto-resolved" | "human-resolved";
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

// Owners/admins-only timeline of past A2P registration incidents. The
// background monitor opens an alert when Twilio's verdict flips to
// rejected/pending/failed and auto-resolves it on recovery; this panel just
// renders those alerts as a compact history so owners can spot flaps and
// see how long each outage lasted. The server gate (requireOwner) is the
// real authorization — `allowed` here just hides the panel for non-owners
// so they don't see a confusing 403.
function A2pIncidentHistory({ allowed }: { allowed: boolean }) {
  const { data, isLoading, isError } = useQuery<A2pIncident[]>({
    queryKey: ["/api/twilio/a2p/incidents"],
    enabled: allowed,
    refetchInterval: 60 * 1000,
  });

  if (!allowed) return null;
  if (isLoading) return null;
  if (isError) return null;
  if (!data || data.length === 0) return null;

  return (
    <Card className="mb-4" data-testid="card-a2p-incidents">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <History className="h-4 w-4" />
          A2P incident history
          <span className="text-xs font-normal text-muted-foreground">
            (last {data.length})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="divide-y divide-border text-xs">
          {data.map((inc) => {
            const started = inc.startedAt ? new Date(inc.startedAt) : null;
            const resolved = inc.resolvedAt ? new Date(inc.resolvedAt) : null;
            const isActive = inc.outcome === "active";
            const isAuto = inc.outcome === "auto-resolved";
            return (
              <li
                key={inc.id}
                className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1"
                data-testid={`incident-${inc.id}`}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  {isActive ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                  ) : isAuto ? (
                    <Bot className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <UserIcon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  )}
                  <span className="truncate font-medium" title={inc.title}>
                    {inc.title}
                  </span>
                </div>
                <div className="text-muted-foreground whitespace-nowrap">
                  {started ? format(started, "MMM d, h:mm a") : "—"}
                  {" → "}
                  {resolved ? format(resolved, "MMM d, h:mm a") : "ongoing"}
                </div>
                <Badge
                  variant="outline"
                  className="text-[10px] uppercase tracking-wide"
                  data-testid={`incident-${inc.id}-duration`}
                >
                  {isActive
                    ? started
                      ? `open ${formatDistanceToNow(started)}`
                      : "open"
                    : formatDuration(inc.durationMs)}
                </Badge>
                <Badge
                  variant={isActive ? "destructive" : "secondary"}
                  className="text-[10px] uppercase tracking-wide"
                  data-testid={`incident-${inc.id}-outcome`}
                >
                  {isActive
                    ? "active"
                    : isAuto
                      ? "auto-resolved"
                      : "resolved by staff"}
                </Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function RejectionGroup({
  title,
  items,
}: {
  title: string;
  items: { field?: string; text: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="text-xs" data-testid={`rejection-group-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <div className="font-semibold">{title}</div>
      <ul className="list-disc pl-5 space-y-1.5 opacity-90">
        {items.map((it, i) => (
          <li key={i}>
            {it.field ? <span className="font-mono">{it.field}</span> : null}
            {it.field ? ": " : ""}
            {it.text}
            <RejectionHint reason={it.text} />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Thread {
  counterparty: string;
  trackingNumber: string;
  lastMessage: string;
  lastDirection: string;
  lastAt: string;
  count: number;
  contactId: number | null;
  contactName: string | null;
}

function formatPhone(num: string): string {
  if (!num) return "Unknown";
  const m = num.match(/^\+?1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : num;
}

function toE164Display(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return digits ? "+" + digits : "";
}

interface A2pRejectionSuggestionRow {
  id: number;
  reasonText: string;
  suggestedTitle: string;
  suggestedRemediation: string;
  docUrl: string | null;
  submittedBy: string | null;
  status: string;
  reviewerNotes: string | null;
  createdAt: string | null;
}

// Dialog that turns a reviewed staff suggestion into a copy-paste-ready
// `A2pRejectionHint` block for `client/src/lib/a2p-rejections.ts`. Owners can
// tweak the generated id / regex before copying, then "Promote" marks the
// suggestion as merged. If the verbatim reason already matches a curated
// pattern we surface a warning so we don't add a redundant entry.
function PromoteToKbDialog({
  open,
  onOpenChange,
  suggestion,
  onPromoted,
  isPromoting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  suggestion: A2pRejectionSuggestionRow | null;
  onPromoted: (id: number) => void;
  isPromoting: boolean;
}) {
  const { toast } = useToast();
  const [hintId, setHintId] = useState("");
  const [pattern, setPattern] = useState("");
  const [title, setTitle] = useState("");
  const [remediation, setRemediation] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open && suggestion) {
      setHintId(slugifyHintId(suggestion.suggestedTitle));
      setPattern(suggestPatternFromReason(suggestion.reasonText));
      setTitle(suggestion.suggestedTitle);
      setRemediation(suggestion.suggestedRemediation);
      setDocUrl(suggestion.docUrl ?? "");
      setCopied(false);
    }
  }, [open, suggestion]);

  // Warn if Twilio's verbatim reason already matches a curated pattern — the
  // owner is likely about to add a duplicate of an existing entry.
  const existingMatch = useMemo(
    () => (suggestion ? matchA2pRejection(suggestion.reasonText) : null),
    [suggestion],
  );

  const snippet = useMemo(
    () => buildA2pHintSnippet({ id: hintId, pattern, title, remediation, docUrl }),
    [hintId, pattern, title, remediation, docUrl],
  );

  // Validate the regex the owner ended up with so we never emit a snippet that
  // won't compile when pasted into the KB.
  const patternError = useMemo(() => {
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern || ".*", "i");
      return null;
    } catch (e: any) {
      return e?.message || "Invalid regular expression";
    }
  }, [pattern]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast({ title: "Snippet copied — paste it into A2P_REJECTION_HINTS" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Couldn't copy automatically",
        description: "Select the snippet text and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="dialog-promote-kb">
        <DialogHeader>
          <DialogTitle>Promote to knowledge base</DialogTitle>
          <DialogDescription>
            Review the generated entry, copy it into{" "}
            <code className="text-[11px]">A2P_REJECTION_HINTS</code> in{" "}
            <code className="text-[11px]">client/src/lib/a2p-rejections.ts</code>, then
            promote to mark this suggestion merged.
          </DialogDescription>
        </DialogHeader>

        {existingMatch ? (
          <div
            className="rounded-md border border-amber-400 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 p-2.5 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2"
            data-testid="promote-duplicate-warning"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              This rejection already matches an existing note (
              <span className="font-mono">{existingMatch.hint.id}</span>). Promoting
              may create a duplicate — consider improving that entry instead.
            </span>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="kb-id">Hint id</Label>
            <Input
              id="kb-id"
              value={hintId}
              onChange={(e) => setHintId(e.target.value)}
              className="font-mono text-xs"
              data-testid="input-kb-id"
            />
          </div>
          <div>
            <Label htmlFor="kb-doc">Doc URL</Label>
            <Input
              id="kb-doc"
              value={docUrl}
              onChange={(e) => setDocUrl(e.target.value)}
              placeholder="https://help.twilio.com/..."
              className="text-xs"
              data-testid="input-kb-docurl"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="kb-pattern">Pattern (regex source, matched case-insensitively)</Label>
          <Input
            id="kb-pattern"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="font-mono text-xs"
            data-testid="input-kb-pattern"
          />
          {patternError ? (
            <p className="mt-1 text-[11px] text-destructive" data-testid="kb-pattern-error">
              {patternError}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Auto-generated from the rejection text — tweak so it matches the
              family of rejections without being too broad.
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="kb-title">Title</Label>
          <Input
            id="kb-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="input-kb-title"
          />
        </div>
        <div>
          <Label htmlFor="kb-rem">Remediation</Label>
          <Textarea
            id="kb-rem"
            value={remediation}
            onChange={(e) => setRemediation(e.target.value)}
            rows={3}
            data-testid="input-kb-remediation"
          />
        </div>
        <div>
          <Label>Ready-to-paste block</Label>
          <pre
            className="mt-1 max-h-48 overflow-auto rounded-md border bg-muted/50 p-3 text-[11px] leading-relaxed"
            data-testid="kb-snippet"
          >
            <code>{snippet}</code>
          </pre>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleCopy} data-testid="button-copy-snippet">
            {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
            {copied ? "Copied" : "Copy snippet"}
          </Button>
          <Button
            onClick={() => suggestion && onPromoted(suggestion.id)}
            disabled={isPromoting || !!patternError || !suggestion}
            data-testid="button-confirm-promote"
          >
            {isPromoting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Promote &amp; mark merged
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExportRejectionSuggestionsDialog({
  open,
  onOpenChange,
  suggestions,
  onMarkMerged,
  isMarkingMerged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  suggestions: A2pRejectionSuggestionRow[];
  onMarkMerged: (ids: number[]) => void;
  isMarkingMerged: boolean;
}) {
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [markMerged, setMarkMerged] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedIds(suggestions.map((s) => s.id));
      setMarkMerged(false);
      setCopied(false);
    }
  }, [open]);

  const selected = suggestions.filter((s) => selectedIds.includes(s.id));
  const snippet = buildA2pHintBatchSnippet(
    selected.map((s) => ({
      id: slugifyHintId(s.suggestedTitle),
      pattern: suggestPatternFromReason(s.reasonText),
      title: s.suggestedTitle,
      remediation: s.suggestedRemediation,
      docUrl: s.docUrl ?? "",
    })),
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast({ title: `${selected.length} knowledge-base ${selected.length === 1 ? "entry" : "entries"} copied` });
      if (markMerged) onMarkMerged(selected.map((s) => s.id));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Couldn't copy automatically",
        description: "Select the combined snippet and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="dialog-export-rejection-suggestions">
        <DialogHeader>
          <DialogTitle>Export reviewed rejection notes</DialogTitle>
          <DialogDescription>
            Choose the reviewed notes to combine into one list ready to paste into{" "}
            <code className="text-[11px]">A2P_REJECTION_HINTS</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-48 overflow-auto rounded-md border divide-y">
          {suggestions.map((s) => (
            <label key={s.id} className="flex items-start gap-3 p-3 text-xs cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selectedIds.includes(s.id)}
                onChange={(e) =>
                  setSelectedIds((ids) =>
                    e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                  )
                }
                data-testid={`checkbox-export-suggestion-${s.id}`}
              />
              <span className="min-w-0">
                <span className="font-semibold">{s.suggestedTitle}</span>
                <span className="ml-2 text-[10px] uppercase text-muted-foreground">{s.status}</span>
                <span className="block truncate text-muted-foreground">{s.reasonText}</span>
              </span>
            </label>
          ))}
        </div>
        <div>
          <Label>Combined ready-to-paste list ({selected.length})</Label>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md border bg-muted/50 p-3 text-[11px] leading-relaxed" data-testid="batch-kb-snippet">
            <code>{snippet || "// Select at least one reviewed suggestion."}</code>
          </pre>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={markMerged}
            onChange={(e) => setMarkMerged(e.target.checked)}
            data-testid="checkbox-mark-exported-merged"
          />
          Mark selected reviewed suggestions merged after copying
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleCopy}
            disabled={!selected.length || isMarkingMerged}
            data-testid="button-copy-batch-export"
          >
            {isMarkingMerged ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
            {copied ? "Copied" : `Copy ${selected.length || ""} ${selected.length === 1 ? "entry" : "entries"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Owner-only review panel for staff-submitted rejection-note suggestions.
// The list endpoint is gated by requireOwner — if the current user isn't
// an owner the query 403s and the panel renders nothing.
function RejectionSuggestionsAdminPanel() {
  const { toast } = useToast();
  const { data, isError } = useQuery<A2pRejectionSuggestionRow[]>({
    queryKey: ["/api/twilio/a2p/rejection-suggestions"],
    queryFn: async () => {
      try {
        return await (await apiRequest("GET", "/api/twilio/a2p/rejection-suggestions")).json();
      } catch (error) {
        if (error instanceof Error && /^(401|403):/.test(error.message)) return [];
        throw error;
      }
    },
    retry: false,
    staleTime: 30000,
  });

  const [promoteFor, setPromoteFor] = useState<A2pRejectionSuggestionRow | null>(null);
  const [promoteIds, setPromoteIds] = useState<number[]>([]);
  const [exportOpen, setExportOpen] = useState(false);

  // Status changes apply to every row in a collapsed group, so dismissing or
  // promoting a card clears all its near-identical near-dupes at once (otherwise
  // the siblings would stay pending and resurface as a fresh card).
  const updateStatus = useMutation({
    mutationFn: async ({ ids, status }: { ids: number[]; status: string }) => {
      await Promise.all(
        ids.map((id) =>
          apiRequest("PATCH", `/api/twilio/a2p/rejection-suggestions/${id}`, { status }),
        ),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/rejection-suggestions"] });
    },
    onError: (e: any) =>
      toast({ title: "Update failed", description: e?.message, variant: "destructive" }),
  });

  const promote = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(
        ids.map((id) =>
          apiRequest("PATCH", `/api/twilio/a2p/rejection-suggestions/${id}`, { status: "merged" }),
        ),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/rejection-suggestions"] });
      setPromoteFor(null);
      setPromoteIds([]);
      toast({ title: "Promoted — suggestion marked merged" });
    },
    onError: (e: any) =>
      toast({ title: "Promote failed", description: e?.message, variant: "destructive" }),
  });

  const markExportedMerged = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(
        ids.map((id) =>
          apiRequest("PATCH", `/api/twilio/a2p/rejection-suggestions/${id}`, { status: "merged" }),
        ),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/rejection-suggestions"] });
      toast({ title: "Exported suggestions marked merged" });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't mark exported suggestions merged", description: e?.message, variant: "destructive" }),
  });

  if (isError) return null;
  if (!data || data.length === 0) return null;

  const pending = data.filter((s) => s.status === "pending");
  const exportable = data.filter((s) => isA2pSuggestionExportEligible(s.status));
  if (pending.length === 0 && exportable.length === 0) return null;

  // Collapse near-identical reason strings (differing only in case/whitespace)
  // into one card. The newest submission represents the group; older near-dupes
  // contribute to the count so owners don't see the same rejection repeated.
  // We keep every member id so a single action resolves the whole group.
  const groups = new Map<string, { rep: A2pRejectionSuggestionRow; count: number; ids: number[] }>();
  for (const s of pending) {
    const key = normalizeRejectionReason(s.reasonText);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.ids.push(s.id);
      if (new Date(s.createdAt ?? 0) > new Date(existing.rep.createdAt ?? 0)) {
        existing.rep = s;
      }
    } else {
      groups.set(key, { rep: s, count: 1, ids: [s.id] });
    }
  }
  const grouped = Array.from(groups.values());

  return (
    <>
    <Card className="mb-4 border-amber-300 bg-amber-50/40 dark:bg-amber-950/20 dark:border-amber-900" data-testid="card-rejection-suggestions">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Inbox className="h-4 w-4" />
          Rejection-note suggestions
          <Badge variant="secondary" className="ml-1">{grouped.length} pending</Badge>
          {exportable.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => setExportOpen(true)}
              data-testid="button-export-all-rejection-suggestions"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export all ({exportable.length})
            </Button>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {grouped.map(({ rep: s, count, ids }) => (
          <div
            key={s.id}
            className="rounded-md border bg-background p-3 text-xs space-y-2"
            data-testid={`suggestion-${s.id}`}
          >
            <div>
              <div className="font-semibold opacity-70 text-[10px] uppercase tracking-wide flex items-center gap-1.5">
                Verbatim rejection
                {count > 1 ? (
                  <Badge
                    variant="secondary"
                    className="text-[10px] py-0 px-1.5 normal-case font-semibold"
                    data-testid={`suggestion-count-${s.id}`}
                  >
                    reported {count}×
                  </Badge>
                ) : null}
              </div>
              <div className="mt-0.5 italic">{s.reasonText}</div>
            </div>
            <div>
              <div className="font-semibold opacity-70 text-[10px] uppercase tracking-wide">
                Suggested note
              </div>
              <div className="mt-0.5 font-semibold">{s.suggestedTitle}</div>
              <div className="mt-0.5 leading-snug">{s.suggestedRemediation}</div>
              {s.docUrl ? (
                <a
                  href={s.docUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 inline-flex items-center gap-1 underline"
                >
                  {s.docUrl} <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] text-muted-foreground">
                {s.submittedBy ? `from ${s.submittedBy}` : "anonymous"}
                {s.createdAt ? ` · ${formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}` : ""}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setPromoteFor(s);
                    setPromoteIds(ids);
                  }}
                  disabled={updateStatus.isPending || promote.isPending}
                  data-testid={`button-suggestion-promote-${s.id}`}
                >
                  <Wand2 className="h-3.5 w-3.5 mr-1.5" />
                  Promote to KB
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => updateStatus.mutate({ ids, status: "dismissed" })}
                  disabled={updateStatus.isPending}
                  data-testid={`button-suggestion-dismiss-${s.id}`}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
    <PromoteToKbDialog
      open={!!promoteFor}
      onOpenChange={(v) => { if (!v) { setPromoteFor(null); setPromoteIds([]); } }}
      suggestion={promoteFor}
      onPromoted={() => promote.mutate(promoteIds.length ? promoteIds : promoteFor ? [promoteFor.id] : [])}
      isPromoting={promote.isPending}
    />
    <ExportRejectionSuggestionsDialog
      open={exportOpen}
      onOpenChange={setExportOpen}
      suggestions={exportable}
      onMarkMerged={(ids) => markExportedMerged.mutate(ids)}
      isMarkingMerged={markExportedMerged.isPending}
    />
    </>
  );
}

export default function MessagesPage() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [newTo, setNewTo] = useState("");
  const [newBody, setNewBody] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkClass, setBulkClass] = useState<"service" | "marketing">("service");
  const [bulkSearch, setBulkSearch] = useState("");
  const [bulkBody, setBulkBody] = useState("");
  const [selectedContactIds, setSelectedContactIds] = useState<number[]>([]);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshInbox = async () => {
    setRefreshing(true);
    try { await queryClient.invalidateQueries({ queryKey: ["/api/sms/inbox"] }); } finally { setRefreshing(false); }
  };

  const { data: bulkRecipients = [], isLoading: bulkRecipientsLoading } = useQuery<BulkRecipient[]>({
    queryKey: ["/api/sms/bulk-recipients", bulkClass],
    enabled: bulkOpen,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sms/bulk-recipients?messageClass=${bulkClass}`);
      return res.json();
    },
  });

  const visibleBulkRecipients = useMemo(() => {
    const query = bulkSearch.trim().toLowerCase();
    return bulkRecipients.filter((recipient) =>
      !query ||
      recipient.name.toLowerCase().includes(query) ||
      (recipient.mobilePhone?.includes(query) ?? false),
    );
  }, [bulkRecipients, bulkSearch]);

  const eligibleBulkRecipients = visibleBulkRecipients.filter((recipient) => recipient.eligible);
  const selectedEligibleCount = bulkRecipients.filter(
    (recipient) => recipient.eligible && selectedContactIds.includes(recipient.contactId),
  ).length;

  useEffect(() => {
    setSelectedContactIds([]);
  }, [bulkClass]);

  const bulkSend = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sms/bulk-send", {
        contactIds: selectedContactIds,
        body: bulkBody.trim(),
        messageClass: bulkClass,
      });
      return res.json() as Promise<BulkSendResult>;
    },
    onSuccess: async (result) => {
      setBulkConfirmOpen(false);
      setBulkOpen(false);
      setBulkBody("");
      setSelectedContactIds([]);
      await queryClient.invalidateQueries({ queryKey: ["/api/sms/inbox"] });
      toast({
        title: `Bulk text sent to ${result.sent} customer${result.sent === 1 ? "" : "s"}`,
        description: [
          result.skipped ? `${result.skipped} skipped` : "",
          result.failed ? `${result.failed} failed` : "",
        ].filter(Boolean).join(" · ") || undefined,
        variant: result.failed ? "destructive" : "default",
      });
    },
    onError: (error: Error) =>
      toast({ title: "Bulk send failed", description: error.message, variant: "destructive" }),
  });

  // Starting a conversation; replies inside a conversation live in SharedInbox.
  // Always sent from the main business line.
  const sendNew = useMutation({
    mutationFn: async ({ to, body }: { to: string; body: string }) =>
      apiRequest("POST", "/api/sms/send", { to, body }),
    onSuccess: async () => {
      setNewBody("");
      setComposeOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["/api/sms/inbox"] });
      toast({ title: "Text sent from the CSD main line" });
    },
    onError: (e: any) => toast({ title: "Send failed", description: e?.message, variant: "destructive" }),
  });

  // After a new conversation is started, jump into it
  const handleNew = async () => {
    const to = toE164Display(newTo);
    if (!to || !newBody.trim()) {
      toast({ title: "Enter a phone number and message", variant: "destructive" });
      return;
    }
    await sendNew.mutateAsync({ to, body: newBody.trim() });
    setSelected(threadKeyFor(to));
  };

  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="page-messages">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <MessageSquare className="h-7 w-7" /> Messages
          </h1>
          <p className="text-muted-foreground">One team inbox for the CSD main line — customers always see {MAIN_LINE_DISPLAY}.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void refreshInbox()} disabled={refreshing} data-testid="button-refresh-threads">
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={() => setComposeOpen((v) => !v)} data-testid="button-new-message">
            <Plus className="h-4 w-4 mr-2" /> New Message
          </Button>
          <Button variant="secondary" onClick={() => setBulkOpen((value) => !value)} data-testid="button-bulk-message">
            <Users className="h-4 w-4 mr-2" /> Bulk Text
          </Button>
        </div>
      </div>

      <A2pStatusBanner />

      <RejectionSuggestionsAdminPanel />

      <ComplianceNotice title="SMS Consent" className="mb-4">
        Service messages may include appointment reminders, ticket updates, technician arrival
        notices, invoices, and account notices. Marketing messages require separate consent, and
        customers may opt out of non-essential texts by replying STOP — honor opt-outs immediately.
      </ComplianceNotice>

      {composeOpen && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Start a new conversation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Phone number (e.g. 9545551234 or +19545551234)"
              value={newTo}
              onChange={(e) => setNewTo(e.target.value)}
              data-testid="input-new-to"
            />
            <Textarea
              placeholder="Your message…"
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              rows={3}
              data-testid="input-new-body"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setComposeOpen(false)}>Cancel</Button>
              <Button onClick={handleNew} disabled={sendNew.isPending} data-testid="button-send-new">
                {sendNew.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
                Send
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {bulkOpen && (
        <Card className="mb-4" data-testid="bulk-text-composer">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Bulk text customers</CardTitle>
            <p className="text-sm text-muted-foreground">
              Select up to 100 eligible contacts. Opted-out customers are always excluded.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[220px_1fr]">
              <div className="space-y-2">
                <Label>Message type</Label>
                <Select value={bulkClass} onValueChange={(value) => setBulkClass(value as "service" | "marketing")}>
                  <SelectTrigger data-testid="select-bulk-message-class">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="service">Service update</SelectItem>
                    <SelectItem value="marketing">Marketing campaign</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Find customers</Label>
                <Input
                  value={bulkSearch}
                  onChange={(event) => setBulkSearch(event.target.value)}
                  placeholder="Search by customer name or mobile number"
                  data-testid="input-bulk-search"
                />
              </div>
            </div>

            {bulkClass === "marketing" && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Marketing texts require separate promotional SMS consent. Service-message consent alone is not enough.
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <strong>{selectedEligibleCount}</strong> selected ·{" "}
                <strong>{bulkRecipients.filter((recipient) => recipient.eligible).length}</strong> eligible ·{" "}
                <strong>{bulkRecipients.filter((recipient) => !recipient.eligible).length}</strong> excluded
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const additions = eligibleBulkRecipients
                      .map((recipient) => recipient.contactId)
                      .filter((id) => !selectedContactIds.includes(id));
                    setSelectedContactIds((current) => [...current, ...additions].slice(0, 100));
                  }}
                  disabled={!eligibleBulkRecipients.length}
                >
                  Select eligible
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedContactIds([])}>
                  Clear
                </Button>
              </div>
            </div>

            <ScrollArea className="h-56 rounded-md border">
              {bulkRecipientsLoading ? (
                <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading contacts…
                </div>
              ) : visibleBulkRecipients.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">No contacts found.</div>
              ) : (
                <div className="divide-y">
                  {visibleBulkRecipients.map((recipient) => {
                    const checked = selectedContactIds.includes(recipient.contactId);
                    return (
                      <label
                        key={recipient.contactId}
                        className={`flex items-center gap-3 px-3 py-2.5 ${recipient.eligible ? "cursor-pointer hover:bg-muted/50" : "opacity-60"}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!recipient.eligible}
                          onChange={(event) => {
                            setSelectedContactIds((current) =>
                              event.target.checked
                                ? [...current, recipient.contactId].slice(0, 100)
                                : current.filter((id) => id !== recipient.contactId),
                            );
                          }}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{recipient.name}</span>
                          <span className="block text-xs text-muted-foreground">{recipient.mobilePhone || "No mobile number"}</span>
                        </span>
                        <Badge variant={recipient.eligible ? "secondary" : "outline"}>
                          {recipient.eligible ? "Eligible" : recipient.reason}
                        </Badge>
                      </label>
                    );
                  })}
                </div>
              )}
            </ScrollArea>

            <div className="space-y-2">
              <Label>Message</Label>
              <Textarea
                value={bulkBody}
                onChange={(event) => setBulkBody(event.target.value)}
                rows={4}
                maxLength={1600}
                placeholder={bulkClass === "service" ? "Enter the service update…" : "Enter the promotional message…"}
                data-testid="input-bulk-body"
              />
              <div className="text-right text-xs text-muted-foreground">{bulkBody.length}/1600</div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setBulkOpen(false)}>Cancel</Button>
              <Button
                onClick={() => setBulkConfirmOpen(true)}
                disabled={!selectedEligibleCount || !bulkBody.trim()}
                data-testid="button-review-bulk-send"
              >
                Review send
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send bulk {bulkClass === "service" ? "service update" : "marketing campaign"}?</DialogTitle>
            <DialogDescription>
              This will send one individual text to each of {selectedEligibleCount} eligible customers. Consent and STOP status will be checked again by the server before every send.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">{bulkBody}</div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)}>Go back</Button>
            <Button onClick={() => bulkSend.mutate()} disabled={bulkSend.isPending} data-testid="button-confirm-bulk-send">
              {bulkSend.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send to {selectedEligibleCount}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SharedInbox selected={selected} onSelect={setSelected} />
    </div>
  );
}
