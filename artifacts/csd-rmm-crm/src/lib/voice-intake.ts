// Conversation logic for the spoken intake assistant. Pure functions only —
// the React panel (components/forms/voice-intake-panel.tsx) owns speech,
// timing and the form instance. The repair intake form stays the source of
// truth: every step here maps to one of its existing fields, and nothing here
// can tick the SMS consent box or submit the form.

export type VoiceField =
  | "customerName" | "companyName" | "phoneNumber" | "emailAddress" | "streetAddress"
  | "contactPreference" | "deviceType" | "deviceBrandModel" | "operatingSystem"
  | "problemDescription" | "serviceId" | "howDidYouHear";

export type VoiceIntent =
  | "answer" | "yes" | "no" | "skip" | "repeat" | "change" | "submit" | "unclear" | "sensitive";

export interface VoiceOptions {
  deviceType: string[];
  operatingSystem: string[];
  howDidYouHear: string[];
  services: { id: number; name: string }[];
}

export interface VoiceUpdates {
  customerName?: string; companyName?: string; phoneNumber?: string; emailAddress?: string;
  streetAddress?: string; city?: string; state?: string; zip?: string;
  contactPreference?: "call" | "text" | "email"; serviceId?: number;
  deviceType?: string; deviceBrandModel?: string; operatingSystem?: string;
  problemDetail?: string; howDidYouHear?: string;
}

export interface Interpretation {
  intent: VoiceIntent;
  updates: VoiceUpdates;
  changeField: string | null;
  acknowledgement: string;
  followUpQuestion: string | null;
}

export interface VoiceStep {
  field: VoiceField;
  required: boolean;
  /** Read back and ask "is that correct?" before moving on. */
  confirm?: boolean;
}

// Asked in this order; any step whose field is already answered (by voice,
// by an earlier multi-part answer, or typed by hand) is skipped.
export const VOICE_STEPS: VoiceStep[] = [
  { field: "customerName", required: true },
  { field: "companyName", required: false },
  { field: "phoneNumber", required: true, confirm: true },
  { field: "emailAddress", required: true, confirm: true },
  { field: "contactPreference", required: true },
  { field: "deviceType", required: true },
  { field: "deviceBrandModel", required: true },
  { field: "operatingSystem", required: true },
  { field: "problemDescription", required: true },
  { field: "serviceId", required: true },
  { field: "streetAddress", required: false },
  { field: "howDidYouHear", required: true },
];

export const FIELD_LABELS: Record<VoiceField, string> = {
  customerName: "Full name",
  companyName: "Company",
  phoneNumber: "Mobile phone",
  emailAddress: "Email",
  streetAddress: "Service address",
  contactPreference: "Preferred contact",
  deviceType: "Device type",
  deviceBrandModel: "Brand & model",
  operatingSystem: "Operating system",
  problemDescription: "Problem description",
  serviceId: "Service",
  howDidYouHear: "How you heard about us",
};

export const GREETING =
  "Thank you for contacting Computer Systems Depot, your computer and technology support specialists. I'm your virtual service assistant, and I'll help you complete your service request today. You can answer my questions by speaking, and I'll fill out the form for you. Are you ready to get started?";

export const REVIEW_PROMPT =
  "I've completed your service request using the information you provided. Please review the details. Would you like to make any changes before submitting?";

export const SMS_NOTE =
  "One more thing: if you'd like text message updates about your request, you can tick the optional text message consent box on the form yourself. It's completely optional and not required to get service.";

export const SENSITIVE_WARNING =
  "For your security, please don't share passwords, PINs, or payment card numbers with me. A technician will ask for anything like that safely, if it's ever needed.";

