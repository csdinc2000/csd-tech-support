// Normalize a US phone number to E.164 (+1XXXXXXXXXX) so providers accept it.
export function toE164(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;
}

// Return a canonical, plausible E.164 number without silently removing
// letters, extra plus signs, or other malformed international input.
export function toValidE164(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || !/^\+?[\d\s().-]+$/.test(trimmed)) return null;

  const normalized = toE164(trimmed);
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

export function invalidContactPhone(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  for (const [field, label] of [
    ["mobilePhone", "Mobile phone"],
    ["officePhone", "Office phone"],
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = (body as Record<string, unknown>)[field];
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) continue;
    if (typeof value !== "string" || !toValidE164(value)) {
      return `${label} must be a valid phone number`;
    }
  }
  return null;
}

export function assertValidContactPhones(body: unknown): void {
  const error = invalidContactPhone(body);
  if (error) throw new Error(error);
}