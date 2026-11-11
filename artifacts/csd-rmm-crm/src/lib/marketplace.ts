// Shared types, labels and helpers for the Community Marketplace (customer
// portal + staff admin). Mirrors the enums in api-server/src/marketplace.ts.

export const MARKETPLACE_CATEGORIES = [
  { value: "gaming_pc", label: "Gaming PC" },
  { value: "desktop", label: "Desktop" },
  { value: "laptop", label: "Laptop" },
  { value: "parts", label: "Parts & Components" },
  { value: "monitor", label: "Monitors" },
  { value: "accessories", label: "Accessories" },
  { value: "other", label: "Other" },
] as const;

export const MARKETPLACE_CONDITIONS = [
  { value: "new", label: "Brand new", hint: "Sealed or never used" },
  { value: "like_new", label: "Like new", hint: "Barely used, no visible wear" },
  { value: "good", label: "Good", hint: "Works great, light wear" },
  { value: "fair", label: "Fair", hint: "Works, noticeable wear" },
  { value: "for_parts", label: "For parts", hint: "Not fully working" },
] as const;

export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number]["value"];
export type MarketplaceCondition = (typeof MARKETPLACE_CONDITIONS)[number]["value"];
export type MarketplaceStatus = "pending" | "active" | "sold" | "rejected" | "removed";

export const MAX_LISTING_PHOTOS = 8;

export type ListingSpecs = { cpu?: string; gpu?: string; ram?: string; storage?: string; os?: string };

export type PublicListing = {
  id: number;
  title: string;
  description: string;
  category: MarketplaceCategory;
  condition: MarketplaceCondition;
  priceCents: number;
  specs: ListingSpecs;
  location: string;
  sellerName: string;
  sellerPhone: string | null;
  status: MarketplaceStatus;
  /** Posted by CSD staff on the seller's behalf. */
  verified: boolean;
  imageIds: number[];
  coverImageId: number | null;
  publishedAt: string | null;
  soldAt: string | null;
  createdAt: string;
  viewCount: number;
};

export type FullListing = PublicListing & {
  sellerEmail: string;
  sellerPhone: string;
  showPhone: boolean;
  source: "portal" | "staff";
  reviewNote: string | null;
  reviewedAt: string | null;
  createdByUserId: string | null;
  updatedAt: string;
  inquiryCount: number;
};

export type ListingInquiry = {
  id: number;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string | null;
  message: string;
  createdAt: string;
};

export const STATUS_LABELS: Record<MarketplaceStatus, string> = {
  pending: "Pending review",
  active: "Active",
  sold: "Sold",
  rejected: "Needs changes",
  removed: "Removed",
};

export function categoryLabel(value: string): string {
  return MARKETPLACE_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

export function conditionLabel(value: string): string {
  return MARKETPLACE_CONDITIONS.find((c) => c.value === value)?.label ?? value;
}

export function formatPrice(cents: number): string {
  if (cents === 0) return "Free";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function imageUrl(id: number | null | undefined): string | null {
  return id ? `/api/portal/marketplace/images/${id}` : null;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Short chips for the card grid: "i7-13700K", "RTX 4070", "32GB", "1TB". */
export type SpecChipKey = "cpu" | "gpu" | "ram" | "storage";

export function specChips(specs: ListingSpecs | null | undefined): Array<{ key: SpecChipKey; value: string }> {
  if (!specs) return [];
  const short = (key: SpecChipKey, v: string) => {
    let t = v.trim();
    if (key === "cpu") t = t.replace(/^(Intel|AMD)\s*/i, "").replace(/^Core\s*/i, "");
    if (key === "gpu") t = t.replace(/^(NVIDIA|AMD|Intel)\s*/i, "").replace(/^(GeForce|Radeon)\s*/i, "").replace(/\s*\d{1,2}\s*GB$/i, "");
    if (key === "ram") t = t.replace(/\s*(DDR\d\S*|RAM|memory).*$/i, "");
    if (key === "storage") t = t.replace(/\s*(PCIe.*|NVMe.*|SSD.*|HDD.*|M\.2.*)$/i, "");
    return t;
  };
  return (["cpu", "gpu", "ram", "storage"] as const)
    .filter((key) => specs[key]?.trim())
    .map((key) => ({ key, value: short(key, specs[key]!) }));
}

export function specEntries(specs: ListingSpecs | null | undefined): Array<{ label: string; value: string }> {
  if (!specs) return [];
  const labels: Record<keyof ListingSpecs, string> = { cpu: "Processor", gpu: "Graphics", ram: "Memory", storage: "Storage", os: "Operating system" };
  return (Object.keys(labels) as Array<keyof ListingSpecs>)
    .filter((key) => specs[key]?.trim())
    .map((key) => ({ label: labels[key], value: specs[key]!.trim() }));
}

// ---------------------------------------------------------------------------
// Photo handling — photos (camera or gallery) are downscaled and re-encoded in
// the browser before upload so a 12 MB phone photo becomes ~100 KB. WebP is
// used where the browser can encode it (Chrome, Edge, Firefox, Android);
// Safari silently ignores the WebP request, so we detect that and fall back
// to JPEG. The longest edge is capped at PHOTO_MAX_EDGE (plenty for a
// 4-column card grid and the detail gallery) and the quality is stepped down
// until the file fits PHOTO_TARGET_BYTES. The server rejects anything over
// 1.5 MB.
// ---------------------------------------------------------------------------

export type PendingPhoto = { id: string; previewUrl: string; dataBase64: string; sizeBytes: number; mimeType: string };

export const PHOTO_MAX_EDGE = 1024;
export const PHOTO_TARGET_BYTES = 160 * 1024;
const PHOTO_MIN_EDGE = 640;
const QUALITY_START = 0.8;
const QUALITY_MIN = 0.45;
const QUALITY_STEP = 0.1;

export type EncodeOptions = {
  maxEdge?: number;
  /** Byte budget; omit to encode once at `quality` without stepping down. */
  targetBytes?: number | null;
  quality?: number;
};

// CyberScan sends a sharper frame than a listing photo — small label text
// has to survive — but still well under the server's 1.5 MB cap.
export const SCAN_ENCODE: EncodeOptions = { maxEdge: 1600, targetBytes: null, quality: 0.86 };

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      // Camera photos carry an EXIF orientation; honour it so portrait shots
      // don't upload sideways.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the <img> path (some browsers can't decode certain formats via createImageBitmap).
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unsupported")); };
    img.src = url;
  });
}