export function questionFor(field: VoiceField, options: VoiceOptions, firstName?: string): string {
  switch (field) {
    case "customerName": return "Let's start with your full name, please.";
    case "companyName": return `${firstName ? `Thanks, ${firstName}. ` : ""}Is this request for a business? If so, what's the company name? If it's for personal use, just say skip.`;
    case "phoneNumber": return "What's the best mobile phone number to reach you?";
    case "emailAddress": return "And what's your email address?";
    case "contactPreference": return "How would you prefer we contact you: a phone call, a text message, or email?";
    case "deviceType": return "What kind of computer are you having trouble with? For example, a laptop, a desktop, or an all-in-one.";
    case "deviceBrandModel": return "What's the brand and model of the computer, if you know it? For example, Dell Inspiron or HP Pavilion.";
    case "operatingSystem": return "Do you know which operating system it runs, like Windows 11, Windows 10, or a Mac? It's fine to say you're not sure.";
    case "problemDescription": return "Can you describe what's happening when you try to use the computer?";
    case "serviceId": {
      const names = options.services.slice(0, 8).map((s) => s.name);
      return names.length
        ? `Which service do you need? The options are: ${joinOr(names)}.`
        : "Which service do you need?";
    }
    case "streetAddress": return "If you'd like on-site service or pickup and return, what's the service address? Otherwise, just say skip.";
    case "howDidYouHear": return "Last question: how did you hear about Computer Systems Depot?";
  }
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/** Next step to ask, or null when every step has been answered or skipped. */
export function nextStep(answered: (field: VoiceField) => boolean, skipped: ReadonlySet<VoiceField>): VoiceStep | null {
  return VOICE_STEPS.find((step) => !answered(step.field) && !(skipped.has(step.field) && !step.required)) ?? null;
}

// ---------- speaking values back ----------

export function spokenPhone(phone: string): string {
  const d = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length !== 10) return d.split("").join(" ");
  return `${d.slice(0, 3).split("").join(" ")}, ${d.slice(3, 6).split("").join(" ")}, ${d.slice(6).split("").join(" ")}`;
}

export function spokenEmail(email: string): string {
  const [local, domain = ""] = email.split("@");
  const spell = (s: string) => s.split("").map((c) => (c === "." ? "dot" : c === "_" ? "underscore" : c === "-" ? "dash" : c)).join(" ");
  return `${local.length <= 24 ? spell(local) : local} at ${domain.replace(/\./g, " dot ")}`;
}

export function confirmQuestion(field: "phoneNumber" | "emailAddress", value: string): string {
  return field === "phoneNumber"
    ? `Let me confirm your phone number: ${spokenPhone(value)}. Is that correct?`
    : `Let me confirm your email address: ${spokenEmail(value)}. Is that correct?`;
}

// ---------- local (no-AI) interpretation ----------

