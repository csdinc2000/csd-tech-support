import { useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Mail, MessageSquare, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import MarketplaceShell from "@/components/marketplace/portal-shell";
import { ListingGallery, ListingSummary, SafetyNote } from "@/components/marketplace/listing-detail";
import type { PublicListing } from "@/lib/marketplace";

const inputDark = "bg-zinc-950 border-zinc-800 text-white placeholder:text-zinc-500 focus-visible:ring-red-500";

function MessageSeller({ listing }: { listing: PublicListing }) {
  const [form, setForm] = useState({ buyerName: "", buyerEmail: "", buyerPhone: "", message: `Hi, is "${listing.title}" still available?` });
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/portal/marketplace/listings/${listing.id}/contact`, form);
      return res.json();
    },
    onError: (e: Error) => setError(e.message.replace(/^\d+:\s*/, "")),
  });

  if (send.isSuccess) {
    return (
      <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-5 text-center" data-testid="text-contact-sent">
        <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-400" />
        <p className="mt-2 font-semibold text-white">Message sent to the seller</p>
        <p className="mt-1 text-sm text-zinc-400">They'll reply to <span className="font-medium text-zinc-200">{form.buyerEmail}</span>{form.buyerPhone ? ` or ${form.buyerPhone}` : ""}.</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); setError(null); send.mutate(); }}
      className="space-y-3"
      data-testid="form-contact-seller"
    >
      <p className="text-xs text-zinc-500">We relay your message to the seller's email — their address stays private. They reply to you directly.</p>
      <Input required placeholder="Your name" value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} className={inputDark} data-testid="input-buyer-name" />
      <Input required type="email" placeholder="Your email" value={form.buyerEmail} onChange={(e) => setForm({ ...form, buyerEmail: e.target.value })} className={inputDark} data-testid="input-buyer-email" />
      <Input type="tel" placeholder="Your phone (optional)" value={form.buyerPhone} onChange={(e) => setForm({ ...form, buyerPhone: e.target.value })} className={inputDark} />
      <Textarea required rows={4} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className={inputDark} data-testid="input-buyer-message" />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" disabled={send.isPending} className="w-full bg-red-600 hover:bg-red-500 glow-red font-semibold" data-testid="button-send-message">
        {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />} Send message
      </Button>
    </form>
  );
}

// 1-click contact: call / text straight to the seller when they opted to show
// a number, otherwise (and additionally) the email relay form.
function ContactPanel({ listing }: { listing: PublicListing }) {
  const [showForm, setShowForm] = useState(!listing.sellerPhone);
  const tel = listing.sellerPhone ? listing.sellerPhone.replace(/[^\d+]/g, "") : null;
  return (
    <div className="cyber-panel rounded-xl p-5 space-y-4" data-testid="panel-contact">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-white"><MessageSquare className="h-4 w-4 text-red-500" /> Contact {listing.sellerName}</h2>
        <span className="term-badge text-emerald-400 border-emerald-500/60 bg-emerald-950/40 inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot" /> Listing live</span>
      </div>
      {tel && (
        <div className="grid grid-cols-2 gap-2">
          <Button asChild className="bg-red-600 hover:bg-red-500 glow-red font-semibold">
            <a href={`tel:${tel}`} data-testid="button-call-seller"><Phone className="h-4 w-4 mr-2" /> Call</a>
          </Button>
          <Button asChild variant="outline" className="border-red-500/60 text-red-400 hover:bg-red-600 hover:text-white hover:border-red-500">
            <a href={`sms:${tel}?&body=${encodeURIComponent(`Hi, is "${listing.title}" still available?`)}`} data-testid="button-text-seller"><MessageSquare className="h-4 w-4 mr-2" /> Text</a>
          </Button>
          <p className="col-span-2 font-mono text-xs text-zinc-400 text-center">{listing.sellerPhone}</p>
        </div>
      )}
      {tel && !showForm && (
        <Button variant="outline" className="w-full border-zinc-700 text-zinc-200 hover:bg-zinc-800 hover:text-white" onClick={() => setShowForm(true)} data-testid="button-email-seller">
          <Mail className="h-4 w-4 mr-2" /> Email seller instead
        </Button>
      )}
      {showForm && <MessageSeller listing={listing} />}
    </div>
  );
}

export default function MarketplaceListingPage() {
  const { id } = useParams<{ id: string }>();
  const query = useQuery<PublicListing>({
    queryKey: [`/api/portal/marketplace/listings/${id}`],
    staleTime: 30_000,
  });

  return (
    <MarketplaceShell backHref="/portal/marketplace" backLabel="All listings">
      {query.isLoading ? (
        <div className="py-20 text-center font-mono text-sm text-zinc-500">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500 pulse-dot-red mr-2 align-middle" />LOADING LISTING…
        </div>
      ) : query.isError || !query.data ? (
        <div className="cyber-panel rounded-xl p-10 text-center">
          <p className="font-semibold text-white">This listing is no longer available.</p>
          <p className="mt-1 text-sm text-zinc-400">It may have been sold or removed by the seller.</p>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-5" data-testid="page-listing-detail">
          <div className="lg:col-span-3">
            <ListingGallery imageIds={query.data.imageIds} title={query.data.title} />
          </div>
          <div className="lg:col-span-2 space-y-5">
            <ListingSummary listing={query.data} />
            {query.data.status === "active" ? (
              <ContactPanel listing={query.data} />
            ) : (
              <div className="cyber-panel rounded-xl p-5 text-center text-sm text-zinc-300">This item has been sold.</div>
            )}
            <SafetyNote />
          </div>
        </div>
      )}
    </MarketplaceShell>
  );
}
