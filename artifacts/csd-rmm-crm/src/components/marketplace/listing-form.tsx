import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, Check, Cpu, ImagePlus, Loader2, Rocket, UserRound, X } from "lucide-react";
import CyberScan from "@/components/marketplace/cyber-scan";
import WindowsSpecsPaste from "@/components/marketplace/windows-specs-paste";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CONDITIONS,
  MAX_LISTING_PHOTOS,
  PHOTO_MAX_EDGE,
  PHOTO_TARGET_BYTES,
  compressPhoto,
  imageUrl,
  type FullListing,
  type ListingSpecs,
  type MarketplaceCategory,
  type MarketplaceCondition,
  type PendingPhoto,
  type ScanResult,
  suggestedAskingPrice,
} from "@/lib/marketplace";
import type { WindowsSpecs } from "@/lib/windows-specs";

const inputDark = "bg-zinc-950 border-zinc-800 text-white placeholder:text-zinc-500 focus-visible:ring-red-500";
const selectDark = "bg-zinc-950 border-zinc-800 text-white focus:ring-red-500";
const outlineDark = "border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-white";

export type ListingFormValues = {
  title: string;
  description: string;
  category: MarketplaceCategory;
  condition: MarketplaceCondition;
  price: string;
  specs: Required<ListingSpecs>;
  location: string;
  sellerName: string;
  sellerEmail: string;
  sellerPhone: string;
  showPhone: boolean;
};

export type ListingSubmitPayload = Omit<ListingFormValues, "price"> & {
  price: number;
  images: Array<{ dataBase64: string }>;
  addImages: Array<{ dataBase64: string }>;
  removeImageIds: number[];
};

const EMPTY: ListingFormValues = {
  title: "",
  description: "",
  category: "gaming_pc",
  condition: "good",
  price: "",
  specs: { cpu: "", gpu: "", ram: "", storage: "", os: "" },
  location: "",
  sellerName: "",
  sellerEmail: "",
  sellerPhone: "",
  showPhone: false,
};

function fromListing(listing: FullListing): ListingFormValues {
  return {
    title: listing.title,
    description: listing.description,
    category: listing.category,
    condition: listing.condition,
    price: String(listing.priceCents / 100),
    specs: {
      cpu: listing.specs?.cpu ?? "",
      gpu: listing.specs?.gpu ?? "",
      ram: listing.specs?.ram ?? "",
      storage: listing.specs?.storage ?? "",
      os: listing.specs?.os ?? "",
    },
    location: listing.location ?? "",
    sellerName: listing.sellerName,
    sellerEmail: listing.sellerEmail,
    sellerPhone: listing.sellerPhone ?? "",
    showPhone: listing.showPhone,
  };
}

type Props = {
  /** Who is filling this in — changes the wording around the seller section. */
  audience: "seller" | "staff";
  initial?: FullListing;
  submitting?: boolean;
  submitLabel: string;
  requirePhoto?: boolean;
  /** `funnel`: 3 animated steps (Identify → Details → Contact) for new sellers. `flat`: everything on one page (edit / staff). */
  layout?: "funnel" | "flat";
  onSubmit: (payload: ListingSubmitPayload) => void;
  onCancel?: () => void;
};

const STEPS = [
  { key: "identify", label: "Identify", icon: Cpu, blurb: "Scan or type the model" },
  { key: "details", label: "Details", icon: Camera, blurb: "Price, condition, photos" },
  { key: "contact", label: "Launch", icon: Rocket, blurb: "How buyers reach you" },
] as const;

function Field({ label, hint, children, className, synced }: { label: string; hint?: string; children: React.ReactNode; className?: string; synced?: boolean }) {
  return (
    <label className={cn("block", className)}>
      <span className="text-sm font-medium text-zinc-100">{label}</span>
      {hint && <span className="ml-1 text-xs text-zinc-500">{hint}</span>}
      {synced && <span className="ml-2 term-badge text-emerald-400 border-emerald-500/60 bg-emerald-950/40 align-middle">Synced</span>}
      <div className="mt-1 rounded-md" data-synced={synced ? "true" : undefined}>{children}</div>
    </label>
  );
}