const YES = /^(yes|yeah|yep|yup|sure|correct|right|that's right|that is right|exactly|ok|okay|ready|i'm ready|i am ready|let's go|go ahead|absolutely|affirmative|uh huh|mhm)\b/i;
const NO = /^(no|nope|nah|not yet|wrong|incorrect|that's wrong|that's not right|not really|wait|hold on)\b/i;
const SKIP = /^(skip|pass|none|no company|not applicable|n\/?a|personal|it's personal|it's for me|just me|i don't know|don't know|not sure|no idea|i'm not sure)\b/i;
const REPEAT = /\b(repeat|say that again|come again|pardon|what was the question|didn't catch|didn't hear)\b/i;
const SUBMIT = /\b(submit|send it|send the request|send my request)\b/i;
const NO_CHANGES = /\b(no changes|nothing to change|looks good|all good|it's fine|that's fine|that's all|everything is correct|all correct)\b/i;

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

export function spokenDigits(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  let out = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d+$/.test(w)) out += w;
    else if (w === "double" || w === "triple") {
      const next = words[i + 1];
      const digit = next && (/^\d$/.test(next) ? next : NUMBER_WORDS[next]);
      if (digit) { out += digit.repeat(w === "double" ? 2 : 3); i++; }
    } else if (NUMBER_WORDS[w] && (w !== "to" && w !== "too" && w !== "for" && w !== "o" || out.length > 0)) out += NUMBER_WORDS[w];
  }
  return out;
}

export function spokenEmailToAddress(text: string): string {
  return text
    .toLowerCase()
    .replace(/^(it's|it is|my email is|my email address is|email is|the email is)\s+/, "")
    .replace(/\s+at\s+|\s*\(at\)\s*/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+(underscore)\s+/g, "_")
    .replace(/\s+(dash|hyphen)\s+/g, "-")
    .replace(/\s+/g, "")
    .replace(/[.,!?]+$/, "");
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function stripLead(text: string, leads: RegExp): string {
  return text.replace(leads, "").replace(/[.!?]+$/, "").trim();
}

function matchOption(text: string, rules: [RegExp, string][], allowed: string[]): string | undefined {
  for (const [re, option] of rules) if (re.test(text) && allowed.includes(option)) return option;
  return undefined;
}

export const DEVICE_RULES: [RegExp, string][] = [
  [/all[\s-]?in[\s-]?one|imac/i, "All-in-One"],
  [/laptop|notebook|macbook|chromebook|ultrabook/i, "Laptop"],
  [/desktop|tower|\bpc\b|workstation|gaming (rig|computer)/i, "Desktop"],
];

export const OS_RULES: [RegExp, string][] = [
  [/windows\s*(11|eleven)/i, "Windows 11"],
  [/windows\s*(10|ten)/i, "Windows 10"],
  [/windows\s*(8|eight)/i, "Windows 8/8.1"],
  [/windows\s*(7|seven)/i, "Windows 7"],
  [/mac|apple|os x|macos/i, "macOS (Mac)"],
  [/chrome|chromebook/i, "Chrome OS"],
  [/linux|ubuntu/i, "Linux"],
];

export const HEARD_RULES: [RegExp, string][] = [
  [/google|search|online|internet|web/i, "Google Search"],
  [/existing|before|been there|used you|returning|customer/i, "Existing Customer"],
  [/friend|family|referr|recommend|neighbor|word of mouth/i, "Referral from Friend/Family"],
  [/flyer|advert|\bad\b|mail|billboard/i, "Flyer/Advertisement"],
  [/facebook|instagram|social|tiktok|twitter|nextdoor|youtube/i, "Social Media"],
  [/yellow pages/i, "Yellow Pages"],
];

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

function blank(): Interpretation {
  return { intent: "answer", updates: {}, changeField: null, acknowledgement: "", followUpQuestion: null };
}

/** Rule-based fallback used when AI is off, declined, or unreachable. */
export function localInterpret(step: string, utterance: string, options: VoiceOptions): Interpretation {
  const text = utterance.trim();
  const out = blank();
  if (!text) return { ...out, intent: "unclear" };
  if (REPEAT.test(text)) return { ...out, intent: "repeat" };
  if (/\b(password|passcode|pin number|credit card|card number|social security|cvv)\b/i.test(text)) {
    return { ...out, intent: "sensitive" };
  }

  if (step === "ready" || step.startsWith("confirm:")) {
    if (YES.test(text) || (step === "confirm:submit" && SUBMIT.test(text) && !/\b(don't|do not)\b/i.test(text))) {
      return { ...out, intent: "yes" };
    }
    if (NO.test(text)) {
      // "No, it's 954 555 0199" corrects in the same breath.
      if (step === "confirm:phoneNumber") {
        const d = spokenDigits(text);
        if (d.length >= 10) return { ...out, intent: "change", updates: { phoneNumber: d } };
      }
      if (step === "confirm:emailAddress" && /\bat\b|@/.test(text)) {
        const email = spokenEmailToAddress(text.replace(NO, ""));
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ...out, intent: "change", updates: { emailAddress: email } };
      }
      return { ...out, intent: "no" };
    }
    return { ...out, intent: "unclear" };
  }

  // Review asks "would you like to make any changes?": yes = wants changes,
  // no = no changes. Only an explicit "submit" approves sending; a bare "no"
  // leads to a separate "shall I submit?" confirmation.
  if (step === "review") {
    const field = changeFieldFromText(text);
    if (field) return { ...out, intent: "change", changeField: field };
    if (/\b(don't|do not|not yet|wait|hold on)\b/i.test(text)) return { ...out, intent: "yes" };
    if (SUBMIT.test(text)) return { ...out, intent: "submit" };
    if (NO_CHANGES.test(text) || NO.test(text)) return { ...out, intent: "no" };
    if (YES.test(text)) return { ...out, intent: "yes" };
    return { ...out, intent: "unclear" };
  }

  // Short replies only: "I don't know why, it just shuts off" is an answer.
  if (SKIP.test(text) && text.split(/\s+/).length <= 5) {
    // "Not sure" is a real answer for the operating system: the form offers "Other".
    if (step === "operatingSystem" && options.operatingSystem.includes("Other")) {
      return { ...out, updates: { operatingSystem: "Other" }, acknowledgement: "No problem, I'll mark it as Other and our technician can check." };
    }
    return { ...out, intent: "skip" };
  }

  switch (step) {
    case "customerName": {
      const name = stripLead(text, /^(my name is|my name's|this is|it's|it is|i am|i'm|name is)\s+/i);
      if (name.length >= 2) out.updates.customerName = titleCase(name);
      break;
    }
    case "companyName": {
      if (NO.test(text)) return { ...out, intent: "skip" };
      const company = stripLead(text, /^(yes,?\s*)?(it's|it is|the company is|company is|it's for|for|we are|we're)\s+/i);
      if (company) out.updates.companyName = company;
      break;
    }
    case "phoneNumber": {
      const d = spokenDigits(text);
      if (d.length >= 10 && d.length <= 15) out.updates.phoneNumber = d;
      break;
    }
    case "emailAddress": {
      const email = spokenEmailToAddress(text);
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) out.updates.emailAddress = email;
      break;
    }
    case "contactPreference": {
      if (/\btext|sms|messag/i.test(text)) out.updates.contactPreference = "text";
      else if (/e-?mail/i.test(text)) out.updates.contactPreference = "email";
      else if (/call|phone|ring/i.test(text)) out.updates.contactPreference = "call";
      break;
    }
    case "deviceType": {
      const type = matchOption(text, DEVICE_RULES, options.deviceType);
      if (type) out.updates.deviceType = type;
      const brand = text.match(/\b(dell|hp|lenovo|asus|acer|apple|macbook|imac|microsoft surface|surface|msi|samsung|toshiba|sony|gateway|alienware)\b/i)?.[0];
      if (brand) out.updates.deviceBrandModel = titleCase(brand.toLowerCase());
      break;
    }
    case "deviceBrandModel": {
      const model = stripLead(text, /^(it's|it is|it's an?|it is an?|an?)\s+/i);
      if (model) out.updates.deviceBrandModel = model;
      break;
    }
    case "operatingSystem": {
      const os = matchOption(text, OS_RULES, options.operatingSystem);
      if (os) out.updates.operatingSystem = os;
      break;
    }
    case "problemDescription":
      out.updates.problemDetail = text;
      break;
    case "serviceId": {
      const lower = text.toLowerCase();
      const ordinal = ORDINALS.findIndex((o) => lower.includes(`${o} one`) || lower === o);
      const byOrdinal = ordinal >= 0 ? options.services[ordinal] : undefined;
      const byName = options.services.find((s) => lower.includes(s.name.toLowerCase()))
        ?? bestWordOverlap(lower, options.services);
      const service = byOrdinal ?? byName;
      if (service) out.updates.serviceId = service.id;
      break;
    }
    case "streetAddress": {
      const zip = text.match(/\b\d{5}\b(?!.*\b\d{5}\b)/)?.[0];
      const street = text.replace(zip ?? "", "").replace(/[,.\s]+$/, "").trim();
      if (street) out.updates.streetAddress = street;
      if (zip) out.updates.zip = zip;
      break;
    }
    case "howDidYouHear": {
      out.updates.howDidYouHear = matchOption(text, HEARD_RULES, options.howDidYouHear)
        ?? (options.howDidYouHear.includes("Other") ? "Other" : undefined);
      break;
    }
  }
  if (Object.values(out.updates).every((v) => v === undefined)) return { ...out, updates: {}, intent: "unclear" };
  return out;
}

function bestWordOverlap(text: string, services: { id: number; name: string }[]) {
  const words = new Set(text.split(/\W+/).filter((w) => w.length > 3));
  let best: { id: number; name: string } | undefined;
  let bestScore = 0;
  for (const s of services) {
    const score = s.name.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && words.has(w)).length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

const CHANGE_WORDS: [RegExp, VoiceField][] = [
  [/\bemail/i, "emailAddress"],
  [/\bphone|number/i, "phoneNumber"],
  [/\bname\b/i, "customerName"],
  [/\bcompany|business/i, "companyName"],
  [/\baddress/i, "streetAddress"],
  [/\bcontact|reach me/i, "contactPreference"],
  [/\bbrand|model/i, "deviceBrandModel"],
  [/\bdevice|computer type|laptop|desktop/i, "deviceType"],
  [/\boperating|windows|mac\b/i, "operatingSystem"],
  [/\bproblem|issue|description/i, "problemDescription"],
  [/\bservice/i, "serviceId"],
  [/\bheard|hear about/i, "howDidYouHear"],
];

export function changeFieldFromText(text: string): VoiceField | null {
  if (!/\b(change|fix|update|correct|edit|wrong|different)\b/i.test(text)) return null;
  for (const [re, field] of CHANGE_WORDS) if (re.test(text)) return field;
  return null;
}

// ---------- applying answers to the form ----------

/**
 * Converts interpreted updates into form field writes. The problem
 * description accumulates details across answers (unless the customer is
 * replacing it), so a follow-up never erases what they said earlier.
 */
export function formWrites(
  updates: VoiceUpdates,
  current: { problemDescription?: string },
  replaceProblem: boolean,
): Record<string, string | number> {
  const writes: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === "" || key === "problemDetail") continue;
    writes[key] = value as string | number;
  }
  const detail = updates.problemDetail?.trim();
  if (detail) {
    const existing = (current.problemDescription ?? "").trim();
    writes.problemDescription = replaceProblem || !existing
      ? detail
      : existing.toLowerCase().includes(detail.toLowerCase()) ? existing : `${existing}${/[.!?]$/.test(existing) ? "" : "."} ${detail}`;
  }
  return writes;
}

export function firstName(fullName: string | undefined): string | undefined {
  const first = fullName?.trim().split(/\s+/)[0];
  return first && first.length > 1 ? first : undefined;
}
