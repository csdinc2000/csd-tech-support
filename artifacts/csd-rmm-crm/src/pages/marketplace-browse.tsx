import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Package, Radar, Search, SlidersHorizontal, Zap } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import MarketplaceShell from "@/components/marketplace/portal-shell";
import ListingCard from "@/components/marketplace/listing-card";
import { MARKETPLACE_CATEGORIES, type PublicListing } from "@/lib/marketplace";
import { catalogMoney, usePublicCatalog } from "@/hooks/use-catalog";

type Sort = "newest" | "price_asc" | "price_desc";

export default function MarketplaceBrowse() {
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const catalog = usePublicCatalog();

  const query = useQuery<{ listings: PublicListing[] }>({
    queryKey: ["/api/portal/marketplace/listings"],
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // Filter + sort client-side: the feed is capped at 200 listings, so this is
  // instant and keeps the search box responsive without a request per keystroke.
  const listings = useMemo(() => {
    const all = query.data?.listings ?? [];
    const q = search.trim().toLowerCase();
    const filtered = all.filter((l) =>
      (category === "all" || l.category === category) &&
      (!q || l.title.toLowerCase().includes(q) || l.description.toLowerCase().includes(q) || JSON.stringify(l.specs).toLowerCase().includes(q)),
    );
    if (sort === "price_asc") return [...filtered].sort((a, b) => a.priceCents - b.priceCents);
    if (sort === "price_desc") return [...filtered].sort((a, b) => b.priceCents - a.priceCents);
    return filtered;
  }, [query.data, category, search, sort]);

  const liveCount = query.data?.listings.filter((l) => l.status === "active").length ?? 0;

  return (
    <MarketplaceShell>
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-400">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 pulse-dot" />
            System online · {liveCount} live listing{liveCount === 1 ? "" : "s"}
          </p>
          <h1 className="mt-2 text-3xl sm:text-4xl font-black tracking-tight text-white">
            Buy &amp; sell rigs <span className="text-red-500 text-glow-red">locally</span>.
          </h1>
          <p className="mt-1 text-zinc-400">Gaming PCs, laptops and parts from CSD customers. Free to list. Reviewed by our techs.</p>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1 md:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search RTX 4070, i7, laptop…" className="pl-9 bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-500 focus-visible:ring-red-500" data-testid="input-search" />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger className="w-[160px] bg-zinc-900 border-zinc-800 text-zinc-200" data-testid="select-sort">
              <SlidersHorizontal className="h-4 w-4 mr-2 text-zinc-500" /><SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="price_asc">Price: low to high</SelectItem>
              <SelectItem value="price_desc">Price: high to low</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <section className="mt-8 overflow-hidden rounded-2xl border border-red-900/40 bg-zinc-900/80" aria-label="Direct from CSD">
        <div className="flex flex-col gap-2 border-b border-zinc-800 bg-red-950/20 px-5 py-5 sm:flex-row sm:items-end sm:justify-between sm:px-7">
          <div><p className="font-mono text-[10px] uppercase tracking-[.25em] text-red-400">Computer Systems Depot / Direct offers</p><h2 className="mt-1 text-2xl font-bold tracking-tight text-white">From our workbench to yours.</h2><p className="mt-1 text-sm text-zinc-400">Products and services sold by CSD. These are not peer-to-peer hardware listings.</p></div><Package className="hidden h-8 w-8 text-red-500/70 sm:block" />
        </div>
        <div className="p-4 sm:p-6">
          {catalog.isLoading ? <div className="grid gap-3 sm:grid-cols-2">{[1, 2].map(n => <div key={n} className="h-28 animate-pulse rounded-xl bg-zinc-800" />)}</div> : catalog.isError ? <div className="flex items-center justify-between gap-3 text-sm text-zinc-400"><span>CSD offers could not load right now.</span><button onClick={() => catalog.refetch()} className="font-semibold text-red-400" data-testid="button-retry-offers">Retry</button></div> : !catalog.data?.items?.length ? <p className="text-sm text-zinc-400">No direct offers are available right now. Browse community listings below or check back soon.</p> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{catalog.data.items.filter(item => item.active && item.published).map(item => <Link key={item.id} href={`/portal/marketplace/offers/${item.id}`} className="group flex min-w-0 flex-col justify-between rounded-xl border border-zinc-700 bg-zinc-950/60 p-5 transition hover:border-red-500/60 hover:bg-zinc-900" data-testid={`link-csd-offer-${item.id}`}>
            <div><div className="flex items-center justify-between"><span className="rounded bg-red-950 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-red-300">{item.kind} · CSD direct</span><ArrowUpRight className="h-4 w-4 text-zinc-500 group-hover:text-red-400" /></div><h3 className="mt-4 text-lg font-bold text-white">{item.name}</h3><p className="mt-2 line-clamp-2 text-sm text-zinc-400">{item.description}</p></div><p className="mt-5 font-mono text-xl font-semibold text-white">{catalogMoney(item.unitAmountCents)}</p>
          </Link>)}</div>}
        </div>
      </section>

      <div className="mt-9 border-b border-zinc-800 pb-3"><p className="font-mono text-[10px] uppercase tracking-[.25em] text-zinc-500">Local community / Peer-to-peer listings</p><h2 className="mt-1 text-xl font-bold text-white">Listed by CSD customers</h2></div>
      <div className="mt-5 flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
        {[{ value: "all", label: "All" }, ...MARKETPLACE_CATEGORIES].map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setCategory(c.value)}
            data-testid={`filter-${c.value}`}
            className={cn(
              "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium border transition font-mono",
              category === c.value
                ? "bg-red-600 text-white border-red-500 glow-red"
                : "bg-zinc-900 text-zinc-300 border-zinc-800 hover:border-red-500/60 hover:text-white",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {query.isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="cyber-panel rounded-xl overflow-hidden animate-pulse">
                <div className="aspect-[4/3] bg-zinc-800/60" />
                <div className="p-3 space-y-2"><div className="h-3 w-1/3 bg-zinc-800 rounded" /><div className="h-4 w-3/4 bg-zinc-800 rounded" /></div>
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <div className="cyber-panel rounded-xl p-10 text-center">
            <p className="text-zinc-300">The marketplace couldn't load.</p>
            <Button variant="outline" className="mt-3 border-zinc-700 text-zinc-200 hover:bg-zinc-800" onClick={() => query.refetch()}>Try again</Button>
          </div>
        ) : listings.length === 0 ? (
          <div className="cyber-panel rounded-xl p-12 text-center" data-testid="text-empty">
            <Radar className="mx-auto h-10 w-10 text-red-500/70" />
            <p className="mt-3 font-semibold text-white">{search || category !== "all" ? "No listings match that yet." : "No listings yet — be the first."}</p>
            <p className="mt-1 text-sm text-zinc-400">Have a rig, laptop or parts to move? Listing is free and takes under a minute with CyberScan.</p>
            <Button asChild className="mt-4 bg-red-600 hover:bg-red-500 glow-red"><Link href="/portal/marketplace/sell"><Zap className="h-4 w-4 mr-2" /> List an item</Link></Button>
          </div>
        ) : (
          <>
            <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
              <span className="text-zinc-600">[</span> {listings.length} result{listings.length === 1 ? "" : "s"} <span className="text-zinc-600">]</span>
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {listings.map((l) => (
                <ListingCard key={l.id} listing={l} href={`/portal/marketplace/${l.id}`} />
              ))}
            </div>
          </>
        )}
      </div>
    </MarketplaceShell>
  );
}
