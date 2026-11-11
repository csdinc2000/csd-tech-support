import { useState } from "react";
import { ChevronLeft, ChevronRight, Cpu, Eye, HardDrive, ImageOff, MapPin, MemoryStick, Monitor, MonitorCog, ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  categoryLabel,
  conditionLabel,
  formatPrice,
  imageUrl,
  specEntries,
  timeAgo,
  STATUS_LABELS,
  type ListingSpecs,
  type PublicListing,
} from "@/lib/marketplace";

export function ListingGallery({ imageIds, title }: { imageIds: number[]; title: string }) {
  const [index, setIndex] = useState(0);
  const current = imageIds[index] ?? null;
  if (!imageIds.length) {
    return (
      <div className="aspect-[4/3] rounded-xl cyber-panel flex items-center justify-center text-zinc-700">
        <ImageOff className="h-10 w-10" />
      </div>
    );
  }
  const go = (delta: number) => setIndex((i) => (i + delta + imageIds.length) % imageIds.length);
  return (
    <div>
      <div className="relative aspect-[4/3] rounded-xl bg-black border border-zinc-800 overflow-hidden">
        <img src={imageUrl(current) ?? ""} alt={title} className="h-full w-full object-contain" />
        {imageIds.length > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="Previous photo" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-zinc-700 bg-black/70 p-2 text-white hover:border-red-500 hover:bg-red-600 transition">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button type="button" onClick={() => go(1)} aria-label="Next photo" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-zinc-700 bg-black/70 p-2 text-white hover:border-red-500 hover:bg-red-600 transition">
              <ChevronRight className="h-5 w-5" />
            </button>
            <span className="absolute bottom-2 right-2 term-badge bg-black/75 text-zinc-300 border-zinc-600">{index + 1} / {imageIds.length}</span>
          </>
        )}
      </div>
      {imageIds.length > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {imageIds.map((id, i) => (
            <button key={id} type="button" onClick={() => setIndex(i)} aria-label={`Photo ${i + 1}`}
              className={cn("h-16 w-16 shrink-0 rounded-md overflow-hidden border-2 transition", i === index ? "border-red-500 glow-red" : "border-zinc-800 hover:border-zinc-500")}>
              <img src={imageUrl(id) ?? ""} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Terminal-style [STATUS: ACTIVE] badge. */
export function StatusBadge({ status }: { status: PublicListing["status"] }) {
  // Solid dark chip so it reads the same on the dark marketplace and inside
  // the light staff drawer.
  const styles: Record<PublicListing["status"], string> = {
    pending: "text-amber-400 border-amber-500/70 bg-zinc-950",
    active: "text-emerald-400 border-emerald-500/70 bg-zinc-950",
    sold: "text-zinc-300 border-zinc-500 bg-zinc-950",
    rejected: "text-red-400 border-red-500/70 bg-zinc-950",
    removed: "text-zinc-400 border-zinc-600 bg-zinc-950",
  };
  return (
    <span className={cn("term-badge inline-flex items-center gap-1.5", styles[status])} data-testid="badge-status">
      {status === "active" && <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot" />}
      Status: {STATUS_LABELS[status]}
    </span>
  );
}

const SPEC_ICON: Record<string, typeof Cpu> = { Processor: Cpu, Graphics: Monitor, Memory: MemoryStick, Storage: HardDrive, "Operating system": MonitorCog };

/** Spec matrix — shared by the detail page and the seller's manage view. */
export function SpecMatrix({ specs }: { specs: ListingSpecs | null | undefined }) {
  const entries = specEntries(specs);
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="spec-matrix">
      {entries.map((s) => {
        const Icon = SPEC_ICON[s.label] ?? Cpu;
        return (
          <div key={s.label} className="cyber-panel rounded-lg p-3 flex items-start gap-3 sm:last:odd:col-span-2">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-red-500/40 bg-red-600/10 text-red-500"><Icon className="h-3.5 w-3.5" /></span>
            <div className="min-w-0">
              <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">{s.label}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-white break-words">{s.value}</dd>
            </div>
          </div>
        );
      })}
    </dl>
  );
}

/** Read-only listing body — used by the public detail page and the seller's manage page. */
export function ListingSummary({ listing, showStatus = false, showViews = false }: { listing: PublicListing; showStatus?: boolean; showViews?: boolean }) {
  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-red-500">{categoryLabel(listing.category)}</span>
          <span className="term-badge text-zinc-300 border-zinc-600 bg-zinc-900">{conditionLabel(listing.condition)}</span>
          {listing.verified && <span className="term-badge text-emerald-400 border-emerald-500/60 bg-emerald-950/40 inline-flex items-center gap-1" title="Listed by Computer Systems Depot staff"><ShieldCheck className="h-3 w-3" /> Rig verified</span>}
          {showStatus && <StatusBadge status={listing.status} />}
        </div>
        <h1 className="mt-2 text-2xl sm:text-3xl font-black tracking-tight text-white leading-tight">{listing.title}</h1>
        <div className="mt-2 flex items-baseline gap-3">
          <span className={cn("text-4xl font-black tracking-tight", listing.status === "sold" ? "text-zinc-500 line-through" : "text-red-500 text-glow-red")}>{formatPrice(listing.priceCents)}</span>
          {listing.status === "sold" && <span className="term-badge text-zinc-300 border-zinc-500">Sold</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-400">
          {listing.location && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 text-zinc-500" />{listing.location}</span>}
          <span>Listed {timeAgo(listing.publishedAt ?? listing.createdAt)}</span>
          {showViews && <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5 text-zinc-500" />{listing.viewCount} views</span>}
        </div>
      </div>

      <SpecMatrix specs={listing.specs} />

      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">Description</h2>
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-200 leading-relaxed">{listing.description}</p>
      </div>
    </div>
  );
}

export function SafetyNote() {
  return (
    <div className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-400">
      <ShieldAlert className="h-4 w-4 shrink-0 text-red-500" />
      <p>
        Free peer-to-peer community listing between customers. Computer Systems Depot is not part of the sale —
        meet in a safe public place, <span className="text-zinc-200">verify the hardware before paying</span>, and never send deposits. Want a tech to
        bench-test it first? Call 954-637-7300.
      </p>
    </div>
  );
}
