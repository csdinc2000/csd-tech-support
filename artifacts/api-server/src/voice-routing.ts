import twilio from "twilio";
import { toValidE164 } from "./phone-validation";

const MAIN_BUSINESS_LINE = "+19546377300";

export function isMainBusinessLine(to: string): boolean {
  return toValidE164(to) === MAIN_BUSINESS_LINE;
}

export function appendMainLineGreeting(response: twilio.twiml.VoiceResponse, to: string) {
  if (isMainBusinessLine(to)) {
    response.say({ voice: "alice" }, "Computer Systems Depot");
  }
}

export function configuredForwardTargets(settings: {
  forwardToNumber?: string | null; backupForwardNumber?: string | null; backupForwardNumber2?: string | null;
}) {
  const seen = new Set<string>();
  return [
    { key: "primary", number: settings.forwardToNumber },
    { key: "backup1", number: settings.backupForwardNumber },
    { key: "backup2", number: settings.backupForwardNumber2 },
  ].flatMap(target => {
    const number = toValidE164(target.number || "");
    if (!number || seen.has(number)) return [];
    seen.add(number);
    return [{ key: target.key, number }];
  });
}

export function forwardedCallerId(from: string, to: string, showOriginal: boolean) {
  return (showOriginal ? toValidE164(from) : null) ?? toValidE164(to) ?? undefined;
}

export function wasDialAnswered(status: string, bridged: string | undefined, screened: boolean): boolean {
  return (status === "completed" || status === "answered") && (!screened || bridged === "true");
}

// Keep database or notification stalls below Twilio's webhook timeout.
export async function withVoiceRoutingDeadline<T>(operation: Promise<T>, timeoutMs = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Voice routing timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function emergencyVoiceResponse(base: string, to: string) {
  const response = new twilio.twiml.VoiceResponse();
  appendMainLineGreeting(response, to || MAIN_BUSINESS_LINE);
  response.say({ voice: "alice" }, "We are unable to connect your call right now. Please leave a message after the tone.");
  response.record({
    action: `${base}/webhooks/voice/voicemail-recorded`,
    method: "POST",
    maxLength: 120,
    playBeep: true,
    finishOnKey: "#",
  });
  response.hangup();
  return response.toString();
}