---
name: Aria AI provider health
description: How the Aria AI assistant selects LLM providers and why pinned model ids and single-provider reliance break it.
---

# Aria AI provider health

The Aria assistant (`server/aria-service.ts`) supports three providers — Claude
(Anthropic), ChatGPT (OpenAI), Gemini (Google) — each with a **pinned, dated
model id** in `MODEL_CONFIGS`.

## Rule
- Pinned dated model ids go stale. Anthropic in particular deprecates dated ids
  on a roughly yearly cadence; once past end-of-life the id returns **404
  not_found** even though the API key is valid and the client initializes fine.
- Any user-facing surface (especially the public support chatbot `supportChat()`)
  must **fall back across providers**, not trust a single default.

**Why:** In this repl all three can fail independently at once — Claude on a
deprecated model id (404), OpenAI on an invalid/rotated key (401), Gemini on
free-tier quota (429, `limit: 0`). A single-provider default returns a 500 to
the customer. A provider-ordered try/catch loop keeps the widget working as long
as *any one* provider is healthy.

**How to apply:**
- Keep model ids current — when a provider logs a deprecation warning, bump the
  id (e.g. `claude-sonnet-4-20250514` → `claude-sonnet-4-5-20250929`).
- Client "initialized" in boot logs only means the key was present, NOT that the
  model id resolves. Verify with a live request.
- For public/customer chat, iterate configured providers and return the first
  success; only 500 if all fail.
