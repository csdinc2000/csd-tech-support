export interface BusinessCardData {
  name: string;
  firstName: string | null;
  lastName: string | null;
  title: string;
  headline: string | null;
  email: string | null;
  directPhone: string | null;
  photoUrl: string | null;
  company: { name: string; phone: string | null; email: string | null; website: string; accentColor: "red" | "navy" };
  cardUrl: string;
  vcardUrl: string;
  bookingUrl: string;
}

export interface MyBusinessCard {
  token: string;
  settings: { headline: string | null; showEmail: boolean; showDirectPhone: boolean };
  hasDirectPhone: boolean;
  card: BusinessCardData;
  emailAvailable: boolean;
}

/** US-friendly E.164: "(954) 555-0101" -> "+19545550101". Returns null when it can't be a phone number. */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "+19545550101" -> "(954) 555-0101"; anything else is shown as entered. */
export function formatPhone(phone: string): string {
  const e164 = toE164(phone);
  const us = e164?.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone;
}

export function telHref(phone: string): string {
  return `tel:${toE164(phone) ?? phone.replace(/[^\d+]/g, "")}`;
}

export function cardSmsBody(card: BusinessCardData, recipientName?: string): string {
  const hello = recipientName?.trim() ? `Hi ${recipientName.trim()}, ` : "Hi, ";
  return `${hello}this is ${card.name} from ${card.company.name}. Here's my contact card so you can reach me any time: ${card.cardUrl}`;
}
