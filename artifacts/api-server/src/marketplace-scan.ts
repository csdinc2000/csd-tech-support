import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./lib/logger";

// ---------------------------------------------------------------------------
// "CyberScan" — turns a photo of a laptop sticker, service tag, GPU box or
// motherboard label into a pre-filled listing. Two layers:
//
//   1. Vision: Claude reads the label and returns what it sees (brand, model,
//      specs, raw text). Best effort — labels are blurry, partial, rotated.
//   2. Regex: `parseHardwareText` runs over the raw text (and over the vision
//      output) to pin down CPU / GPU / RAM / storage strings in a canonical
//      form and to recognise vendor part numbers the model may not decode
//      (EVGA "08G-P5-3755", Gigabyte "GV-N3070GAMING OC-8GD", Dell service
//      tags, Lenovo type codes …).
//
// The merged result is a suggestion the seller can edit — nothing is saved
// until they submit the form.
// ---------------------------------------------------------------------------

export type ScanCategory = "gaming_pc" | "desktop" | "laptop" | "parts" | "monitor" | "accessories" | "other";

export type HardwareSpecs = { cpu: string; gpu: string; ram: string; storage: string; os: string };

export type ScanResult = {
  /** True when at least one identifying field was found. */
  detected: boolean;
  confidence: "high" | "medium" | "low";
  brand: string;
  model: string;
  deviceType: "laptop" | "desktop" | "gpu" | "cpu" | "component" | "monitor" | "unknown";
  category: ScanCategory;
  title: string;
  specs: HardwareSpecs;
  descriptionHook: string;
  identifiers: { serviceTag?: string; serialNumber?: string; partNumber?: string };
  rawText: string;
  /** One plain-English line about the product ("2021 16-inch gaming laptop, Ryzen 7 + RTX 3070"). */
  summary: string;
  releaseYear: string;
  /** Estimated used market value in USD for a working unit in good condition, or null when unknown. */
  pricing: { low: number; high: number; basis: string } | null;
  /** When a model line shipped in several configurations, the common ones — the seller picks. */
  candidates: Array<{ label: string; specs: HardwareSpecs }>;
  /** Whether the answer was grounded with a web search (vs. model memory / regex only). */
  grounded: boolean;
};

// ---------- regex layer ----------

const EMPTY_SPECS: HardwareSpecs = { cpu: "", gpu: "", ram: "", storage: "", os: "" };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

