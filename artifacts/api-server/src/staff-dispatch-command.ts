export type StaffSmsCommand =
  | { kind: "claim" | "status" | "close"; ticketNumber: string }
  | { kind: "client"; ticketNumber: string; message: string }
  | { kind: "plain" }
  | { kind: "invalid" };

export function normalizeDispatchPhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export function parseStaffSmsCommand(input: string): StaffSmsCommand {
  const text = input.trim();
  let match = /^(CLAIM|STATUS|CLOSE)\s+([A-Z0-9]+(?:-[A-Z0-9]+)*)$/i.exec(text);
  if (match) return { kind: match[1].toLowerCase() as "claim" | "status" | "close", ticketNumber: match[2].toUpperCase() };
  match = /^CLIENT\s+([A-Z0-9]+(?:-[A-Z0-9]+)*)\s*:\s*(\S[\s\S]*)$/i.exec(text);
  if (match) return { kind: "client", ticketNumber: match[1].toUpperCase(), message: match[2].trim() };
  if (/^(CLAIM|STATUS|CLOSE|CLIENT)\b/i.test(text)) return { kind: "invalid" };
  return { kind: "plain" };
}

export function isAuthorizedDispatchPhone(
  input: string,
  recipients: Array<{ phone: string; enabled: boolean; onDuty: boolean; canUseCommands: boolean }>,
): boolean {
  const phone = normalizeDispatchPhone(input);
  return recipients.some(
    (recipient) =>
      recipient.phone === phone &&
      recipient.enabled &&
      recipient.onDuty &&
      recipient.canUseCommands,
  );
}