function Stepper({ step, onJump }: { step: number; onJump: (i: number) => void }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3" data-testid="funnel-stepper" aria-label="Listing steps">
      {STEPS.map((s, i) => {
        const state = i < step ? "done" : i === step ? "active" : "todo";
        const Icon = s.icon;
        return (
          <li key={s.key} className={cn("flex items-center gap-2 sm:gap-3", i < STEPS.length - 1 && "flex-1")}>
            <button
              type="button"
              onClick={() => i < step && onJump(i)}
              disabled={i > step}
              data-state={state}
              data-testid={`step-${s.key}`}
              className={cn(
                "step-node flex items-center gap-2 rounded-full border pl-1 pr-3 py-1 text-left",
                state === "active" && "border-red-500 bg-red-600 text-white",
                state === "done" && "border-emerald-500/60 bg-zinc-950 text-emerald-300 hover:border-emerald-400",
                state === "todo" && "border-zinc-800 bg-zinc-950 text-zinc-500",
              )}
            >
              <span className={cn("flex h-7 w-7 items-center justify-center rounded-full font-mono text-[11px] font-bold",
                state === "active" ? "bg-white text-red-600" : state === "done" ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-900 text-zinc-500")}>
                {state === "done" ? <Check className="h-3.5 w-3.5" /> : `0${i + 1}`}
              </span>
              <span className="hidden sm:block leading-tight">
                <span className="block text-xs font-semibold uppercase tracking-[0.15em]">{s.label}</span>
                <span className={cn("block text-[10px]", state === "active" ? "text-red-100" : "text-zinc-500")}>{s.blurb}</span>
              </span>
              <Icon className="h-3.5 w-3.5 sm:hidden" />
            </button>
            {i < STEPS.length - 1 && <div className="step-line flex-1" style={{ ["--fill" as string]: i < step ? 1 : 0 }} />}
          </li>
        );
      })}
    </ol>
  );
}

export default function ListingForm({ audience, initial, submitting, submitLabel, requirePhoto = true, layout = "flat", onSubmit, onCancel }: Props) {
  const funnel = layout === "funnel";
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<ListingFormValues>(initial ? fromListing(initial) : EMPTY);
  const [existingImageIds, setExistingImageIds] = useState<number[]>(initial?.imageIds ?? []);
  const [removedImageIds, setRemovedImageIds] = useState<number[]>([]);
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  // Fields CyberScan filled — they carry a "Synced" tag and play the
  // "Decoded & Synced" pulse when they mount (so specs pulse when the seller
  // reaches the Details step). Editing a field clears its tag.
  const [synced, setSynced] = useState<Set<string>>(new Set());
  const [scanned, setScanned] = useState(false);
  const [pricing, setPricing] = useState<ScanResult["pricing"]>(null);
  // Title the scan wrote — a later candidate pick may overwrite it, but never
  // a title the seller typed.
  const scanTitle = useRef<string | null>(null);
  const unsync = (key: string) => setSynced((prev) => { if (!prev.has(key)) return prev; const next = new Set(prev); next.delete(key); return next; });

  const set = <K extends keyof ListingFormValues>(key: K, value: ListingFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    unsync(key);
  };
  const setSpec = (key: keyof ListingSpecs, value: string) => {
    setValues((v) => ({ ...v, specs: { ...v.specs, [key]: value } }));
    unsync(`specs.${key}`);
  };

  const photoCount = existingImageIds.length + pending.length;

  // Pure w.r.t. React state: decisions are made from the rendered `values`,
  // not inside the updater (StrictMode runs updaters twice).
  const applyScan = (scan: ScanResult) => {
    const touched = new Set<string>();
    const v = values;
    const next = { ...v, specs: { ...v.specs } };
    // Title / category / description are only filled when the seller hasn't
    // typed their own yet; specs always update — that's what the scan is for.
    const titleIsOurs = !v.title.trim() || v.title === scanTitle.current;
    if (scan.title && titleIsOurs) { next.title = scan.title; scanTitle.current = scan.title; touched.add("title"); }
    if (scan.category && (v.category === EMPTY.category || titleIsOurs)) { next.category = scan.category; touched.add("category"); }
    if (scan.descriptionHook && !v.description.trim()) { next.description = scan.descriptionHook + "\n\n"; touched.add("description"); }
    for (const key of ["cpu", "gpu", "ram", "storage", "os"] as const) {
      if (scan.specs[key]) { next.specs[key] = scan.specs[key]; touched.add(`specs.${key}`); }
    }
    const ask = suggestedAskingPrice(scan.pricing);
    if (ask && !v.price.trim()) { next.price = String(ask); touched.add("price"); }
    setValues(next);
    if (scan.pricing) setPricing(scan.pricing);
    setError(null);
    setScanned(true);
    setSynced((prev) => new Set([...prev, ...touched]));
  };
  // Specs pasted from the Windows one-liner: same "Synced" treatment as a
  // scan, but only the spec matrix is touched.
  const applySpecs = (specs: WindowsSpecs) => {
    const touched: string[] = [];
    const next = { ...values.specs };
    for (const key of ["cpu", "gpu", "ram", "storage", "os"] as const) {
      if (specs[key]) { next[key] = specs[key]; touched.push(`specs.${key}`); }
    }
    setValues((v) => ({ ...v, specs: next }));
    setSynced((prev) => new Set([...prev, ...touched]));
    setError(null);
  };
  const isSynced = (key: string) => synced.has(key);

  const addFiles = async (files: FileList | File[]) => {
    setError(null);
    const list = Array.from(files);
    const room = MAX_LISTING_PHOTOS - photoCount;
    if (list.length > room) setError(`You can add ${room} more photo${room === 1 ? "" : "s"} (max ${MAX_LISTING_PHOTOS}).`);
    setProcessing(true);
    try {
      for (const file of list.slice(0, Math.max(0, room))) {
        try {
          const photo = await compressPhoto(file);
          setPending((p) => [...p, photo]);
        } catch (e) {
          setError(e instanceof Error ? e.message : "A photo could not be added");
        }
      }
    } finally {
      setProcessing(false);
      if (fileInput.current) fileInput.current.value = "";
      if (cameraInput.current) cameraInput.current.value = "";
    }
  };

  const removeExisting = (id: number) => {
    setExistingImageIds((ids) => ids.filter((x) => x !== id));
    setRemovedImageIds((ids) => [...ids, id]);
  };

  // ---- validation, split by step so the funnel can gate "Next" ----
  const validateIdentify = () => {
    if (!values.title.trim() || values.title.trim().length < 4) return "Give your listing a title (at least 4 characters) — or scan the label and we'll write one.";
    return null;
  };
  const validateDetails = () => {
    const price = Number(values.price);
    if (!Number.isFinite(price) || price < 0 || values.price.trim() === "") return "Enter an asking price (use 0 for free).";
    if (!values.description.trim() || values.description.trim().length < 10) return "Add a short description (at least 10 characters).";
    if (requirePhoto && photoCount === 0) return "Add at least one photo so buyers can see the item.";
    return null;
  };
  const validateContact = () => {
    if (!values.sellerName.trim()) return "Seller name is required.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.sellerEmail.trim())) return "Enter a valid seller email — the manage link is sent there.";
    return null;
  };

  const goNext = () => {
    const problem = step === 0 ? validateIdentify() : validateDetails();
    if (problem) { setError(problem); return; }
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const goBack = () => { setError(null); setStep((s) => Math.max(s - 1, 0)); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (funnel && step < STEPS.length - 1) { goNext(); return; }
    const problem = validateIdentify() ?? validateDetails() ?? validateContact();
    if (problem) { setError(problem); return; }
    onSubmit({
      ...values,
      price: Number(values.price),
      images: pending.map((p) => ({ dataBase64: p.dataBase64 })),
      addImages: pending.map((p) => ({ dataBase64: p.dataBase64 })),
      removeImageIds: removedImageIds,
    });
  };

  // ---- sections ----

  const identifySection = (
    <section className="space-y-5" data-testid="section-identify">
      <CyberScan
        hero={funnel}
        disabled={submitting}
        onDetected={applyScan}
        onUsePhoto={(photo) => { if (photoCount < MAX_LISTING_PHOTOS) setPending((p) => [...p, photo]); }}
      />
      <div className={cn("grid gap-4 sm:grid-cols-[1fr_220px]", funnel && "cyber-panel rounded-xl p-4 sm:p-5")}>
        <Field label="Listing title" hint={scanned ? "auto-written from the scan — tweak it if you like" : "e.g. RTX 4070 gaming PC, Ryzen 7"} synced={isSynced("title")}>
          <Input value={values.title} maxLength={120} onChange={(e) => set("title", e.target.value)} className={cn(inputDark, "h-11 text-base")} data-testid="input-title" />
        </Field>
        <Field label="Category" synced={isSynced("category")}>
          <Select value={values.category} onValueChange={(v) => set("category", v as MarketplaceCategory)}>
            <SelectTrigger className={cn(selectDark, "h-11")} data-testid="select-category"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MARKETPLACE_CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </section>
  );

  const specsPanel = (
    <div className="cyber-panel rounded-lg p-4" data-testid="spec-matrix-form">
      <p className="text-sm font-medium text-white flex items-center gap-2"><Cpu className="h-4 w-4 text-red-500" /> Hardware spec matrix <span className="text-xs font-normal text-zinc-500">(optional, but buyers love them)</span></p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {([
          ["cpu", "Processor — e.g. Intel i7-13700K", ""],
          ["gpu", "Graphics — e.g. RTX 4070 12GB", ""],
          ["ram", "Memory — e.g. 32GB DDR5", ""],
          ["storage", "Storage — e.g. 1TB NVMe SSD", ""],
          ["os", "Operating system — e.g. Windows 11 Pro", "sm:col-span-2"],
        ] as const).map(([key, placeholder, extra]) => (
          <div key={key} className={cn("relative rounded-md", extra)} data-synced={isSynced(`specs.${key}`) ? "true" : undefined}>
            <Input placeholder={placeholder} value={values.specs[key]} onChange={(e) => setSpec(key, e.target.value)} className={cn(inputDark, isSynced(`specs.${key}`) && "pr-20")} data-testid={`input-spec-${key}`} />
            {isSynced(`specs.${key}`) && <span className="term-badge pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-emerald-400 border-emerald-500/60 bg-zinc-950">Synced</span>}
          </div>
        ))}
      </div>
      <WindowsSpecsPaste onSpecs={applySpecs} disabled={submitting} />
    </div>
  );

  const photosSection = (
    <section data-testid="section-photos">
      <h3 className="text-base font-semibold text-white flex items-center gap-2">
        <Camera className="h-4 w-4 text-red-500" /> Photos
        <span className="font-mono text-[11px] font-normal uppercase tracking-wider text-zinc-500">{photoCount}/{MAX_LISTING_PHOTOS} · first photo is the cover</span>
      </h3>
      <div className="mt-3 grid grid-cols-3 sm:grid-cols-4 gap-3">
        {existingImageIds.map((id) => (
          <div key={`e-${id}`} className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
            <img src={imageUrl(id) ?? ""} alt="" className="h-full w-full object-cover" />
            <button type="button" onClick={() => removeExisting(id)} aria-label="Remove photo"
              className="absolute top-1 right-1 rounded-full bg-black/70 border border-zinc-600 p-1 text-white hover:bg-red-600 hover:border-red-500">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {pending.map((p) => (
          <div key={p.id} className="funnel-rise relative aspect-square rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
            <img src={p.previewUrl} alt="" className="h-full w-full object-cover" />
            <button type="button" onClick={() => setPending((list) => list.filter((x) => x.id !== p.id))} aria-label="Remove photo"
              className="absolute top-1 right-1 rounded-full bg-black/70 border border-zinc-600 p-1 text-white hover:bg-red-600 hover:border-red-500">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {photoCount < MAX_LISTING_PHOTOS && (
          <>
            <button
              type="button"
              onClick={() => cameraInput.current?.click()}
              disabled={processing}
              data-testid="button-take-photo"
              className="aspect-square rounded-lg border-2 border-dashed border-red-500/60 bg-red-950/30 text-red-400 hover:border-red-500 hover:bg-red-950/60 hover:text-red-300 flex flex-col items-center justify-center gap-1 text-xs font-semibold transition disabled:opacity-60"
            >
              {processing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
              {processing ? "Preparing…" : "Take a photo"}
            </button>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={processing}
              data-testid="button-add-photos"
              className="aspect-square rounded-lg border-2 border-dashed border-zinc-700 text-zinc-400 hover:border-red-500 hover:text-red-400 flex flex-col items-center justify-center gap-1 text-xs font-medium transition disabled:opacity-60"
            >
              <ImagePlus className="h-5 w-5" />
              Choose from gallery
            </button>
          </>
        )}
      </div>
      {/* `capture` opens the rear camera straight away on phones and tablets; desktop browsers fall back to a file picker. */}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files && addFiles(e.target.files)} data-testid="input-photo-camera" />
      <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} data-testid="input-photo-gallery" />
      <p className="mt-2 text-xs text-zinc-500">
        JPG, PNG or WebP. Every photo is shrunk to {PHOTO_MAX_EDGE}px and about {Math.round(PHOTO_TARGET_BYTES / 1024)} KB on your device before upload, so listing from a phone is quick.
        {pending.length > 0 && <> Ready to upload: {Math.round(pending.reduce((n, p) => n + p.sizeBytes, 0) / 1024)} KB total.</>}
      </p>
    </section>
  );

  const detailsSection = (
    <section className="space-y-5" data-testid="section-details">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Asking price ($)" hint={pricing ? `going rate used: $${pricing.low.toLocaleString()}–$${pricing.high.toLocaleString()}` : undefined} synced={isSynced("price")}>
          <Input type="number" min={0} step="1" inputMode="decimal" value={values.price} onChange={(e) => set("price", e.target.value)} placeholder="0 = free" className={cn(inputDark, "h-11 text-lg font-semibold")} data-testid="input-price" />
        </Field>
        <Field label="Condition">
          <Select value={values.condition} onValueChange={(v) => set("condition", v as MarketplaceCondition)}>
            <SelectTrigger className={cn(selectDark, "h-11")} data-testid="select-condition"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MARKETPLACE_CONDITIONS.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label} <span className="text-zinc-500">— {c.hint}</span></SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {specsPanel}
      <Field label="Description" hint="what's included, how it's been used, anything a buyer should know" synced={isSynced("description")}>
        <Textarea rows={5} maxLength={4000} value={values.description} onChange={(e) => set("description", e.target.value)} className={inputDark} data-testid="input-description" />
      </Field>
      <Field label="Pickup area" hint="city or neighborhood — never your street address">
        <Input value={values.location} maxLength={80} placeholder="e.g. Lauderhill, FL" onChange={(e) => set("location", e.target.value)} className={inputDark} />
      </Field>
      {photosSection}
    </section>
  );

  const contactSection = (
    <section className="space-y-4" data-testid="section-contact">
      <h3 className="text-base font-semibold text-white flex items-center gap-2"><UserRound className="h-4 w-4 text-red-500" /> {audience === "staff" ? "Seller (the customer)" : "Your contact info"}</h3>
      <p className="text-sm text-zinc-400">
        {audience === "staff"
          ? "The customer receives an email with a private link to edit or remove their listing. Buyers contact them through the marketplace — their email is never shown."
          : "Buyers message you through the marketplace and we forward it to your email. Your email address is never shown publicly."}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={audience === "staff" ? "Customer name" : "Your name"}>
          <Input value={values.sellerName} maxLength={100} onChange={(e) => set("sellerName", e.target.value)} className={inputDark} data-testid="input-seller-name" />
        </Field>
        <Field label={audience === "staff" ? "Customer email" : "Your email"}>
          <Input type="email" value={values.sellerEmail} maxLength={200} onChange={(e) => set("sellerEmail", e.target.value)} className={inputDark} data-testid="input-seller-email" />
        </Field>
        <Field label="Phone" hint="optional">
          <Input type="tel" value={values.sellerPhone} maxLength={40} onChange={(e) => set("sellerPhone", e.target.value)} placeholder="(954) 000-0000" className={inputDark} />
        </Field>
        <label className="flex items-start gap-3 cyber-panel rounded-lg p-3 sm:mt-6">
          <Checkbox checked={values.showPhone} onCheckedChange={(v) => set("showPhone", v === true)} className="mt-0.5 border-zinc-600 data-[state=checked]:bg-red-600 data-[state=checked]:border-red-600" />
          <span className="text-sm text-zinc-300">Show the phone number on the listing so buyers get 1-click <span className="text-white">Call</span> and <span className="text-white">Text</span> buttons</span>
        </label>
      </div>
    </section>
  );

  // Launch summary shown on the last funnel step so the seller sees what goes live.
  const launchSummary = funnel && (
    <div className="hud cyber-panel rounded-xl p-4 sm:p-5" data-testid="launch-summary">
      <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">Pre-flight</p>
      <p className="mt-1 text-lg font-bold text-white">{values.title || "Untitled listing"}</p>
      <p className="font-mono text-sm text-red-400">{values.price ? `$${Number(values.price).toLocaleString()}` : "Price not set"} · {MARKETPLACE_CATEGORIES.find((c) => c.value === values.category)?.label} · {MARKETPLACE_CONDITIONS.find((c) => c.value === values.condition)?.label}</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {(["cpu", "gpu", "ram", "storage"] as const).filter((k) => values.specs[k]).map((k) => (
          <li key={k} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-300">{values.specs[k]}</li>
        ))}
        <li className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-300">{photoCount} photo{photoCount === 1 ? "" : "s"}</li>
      </ul>
    </div>
  );

  const errorBox = error && <p className="funnel-rise text-sm text-red-200 rounded-md bg-red-950/50 border border-red-500/50 p-3" data-testid="text-form-error">{error}</p>;

  if (funnel) {
    return (
      <form onSubmit={submit} className="space-y-6" data-testid="form-marketplace-listing" data-step={STEPS[step].key}>
        <Stepper step={step} onJump={(i) => { setError(null); setStep(i); }} />
        <div key={step} className="funnel-enter space-y-6">
          {step === 0 && identifySection}
          {step === 1 && detailsSection}
          {step === 2 && <>{launchSummary}{contactSection}</>}
        </div>
        {errorBox}
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-zinc-800">
          <div className="flex gap-2">
            {step > 0 && (
              <Button type="button" variant="outline" onClick={goBack} className={outlineDark} data-testid="button-back">
                <ArrowLeft className="h-4 w-4 mr-2" /> Back
              </Button>
            )}
            {onCancel && step === 0 && <Button type="button" variant="ghost" onClick={onCancel} className="text-zinc-400 hover:text-white hover:bg-zinc-800">Cancel</Button>}
          </div>
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={goNext} disabled={processing} className="bg-red-600 hover:bg-red-500 glow-red font-semibold h-11 px-6" data-testid="button-next">
              Continue to {STEPS[step + 1].label} <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          ) : (
            <Button type="submit" disabled={submitting || processing} className="bg-red-600 hover:bg-red-500 glow-red-strong font-semibold h-11 px-6" data-testid="button-submit-listing">
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
              {submitLabel}
            </Button>
          )}
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-8" data-testid="form-marketplace-listing">
      {identifySection}
      {detailsSection}
      {contactSection}
      {errorBox}
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-2">
        {onCancel && <Button type="button" variant="outline" onClick={onCancel} className={outlineDark}>Cancel</Button>}
        <Button type="submit" disabled={submitting || processing} className="bg-red-600 hover:bg-red-500 glow-red font-semibold" data-testid="button-submit-listing">
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