let webpSupported: boolean | null = null;

// Encode as WebP when the browser really produces WebP; otherwise JPEG.
async function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  if (webpSupported !== false) {
    const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (webp && webp.type === "image/webp") { webpSupported = true; return webp; }
    webpSupported = false;
  }
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// Re-encode at decreasing quality until the file fits the byte budget. Busy
// photos (a desk full of cables) need a lower quality than a laptop on a
// white table, so a fixed quality would either bloat or over-crush them. If
// the quality floor still overshoots, shrink the canvas and try again, down
// to PHOTO_MIN_EDGE.
async function encodeUnderBudget(canvas: HTMLCanvasElement, targetBytes: number, startQuality: number): Promise<Blob> {
  let best: Blob | null = null;
  for (;;) {
    for (let q = startQuality; q >= QUALITY_MIN - 1e-6; q -= QUALITY_STEP) {
      const blob = await toBlob(canvas, q);
      if (!blob) break;
      best = blob;
      if (blob.size <= targetBytes) return blob;
    }
    const edge = Math.max(canvas.width, canvas.height);
    if (edge <= PHOTO_MIN_EDGE) break;
    const scale = Math.max(PHOTO_MIN_EDGE / edge, 0.8);
    const smaller = document.createElement("canvas");
    smaller.width = Math.max(1, Math.round(canvas.width * scale));
    smaller.height = Math.max(1, Math.round(canvas.height * scale));
    smaller.getContext("2d")!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    canvas = smaller;
  }
  if (!best) throw new Error("Your browser could not process the photo");
  return best;
}

export async function compressPhoto(file: File, options: EncodeOptions = {}): Promise<PendingPhoto> {
  const maxEdge = options.maxEdge ?? PHOTO_MAX_EDGE;
  const targetBytes = options.targetBytes === undefined ? PHOTO_TARGET_BYTES : options.targetBytes;
  const quality = options.quality ?? QUALITY_START;
  if (!file.type.startsWith("image/") && !/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) {
    throw new Error(`"${file.name}" is not an image`);
  }
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await loadBitmap(file);
  } catch {
    throw new Error(`"${file.name}" could not be opened. Try a JPG or PNG photo.`);
  }
  const width = "naturalWidth" in source ? source.naturalWidth : source.width;
  const height = "naturalHeight" in source ? source.naturalHeight : source.height;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not process the photo");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ("close" in source) source.close();
  const blob = targetBytes ? await encodeUnderBudget(canvas, targetBytes, quality) : await toBlob(canvas, quality);
  if (!blob) throw new Error("Your browser could not process the photo");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read photo"));
    reader.readAsDataURL(blob);
  });
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    previewUrl: dataUrl,
    dataBase64: dataUrl.split(",")[1] ?? "",
    sizeBytes: blob.size,
    mimeType: blob.type,
  };
}

// ---------------------------------------------------------------------------
// CyberScan — POST a label photo, get listing suggestions back. Mirrors
// `ScanResult` in api-server/src/marketplace-scan.ts.
// ---------------------------------------------------------------------------

export type ScanResult = {
  detected: boolean;
  confidence: "high" | "medium" | "low";
  brand: string;
  model: string;
  deviceType: "laptop" | "desktop" | "gpu" | "cpu" | "component" | "monitor" | "unknown";
  category: MarketplaceCategory;
  title: string;
  specs: Required<ListingSpecs>;
  descriptionHook: string;
  identifiers: { serviceTag?: string; serialNumber?: string; partNumber?: string };
  rawText: string;
  summary: string;
  releaseYear: string;
  /** Estimated used market value (USD) for a working unit in good condition. */
  pricing: { low: number; high: number; basis: string } | null;
  /** Common factory configurations when the query didn't pin one down. */
  candidates: Array<{ label: string; specs: Required<ListingSpecs> }>;
  /** Answer was grounded with a web search rather than model memory alone. */
  grounded: boolean;
};

/** Middle of the estimated range, rounded to a "clean" asking price. */
export function suggestedAskingPrice(pricing: ScanResult["pricing"]): number | null {
  if (!pricing) return null;
  const mid = (pricing.low + pricing.high) / 2;
  const step = mid >= 1000 ? 50 : mid >= 200 ? 25 : 5;
  return Math.round(mid / step) * step;
}
