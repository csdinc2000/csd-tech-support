import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, isAnthropicConfigured } from "./anthropic-client";
import type { z } from "zod/v4";
import { logger } from "./lib/logger";

/**
 * Shared Claude access for the sales agents (Lead Generation Agent, Lead
 * Research Sales Copilot, Executive Assistant briefing).
 *
 * Responses are asked for as a single JSON object and validated with Zod, so a
 * malformed answer is rejected instead of being written to the CRM. Web search
 * is optional per call and can be disabled globally with SALES_AI_WEB_SEARCH=0.
 */

export const SALES_AI_MODEL = process.env.SALES_AI_MODEL || "claude-opus-5-5";
const SALES_AI_EFFORT = (process.env.SALES_AI_EFFORT as "low" | "medium" | "high" | undefined) || "medium";
const WEB_SEARCH_ENABLED = process.env.SALES_AI_WEB_SEARCH !== "0";

const client = getAnthropicClient;

export function isSalesAiConfigured(): boolean {
  return isAnthropicConfigured();
}

export function isSalesWebSearchEnabled(): boolean {
  return WEB_SEARCH_ENABLED;
}

/** Last balanced-looking `{...}` span in the text, parsed. Null if absent or invalid. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Public http(s) URLs cited by web search results in a response, deduplicated. */
function citedUrls(response: Anthropic.Message): string[] {
  const urls = new Set<string>();
  for (const block of response.content as any[]) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const item of block.content) if (typeof item?.url === "string") urls.add(item.url);
    }
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) if (typeof c?.url === "string") urls.add(c.url);
    }
  }
  return [...urls].filter((u) => /^https?:\/\//i.test(u)).slice(0, 40);
}

export type SalesAiResult<T> = { data: T; grounded: boolean; sources: string[]; model: string };

export class SalesAiUnavailableError extends Error {
  constructor() { super("AI is not configured. Set ANTHROPIC_API_KEY to enable the sales agents."); }
}

/**
 * One model call that must end in a JSON object matching `schema`.
 * `webSearches` > 0 lets the model research the public web first.
 */
export async function runSalesAi<S extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: S;
  webSearches?: number;
  maxTokens?: number;
}): Promise<SalesAiResult<z.infer<S>>> {
  const api = client();
  if (!api) throw new SalesAiUnavailableError();
  const searches = WEB_SEARCH_ENABLED ? Math.max(0, Math.min(opts.webSearches ?? 0, 10)) : 0;
  const response = await api.messages.create({
    model: SALES_AI_MODEL,
    max_tokens: opts.maxTokens ?? 8000,
    output_config: { effort: SALES_AI_EFFORT },
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    tools: searches ? [{ type: "web_search_20260209", name: "web_search", max_uses: searches }] : [],
    messages: [{ role: "user", content: opts.prompt }],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const parsed = opts.schema.safeParse(extractJsonObject(text));
  if (!parsed.success) {
    logger.warn({ stop: response.stop_reason, issues: parsed.error.issues.slice(0, 5) }, "sales-ai: response did not match schema");
    throw new Error("The AI response could not be understood. Please try again.");
  }
  return {
    data: parsed.data,
    grounded: response.content.some((b) => b.type === "web_search_tool_result"),
    sources: citedUrls(response),
    model: SALES_AI_MODEL,
  };
}

/** Strip control characters and clamp length before text goes into a prompt. */
export function promptSafe(value: unknown, max = 2000): string {
  if (value == null) return "";
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, max);
}
