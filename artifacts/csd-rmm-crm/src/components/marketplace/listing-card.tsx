import { Link } from "wouter";
import { Cpu, HardDrive, ImageOff, MapPin, MemoryStick, Monitor, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { categoryLabel, conditionLabel, formatPrice, imageUrl, specChips, timeAgo, type PublicListing } from "@/lib/marketplace";

type Props = {
  listing: PublicListing;
  onClick?: () => void;
  href?: string;
  className?: string;
};

const CHIP_ICON = { cpu: Cpu, gpu: Monitor, ram: MemoryStick, storage: HardDrive } as const;

// OfferUp-style card in the cyber theme: 4:3 cover, laser-red price pill,
// terminal badges, quick-view spec chips.
export default function ListingCard({ listing, onClick, href, className }: Props) {
  const cover = imageUrl(listing.coverImageId);
  const sold = listing.status === "sold";
  const chips = specChips(listing.specs).slice(0, 4);
  const body = (
    <>
      <div className="relative aspect-[4/3] bg-zinc-950 overflow-hidden">
        {cover ? (
          <img src={cover} alt={listing.title} loading="lazy" className={cn("h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]", sold && "opacity-60 grayscale")} />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-zinc-700"><ImageOff className="h-8 w-8" /></div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent" />
        <span className={cn(
          "absolute bottom-2 left-2 rounded-md px-2.5 py-1 text-sm font-black tracking-tight text-white",
          sold ? "bg-zinc-800 border border-zinc-600" : "bg-red-600 glow-red",
        )}>
          {sold ? "SOLD" : formatPrice(listing.priceCents)}
        </span>
        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
          <span className="term-badge bg-black/75 text-zinc-200 border-zinc-500/60">{conditionLabel(listing.condition)}</span>
          {listing.verified && (
            <span className="term-badge bg-black/75 text-emerald-400 border-emerald-500/60 flex items-center gap-1" title="Listed by Computer Systems Depot staff">
              <ShieldCheck className="h-3 w-3" /> Rig verified
            </span>
          )}
        </div>
      </div>
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-red-500">{categoryLabel(listing.category)}</p>
          <span className="text-[10px] font-mono text-zinc-500">{timeAgo(listing.publishedAt ?? listing.createdAt)}</span>
        </div>
        <h3 className="mt-1 text-sm font-semibold text-white line-clamp-2 leading-snug">{listing.title}</h3>
        {chips.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1" aria-label="Specs">
            {chips.map((c) => {
              const Icon = CHIP_ICON[c.key];
              return (
                <li key={c.key} className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[11px] font-mono text-zinc-300">
                  <Icon className="h-3 w-3 text-red-500" />{c.value}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
          <span className="flex items-center gap-1 truncate">
            {listing.location ? <><MapPin className="h-3 w-3 text-zinc-600" />{listing.location}</> : listing.sellerName}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-red-400 opacity-0 group-hover:opacity-100 transition">VIEW →</span>
        </div>
      </div>
    </>
  );
  const classes = cn(
    "group block w-full text-left cyber-panel cyber-panel-hover rounded-xl overflow-hidden",
    className,
  );
  if (href) return <Link href={href} className={classes} data-testid={`card-listing-${listing.id}`}>{body}</Link>;
  return <button type="button" onClick={onClick} className={classes} data-testid={`card-listing-${listing.id}`}>{body}</button>;
}
