import Anthropic from "@anthropic-ai/sdk";

// One Anthropic client for the whole API (voice intake, CyberScan, sales
// agents, ARIA). Features stay off when ANTHROPIC_API_KEY is unset.

let anthropic: Anthropic | null | undefined;

export function getAnthropicClient(): Anthropic | null {
  if (anthropic !== undefined) return anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  anthropic = key ? new Anthropic({ apiKey: key }) : null;
  return anthropic;
}

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