// Intel: "Core i7-13700K", "i5 12400F", "Core Ultra 7 155H", "Core i9-14900HX".
const INTEL_CORE = /\b(?:intel\s*)?(?:core\s*)?(i[3579])[\s-]*(\d{4,5})([A-Z]{0,3})\b/i;
const INTEL_ULTRA = /\b(?:intel\s*)?core\s*ultra\s*([579])[\s-]*(\d{3})([A-Z]{0,2})\b/i;
// AMD: "Ryzen 7 7800X3D", "Ryzen 5 5600X", "Ryzen 9 7940HS", "Ryzen AI 9 HX 370".
const AMD_RYZEN = /\b(?:amd\s*)?ryzen\s*([3579])\s*(?:pro\s*)?[\s-]*(\d{4})\s*(X3D|X|G|GE|H|HS|HX|U|F)?\b/i;
const AMD_RYZEN_AI = /\b(?:amd\s*)?ryzen\s*ai\s*([579])\s*(HX\s*)?(\d{3})\b/i;
// NVIDIA: "RTX 3070", "GeForce RTX 4070 Ti Super", "GTX 1660 Super", "RTX 4090".
const NVIDIA = /\b(?:geforce\s*)?(RTX|GTX)\s*[\s-]*(\d{3,4})\s*(Ti\s*Super|Super|Ti)?\b/i;
// AMD Radeon: "RX 6700 XT", "Radeon RX 7900 XTX".
const RADEON = /\b(?:radeon\s*)?RX\s*[\s-]*(\d{3,4})\s*(XTX|XT|GRE)?\b/i;
// Intel Arc: "Arc A770", "Arc B580".
const ARC = /\barc\s*([AB]\d{3})\b/i;
// Vendor GPU part numbers.
const GIGABYTE_PN = /\bGV-(N|R)(\d{4})([A-Z]*)[- ]?([A-Z ]*?)-?(\d{1,2})GD?\b/i; // GV-N3070GAMING OC-8GD
const EVGA_PN = /\b(\d{2})G-P5-(\d{2})(\d{2})-[A-Z]{2}\b/i; // 08G-P5-3755-KR → 8GB, RTX 30 series, 3070
// Memory / storage.
const RAM = /\b(\d{1,3})\s*GB\s*(?:of\s*)?((?:LP)?DDR[345][A-Z]?(?:[\s-]*\d{4})?)?\s*(RAM|memory|SDRAM|SODIMM)?\b/gi;
const STORAGE = /\b(\d{3,4}\s*GB|\d(?:\.\d)?\s*TB)\s*((?:PCIe\s*(?:Gen\s*)?\d?\s*)?(?:NVMe|SSD|HDD|M\.2|eMMC)(?:\s*SSD)?)\b/i;
const OS = /\b(Windows\s*(?:11|10)\s*(?:Pro|Home|Enterprise)?|macOS(?:\s*[A-Z][a-z]+)?|Ubuntu(?:\s*\d{2}\.\d{2})?|ChromeOS|Chrome OS)\b/i;
// Vendor identifiers.
const DELL_SERVICE_TAG = /\b(?:service\s*tag|s\/?t|ST)\s*[:#]?\s*([A-Z0-9]{7})\b/i;
const DELL_EXPRESS = /\bexpress\s*service\s*code\s*[:#]?\s*(\d{10,11})\b/i;
const LENOVO_TYPE = /\b(?:type|MTM?)\s*[:#]?\s*(\d{2}[A-Z0-9]{2}[A-Z0-9]{0,6})\b/i;
const HP_PRODUCT = /\b(?:product(?:\s*no|\s*number|\s*#|\s*id)?|P\/N)\s*[:#]?\s*([A-Z0-9]{6,7}#[A-Z]{3})\b/i;
const SERIAL = /\b(?:serial(?:\s*no|\s*number|\s*#)?|S\/N|SN)\s*[:#]?\s*([A-Z0-9]{7,20})\b/i;

const BRANDS = [
  "Lenovo", "Dell", "Alienware", "HP", "ASUS", "Acer", "MSI", "Razer", "Apple", "Samsung", "Microsoft", "Gigabyte", "EVGA",
  "Zotac", "PNY", "Sapphire", "XFX", "PowerColor", "Corsair", "CyberPowerPC", "iBUYPOWER", "Origin", "NZXT", "Framework", "LG", "Toshiba",
];
const LAPTOP_LINES = /\b(Legion|IdeaPad|ThinkPad|ThinkBook|Yoga|XPS|Inspiron|Latitude|Precision|Vostro|Omen|Pavilion|Envy|Victus|EliteBook|ProBook|Spectre|ZBook|ROG\s*(?:Zephyrus|Strix|Flow)|TUF\s*(?:Gaming|Dash)?|Zenbook|Vivobook|Predator|Nitro|Aspire|Swift|Katana|Raider|Stealth|Titan|Blade|MacBook\s*(?:Pro|Air)?|Surface\s*(?:Laptop|Book)|Galaxy\s*Book|Chromebook)\b/i;
const DESKTOP_LINES = /\b(Aurora|Optiplex|Precision\s*Tower|Vostro\s*Desktop|Omen\s*(?:25L|30L|40L|45L)|Pavilion\s*Gaming\s*Desktop|Victus\s*15L|ROG\s*Strix\s*G\d{2}|Predator\s*Orion|Nitro\s*\d{2}|Aegis|Trident|MEG|Codex|Gamer\s*Xtreme|Gamer\s*Supreme|Trace|Slate|Mac\s*(?:mini|Studio|Pro)|iMac|Aurora\s*R\d{1,2})\b/i;
const MONITOR = /\b(\d{2}(?:\.\d)?["”]?\s*(?:inch|in\b|monitor)|(?:1080p|1440p|2160p|4K)\s*(?:monitor|display)|(?:144|165|240|360)\s*Hz)\b/i;

export type ParsedHardware = Pick<ScanResult, "brand" | "model" | "deviceType" | "specs" | "identifiers" | "rawText">;

export function parseHardwareText(input: string): ParsedHardware {
  const text = clean(input);
  const specs: HardwareSpecs = { ...EMPTY_SPECS };
  const identifiers: ScanResult["identifiers"] = {};
  let brand = "";
  let model = "";
  let deviceType: ScanResult["deviceType"] = "unknown";

  const ultra = text.match(INTEL_ULTRA);
  const core = text.match(INTEL_CORE);
  const ryzenAi = text.match(AMD_RYZEN_AI);
  const ryzen = text.match(AMD_RYZEN);
  if (ultra) specs.cpu = `Intel Core Ultra ${ultra[1]} ${ultra[2]}${ultra[3].toUpperCase()}`;
  else if (core) specs.cpu = `Intel Core ${core[1].toLowerCase()}-${core[2]}${core[3].toUpperCase()}`;
  else if (ryzenAi) specs.cpu = `AMD Ryzen AI ${ryzenAi[1]} ${ryzenAi[2] ? "HX " : ""}${ryzenAi[3]}`;
  else if (ryzen) specs.cpu = `AMD Ryzen ${ryzen[1]} ${ryzen[2]}${(ryzen[3] || "").toUpperCase()}`;

  const nv = text.match(NVIDIA);
  const rx = text.match(RADEON);
  const arc = text.match(ARC);
  const gb = text.match(GIGABYTE_PN);
  const evga = text.match(EVGA_PN);
  if (nv) specs.gpu = `NVIDIA GeForce ${nv[1].toUpperCase()} ${nv[2]}${nv[3] ? " " + nv[3].replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : ""}`;
  else if (gb) {
    const family = gb[1].toUpperCase() === "N" ? "NVIDIA GeForce RTX" : "AMD Radeon RX";
    specs.gpu = `${family} ${gb[2]} ${gb[5]}GB`;
    brand = brand || "Gigabyte";
    identifiers.partNumber = gb[0].toUpperCase();
  } else if (evga) {
    // EVGA: <mem>G-P5-<series><model>: P5 = RTX 30 series, 3755 → 3070, 3897 → 3080 …
    const series = evga[2];
    const models: Record<string, string> = { "36": "3060", "37": "3070", "38": "3080", "39": "3090" };
    const num = models[series];
    if (num) specs.gpu = `NVIDIA GeForce RTX ${num} ${Number(evga[1])}GB`;
    brand = brand || "EVGA";
    identifiers.partNumber = evga[0].toUpperCase();
  } else if (rx) specs.gpu = `AMD Radeon RX ${rx[1]}${rx[2] ? " " + rx[2].toUpperCase() : ""}`;
  else if (arc) specs.gpu = `Intel Arc ${arc[1].toUpperCase()}`;

  // "16GB DDR4" beats a bare "8GB" that is really the GPU's VRAM ("RTX 3070 8GB").
  let ram: { n: number; type: string; score: number } | null = null;
  for (const m of text.matchAll(RAM)) {
    const n = Number(m[1]);
    if (n < 4 || n > 256) continue; // bigger numbers with "GB" are storage
    const before = text.slice(Math.max(0, m.index! - 24), m.index);
    let score = 0;
    if (m[2]) score += 2;
    if (m[3]) score += 2;
    if (/\b(RTX|GTX|RX|Arc\s*[AB]\d{3}|Radeon|GeForce)\b[^\n]*$/i.test(before) && !m[2] && !m[3]) score -= 3;
    if (!ram || score > ram.score) ram = { n, type: m[2] || "", score };
  }
  if (ram && ram.score >= 0) {
    specs.ram = `${ram.n}GB${ram.type ? " " + ram.type.toUpperCase().replace(/\s+/g, "-").replace("DDR-", "DDR") : ""}`;
  }
  const storage = text.match(STORAGE);
  if (storage) specs.storage = `${storage[1].replace(/\s+/g, "")} ${storage[2].replace(/\s+/g, " ").replace(/m\.2/i, "M.2").replace(/nvme/i, "NVMe").replace(/ssd/i, "SSD").replace(/hdd/i, "HDD")}`;
  const os = text.match(OS);
  if (os) specs.os = os[1].replace(/\s+/g, " ").replace(/^macos/i, "macOS").replace(/^chrome ?os$/i, "ChromeOS");

  const tag = text.match(DELL_SERVICE_TAG);
  if (tag) { identifiers.serviceTag = tag[1].toUpperCase(); brand = brand || "Dell"; }
  if (text.match(DELL_EXPRESS)) brand = brand || "Dell";
  const lenovo = text.match(LENOVO_TYPE);
  if (lenovo && /lenovo|thinkpad|legion|ideapad|yoga/i.test(text)) { identifiers.partNumber = identifiers.partNumber || lenovo[1].toUpperCase(); brand = brand || "Lenovo"; }
  const hp = text.match(HP_PRODUCT);
  if (hp) { identifiers.partNumber = identifiers.partNumber || hp[1].toUpperCase(); brand = brand || "HP"; }
  const serial = text.match(SERIAL);
  if (serial) identifiers.serialNumber = serial[1].toUpperCase();

  for (const b of BRANDS) {
    if (new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) { brand = brand || b; break; }
  }

  const laptop = text.match(LAPTOP_LINES);
  const desktop = text.match(DESKTOP_LINES);
  if (desktop) { model = clean(desktop[1]); deviceType = "desktop"; }
  else if (laptop) { model = clean(laptop[1]); deviceType = "laptop"; }
  // A line name plus the trailing model code, e.g. "Legion 5 Pro 16ACH6H" or "XPS 15 9520".
  if (model) {
    const after = text.slice(text.search(new RegExp(model.replace(/\s+/g, "\\s*"), "i")) + model.length).match(/^\s*((?:\d{1,2}[A-Z]?\s*(?:Pro|Plus|Max|Slim|Gaming)?\s*)?[A-Z0-9-]{0,10})/i);
    if (after && after[1].trim()) model = clean(`${model} ${after[1]}`);
  }
  if (deviceType === "unknown") {
    if (/\blaptop|notebook|chromebook|battery|battery\s*capacity/i.test(text)) deviceType = "laptop";
    else if (text.match(MONITOR)) deviceType = "monitor";
    else if (specs.gpu && !specs.cpu && !specs.storage) deviceType = "gpu";
    else if (specs.cpu && !specs.gpu && !specs.storage && !specs.ram) deviceType = "cpu";
    else if (specs.cpu || specs.gpu) deviceType = "desktop";
    else if (specs.ram || specs.storage) deviceType = "component";
  }

  return { brand, model, deviceType, specs, identifiers, rawText: text };
}

// ---------- suggestion building ----------

const shortCpu = (cpu: string) => cpu.replace(/^(Intel|AMD)\s*/i, "").replace(/^Core\s*/i, "");
const shortGpu = (gpu: string) => gpu.replace(/^(NVIDIA|AMD|Intel)\s*/i, "").replace(/^(GeForce|Radeon)\s*/i, "");

export function buildSuggestion(parsed: ParsedHardware): Pick<ScanResult, "title" | "category" | "descriptionHook" | "detected" | "confidence"> {
  const { brand, model, deviceType, specs } = parsed;
  const parts: string[] = [];
  const name = clean(`${brand} ${model}`);
  const highlights = [specs.gpu && shortGpu(specs.gpu), specs.cpu && !specs.gpu && shortCpu(specs.cpu), specs.ram && specs.ram.replace(/\s.*$/, "")].filter(Boolean) as string[];

  let category: ScanCategory = "other";
  switch (deviceType) {
    case "laptop": category = "laptop"; break;
    case "desktop": category = specs.gpu ? "gaming_pc" : "desktop"; break;
    case "gpu": case "cpu": case "component": category = "parts"; break;
    case "monitor": category = "monitor"; break;
    default: category = specs.gpu || specs.cpu ? "parts" : "other";
  }

  if (deviceType === "gpu" && specs.gpu) {
    // "Gigabyte RTX 3070 Gaming OC 8GB" when the vendor model name is known,
    // otherwise "Gigabyte RTX 3070 8GB" / "NVIDIA GeForce RTX 3070".
    const chip = shortGpu(specs.gpu);
    const vendorModel = model && new RegExp(chip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(/\s+/)[1] ?? chip, "i").test(model) ? model : "";
    parts.push(brand && brand !== "NVIDIA" && brand !== "AMD" ? `${brand} ${vendorModel || chip}` : vendorModel || specs.gpu);
  }
  else if (deviceType === "cpu" && specs.cpu) parts.push(specs.cpu);
  else if (name) parts.push(name);
  else if (deviceType === "laptop") parts.push("Gaming Laptop");
  else if (deviceType === "desktop") parts.push(specs.gpu ? "Gaming PC" : "Desktop PC");
  if (highlights.length && deviceType !== "gpu" && deviceType !== "cpu") parts.push(highlights.join(" / "));
  const title = parts.join(" - ").slice(0, 120);

  const detected = Boolean(name || specs.cpu || specs.gpu || specs.ram || specs.storage);
  const score = [brand, model, specs.cpu, specs.gpu, specs.ram, specs.storage].filter(Boolean).length;
  const confidence: ScanResult["confidence"] = score >= 4 ? "high" : score >= 2 ? "medium" : "low";

  let descriptionHook = "";
  if (detected) {
    const specLine = [specs.cpu, specs.gpu, specs.ram && `${specs.ram} RAM`, specs.storage].filter(Boolean).join(", ");
    const subject = name || (deviceType === "gpu" ? specs.gpu : deviceType === "cpu" ? specs.cpu : deviceType === "laptop" ? "this laptop" : "this system");
    const tier = tierLine(specs.gpu);
    descriptionHook = `Factory specs: ${subject}${specLine ? ` featuring ${specLine}` : ""}.${tier ? ` ${tier}` : ""}`;
  }
  return { title, category, descriptionHook, detected, confidence };
}

// A one-liner buyers actually care about, keyed off the GPU generation.
function tierLine(gpu: string): string {
  const m = gpu.match(/(RTX|GTX|RX|Arc)\s*([AB]?\d{3,4})/i);
  if (!m) return "";
  const n = Number(m[2].replace(/\D/g, ""));
  const fam = m[1].toUpperCase();
  const gen = Math.floor(n / 1000); // 3 = RTX 30 series, 4 = 40 series …
  const tier = n % 100; // 60 / 70 / 80 / 90
  if (fam === "RTX" && ((gen >= 4 && tier >= 80) || n === 3090)) return "Handles 4K gaming and heavy creative work with ease.";
  if (fam === "RTX" && gen >= 3 && tier >= 70) return "Excellent rig for 1440p gaming.";
  if (fam === "RTX" || (fam === "RX" && n >= 6600)) return "Great for smooth 1080p gaming and everyday work.";
  if (fam === "GTX") return "Solid for esports titles and everyday use.";
  return "";
}

// ---------- vision layer ----------

export type VisionReader = (image: { dataBase64: string; mimeType: string }) => Promise<VisionReading | null>;

export type VisionReading = {
  rawText?: string;
  brand?: string;
  model?: string;
  deviceType?: ScanResult["deviceType"];
  cpu?: string;
  gpu?: string;
  ram?: string;
  storage?: string;
  os?: string;
  serviceTag?: string;
  serialNumber?: string;
  partNumber?: string;
  summary?: string;
  releaseYear?: string | number;
  usedPriceLowUsd?: number | string;
  usedPriceHighUsd?: number | string;
  priceBasis?: string;
  candidates?: Array<{ label?: string; cpu?: string; gpu?: string; ram?: string; storage?: string; os?: string }>;
  /** Set by the reader, not the model. */
  grounded?: boolean;
};

const SCAN_MODEL = process.env.MARKETPLACE_SCAN_MODEL || "claude-opus-5";
// Web search grounds model-number lookups in current listings / spec pages. Costs
// per search, so it can be switched off; regex + model memory still work.
const WEB_SEARCH = process.env.MARKETPLACE_SCAN_WEB_SEARCH !== "0";

const JSON_FIELDS = `Respond with ONLY a JSON object (no prose, no markdown fences) with these keys:
- rawText: string — echo of the label text / query
- brand, model: strings ("Lenovo", "Legion 5 Pro 16ACH6H")
- deviceType: laptop | desktop | gpu | cpu | component | monitor | unknown
- cpu, gpu, ram, storage, os: marketing names ("Intel Core i7-13700K", "NVIDIA GeForce RTX 3070", "16GB DDR5", "1TB NVMe SSD", "Windows 11 Home")
- serviceTag, serialNumber, partNumber: strings, only when printed / typed
- summary: one plain-English line a buyer understands ("2021 16-inch gaming laptop: Ryzen 7 5800H, RTX 3070, 165 Hz QHD screen")
- releaseYear: string ("2021") or ""
- usedPriceLowUsd, usedPriceHighUsd: numbers — realistic private-party used price range in USD for a working unit in good condition today; 0 when you can't estimate
- priceBasis: short note on the range ("eBay sold listings, mid-2026" / "based on similar RTX 3070 laptops")
- candidates: array of {label, cpu, gpu, ram, storage, os} — when a model line shipped in several configurations and the query didn't pin one down, list the 2-4 most common; otherwise []
Use empty strings / 0 / [] for anything unknown. Never invent a serial number.`;

const VISION_PROMPT = `You are reading a photo of computer hardware or its label for a used-hardware listing: a laptop bottom sticker, a Dell/HP/Lenovo service tag, a GPU box or backplate, a motherboard, a CPU box, a spec sheet, or the device itself.

Transcribe every readable string into "rawText" (one line per label line, keep model codes exactly as printed).
Then identify, only when actually visible or unambiguously implied by a printed model code:
- brand (e.g. Lenovo, Dell, ASUS, MSI, Gigabyte, EVGA)
- model (product line + model, e.g. "Legion 5 Pro 16ACH6H", "XPS 15 9520", "ROG Strix G15", "RTX 3070 Gaming OC")
- deviceType: one of laptop, desktop, gpu, cpu, component, monitor, unknown
- cpu, gpu, ram, storage, os — as marketing names (e.g. "Intel Core i7-13700K", "NVIDIA GeForce RTX 3070", "16GB DDR5", "1TB NVMe SSD", "Windows 11 Home"). If the label prints a model code you know the factory spec for (e.g. Legion 5 Pro 16ACH6H ships with Ryzen 7 5800H + RTX 3070), fill those in.
- serviceTag (Dell 7-char), serialNumber, partNumber (vendor part/product number) when printed.

${JSON_FIELDS}`;

let anthropic: Anthropic | null | undefined;

function client(): Anthropic | null {
  if (anthropic !== undefined) return anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  anthropic = key ? new Anthropic({ apiKey: key }) : null;
  return anthropic;
}

// Pull the JSON object out of a response that may carry search citations or
// stray prose around it. Takes the last balanced {...} in the text.
function extractJson(response: Anthropic.Message): VisionReading | null {
  const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as VisionReading;
  } catch {
    logger.warn({ text: text.slice(0, 300) }, "CyberScan: model response was not JSON");
    return null;
  }
}

export const claudeVisionReader: VisionReader = async ({ dataBase64, mimeType }) => {
  const api = client();
  if (!api) return null;
  const response = await api.messages.create({
    model: SCAN_MODEL,
    max_tokens: 2000,
    output_config: { effort: "medium" },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType as "image/jpeg" | "image/png" | "image/webp", data: dataBase64 } },
        { type: "text", text: VISION_PROMPT },
      ],
    }],
  });
  return extractJson(response) ?? { rawText: "" };
};

// Text-only lookup for the "type a model number" path: "82JQ", "Legion 5 Pro
// 16ACH6H", "XPS 9520", "GV-N3070GAMING OC-8GD", "service tag 7GHJ2M3".
// Regex decodes the part numbers it knows; the model (with web search when
// enabled) expands product codes to the factory config, flags multi-config
// lines, and estimates a used price.
export type TextReader = (query: string) => Promise<VisionReading | null>;

const LOOKUP_SYSTEM = `You identify used computer hardware for a community marketplace run by a repair shop in South Florida. Sellers type whatever is on the label: a model name, a product/part number, a Lenovo type code (82JQ), an HP product number (8L0P7AA#ABA), a Dell service tag or model number (XPS 9520), an ASUS/Acer/MSI model code (FA506IV, N18P), a GPU part number, a CPU name, or a typo-ridden mix of these.

Decode it as precisely as the text allows:
- Vendor product codes map to a specific product line and often a specific configuration — resolve them (a Lenovo type code pins the model line; the full model code like 16ACH6H pins the platform; the factory config still varies).
- Dell service tags cannot be decoded offline — if given only a service tag, return brand "Dell" and leave model empty rather than guessing.
- When the query pins the exact configuration, fill cpu/gpu/ram/storage/os. When the line shipped in several configs, fill only what is certain and list the common configurations under "candidates".
- Estimate the private-party used price range (USD) for a working unit in good condition on today's market. Prefer real recent sold listings when you search; otherwise reason from comparable hardware.
- Use web search sparingly (at most 3 searches): only when you are not confident of the product's configuration or current used price.
${JSON_FIELDS}`;

export const claudeTextReader: TextReader = async (query) => {
  const api = client();
  if (!api) return null;
  const safe = query.replace(/[\u0000-\u001f]/g, " ").slice(0, 200);
  const response = await api.messages.create({
    model: SCAN_MODEL,
    max_tokens: 4000,
    output_config: { effort: (process.env.MARKETPLACE_SCAN_EFFORT as "low" | "medium" | "high" | undefined) || "low" },
    system: [{ type: "text", text: LOOKUP_SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: WEB_SEARCH ? [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] : [],
    messages: [{ role: "user", content: `Model / part / label text typed by the seller:\n\n${safe}` }],
  });
  const grounded = response.content.some((b) => b.type === "web_search_tool_result");
  const reading = extractJson(response);
  return reading ? { ...reading, rawText: query, grounded } : { rawText: query, grounded };
};

// Lookups repeat a lot (the same laptop model is listed again and again), and
// each one is a model call — keep a small in-memory cache per process.
const LOOKUP_CACHE_TTL_MS = 24 * 60 * 60_000;
const LOOKUP_CACHE_MAX = 500;
const lookupCache = new Map<string, { at: number; result: ScanResult }>();

const normalizeQuery = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

export function clearLookupCache(): void {
  lookupCache.clear();
}

export async function lookupHardwareText(query: string, reader: TextReader | null = claudeTextReader): Promise<ScanResult> {
  const key = normalizeQuery(query);
  const cached = lookupCache.get(key);
  if (cached && Date.now() - cached.at < LOOKUP_CACHE_TTL_MS) return cached.result;

  const local = mergeReading({ rawText: query });
  let result = local;
  if (reader) {
    try {
      const reading = await reader(query);
      if (reading) result = mergeReading({ ...reading, rawText: query });
    } catch (error) {
      logger.warn({ error }, "CyberScan: text lookup failed, using regex only");
    }
  }
  // Only cache answers that actually identified something, so a transient
  // model hiccup doesn't pin a "not detected" for a day.
  if (result.detected && reader) {
    if (lookupCache.size >= LOOKUP_CACHE_MAX) lookupCache.delete(lookupCache.keys().next().value!);
    lookupCache.set(key, { at: Date.now(), result });
  }
  return result;
}

export function isVisionConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ---------- merge ----------

const str = (v: unknown) => (typeof v === "string" ? clean(v) : "");

export function mergeReading(reading: VisionReading | null): ScanResult {
  const rawText = str(reading?.rawText);
  // Regex over everything the model returned — raw text plus its own field
  // guesses — so a "GV-N3070GAMING OC-8GD" it transcribed but did not decode
  // still resolves to an RTX 3070.
  const corpus = [rawText, str(reading?.model), str(reading?.cpu), str(reading?.gpu), str(reading?.ram), str(reading?.storage), str(reading?.os)].filter(Boolean).join("\n");
  const parsed = parseHardwareText(corpus);

  const specs: HardwareSpecs = {
    cpu: parsed.specs.cpu || str(reading?.cpu),
    gpu: parsed.specs.gpu || str(reading?.gpu),
    ram: parsed.specs.ram || str(reading?.ram),
    storage: parsed.specs.storage || str(reading?.storage),
    os: parsed.specs.os || str(reading?.os),
  };
  const brand = str(reading?.brand) || parsed.brand;
  const model = str(reading?.model) || parsed.model;
  const visionType = reading?.deviceType;
  const deviceType: ScanResult["deviceType"] = visionType && visionType !== "unknown" ? visionType : parsed.deviceType;
  // A bare graphics card has no system RAM — "8GB GDDR6" is VRAM and belongs in the GPU name.
  if (deviceType === "gpu" && /GDDR|VRAM/i.test(specs.ram)) {
    const vram = specs.ram.match(/\d{1,2}\s*GB/i)?.[0].replace(/\s+/g, "");
    if (vram && specs.gpu && !/\d{1,2}\s*GB/i.test(specs.gpu)) specs.gpu = `${specs.gpu} ${vram}`;
    specs.ram = "";
  }
  const identifiers = {
    serviceTag: str(reading?.serviceTag).toUpperCase() || parsed.identifiers.serviceTag,
    serialNumber: str(reading?.serialNumber).toUpperCase() || parsed.identifiers.serialNumber,
    partNumber: str(reading?.partNumber).toUpperCase() || parsed.identifiers.partNumber,
  };
  for (const k of Object.keys(identifiers) as Array<keyof typeof identifiers>) if (!identifiers[k]) delete identifiers[k];

  const num = (v: unknown) => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
  const low = num(reading?.usedPriceLowUsd);
  const high = num(reading?.usedPriceHighUsd);
  const pricing = low && high && high >= low && high < 100_000 ? { low, high, basis: str(reading?.priceBasis) } : null;
  const candidates = (Array.isArray(reading?.candidates) ? reading!.candidates! : [])
    .map((c) => ({
      label: str(c?.label),
      specs: { cpu: str(c?.cpu), gpu: str(c?.gpu), ram: str(c?.ram), storage: str(c?.storage), os: str(c?.os) },
    }))
    .filter((c) => c.label || Object.values(c.specs).some(Boolean))
    .map((c) => ({ ...c, label: c.label || [c.specs.cpu, c.specs.gpu, c.specs.ram, c.specs.storage].filter(Boolean).join(" · ") }))
    .slice(0, 4);

  const merged = { ...parsed, brand, model, deviceType, specs, identifiers, rawText };
  return {
    ...merged,
    ...buildSuggestion(merged),
    summary: str(reading?.summary),
    releaseYear: reading?.releaseYear ? String(reading.releaseYear).trim().slice(0, 4) : "",
    pricing,
    candidates,
    grounded: Boolean(reading?.grounded),
  };
}

export async function scanHardwareImage(image: { dataBase64: string; mimeType: string }, reader: VisionReader = claudeVisionReader): Promise<ScanResult> {
  const reading = await reader(image);
  return mergeReading(reading);
}
