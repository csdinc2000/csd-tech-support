import { useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowRight, CheckCircle2, CreditCard, Mail, Package, RefreshCw, ShieldCheck } from "lucide-react";
import MarketplaceShell from "@/components/marketplace/portal-shell";
import { catalogError, catalogMoney, useCatalogCheckout, useCatalogInquiry, usePublicCatalogItem } from "@/hooks/use-catalog";

export default function CatalogOffer() {
  const { id } = useParams<{ id: string }>();
  const offer = usePublicCatalogItem(id);
  const checkout = useCatalogCheckout();
  const inquiry = useCatalogInquiry();
  const [contact, setContact] = useState({ name: "", email: "", phone: "", message: "" });
  const [sent, setSent] = useState(false);
  const requestId = useRef<string | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const params = new URLSearchParams(window.location.search);
  const result = params.get("checkout") ?? params.get("status");
  const startCheckout = async () => {
    if (!offer.data) return;
    setError("");
    try {
      const { url } = await checkout.mutateAsync(offer.data.id);
      const target = new URL(url, window.location.origin);
      if (target.protocol !== "https:" && target.origin !== window.location.origin) throw new Error("Checkout link was invalid. Please contact us.");
      window.location.assign(target.href);
    } catch (failure) { setError(catalogError(failure)); }
  };
  const sendInquiry = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!offer.data || pending.current || sent) return;
    pending.current = true;
    requestId.current ??= crypto.randomUUID();
    setError("");
    try {
      await inquiry.mutateAsync({ id: offer.data.id, requestId: requestId.current, name: contact.name.trim(), email: contact.email.trim(), message: contact.message.trim(), ...(contact.phone.trim() ? { phone: contact.phone.trim() } : {}) });
      setSent(true);
    } catch (failure) { setError(catalogError(failure)); }
    finally { pending.current = false; }
  };
  return <MarketplaceShell showSell={false} offerMode backHref="/portal/marketplace" backLabel="Browse all offers">
    {offer.isLoading ? <div className="grid animate-pulse gap-6 lg:grid-cols-[1fr_360px]"><div className="h-80 rounded-2xl bg-zinc-900" /><div className="h-80 rounded-2xl bg-zinc-900" /></div> : offer.isError || !offer.data || !offer.data.active || !offer.data.published ? <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-10 text-center"><Package className="mx-auto h-10 w-10 text-red-400" /><h1 className="mt-4 text-2xl font-bold text-white">Offer unavailable</h1><p className="mt-2 text-zinc-400">This CSD offer is no longer available, or could not be loaded.</p><div className="mt-5 flex justify-center gap-4"><button onClick={() => offer.refetch()} className="inline-flex items-center gap-2 text-sm font-semibold text-red-400"><RefreshCw className="h-4 w-4" /> Retry</button><Link href="/portal/marketplace" className="text-sm font-semibold text-zinc-300">Browse marketplace</Link></div></div> : <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_370px]">
      <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/80">
        <div className="flex min-h-44 items-center justify-center border-b border-red-900/30 bg-[radial-gradient(circle_at_70%_20%,#671522_0%,#1c1b21_45%,#121317_100%)] sm:min-h-60"><Package className="h-20 w-20 text-red-400/70" strokeWidth={1} /></div>
        <div className="p-6 sm:p-9"><p className="font-mono text-xs uppercase tracking-[.25em] text-red-400">CSD direct / {offer.data.kind}</p><h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-5xl" data-testid="text-offer-name">{offer.data.name}</h1><p className="mt-6 whitespace-pre-wrap text-base leading-8 text-zinc-300">{offer.data.description}</p><div className="mt-8 flex items-start gap-3 border-t border-zinc-800 pt-6 text-sm text-zinc-400"><ShieldCheck className="h-5 w-5 shrink-0 text-red-400" /><p>This is offered directly by Computer Systems Depot. It is separate from the peer-to-peer community marketplace.</p></div></div>
      </div>
      <aside className="space-y-5">
        <div className="rounded-2xl border border-zinc-700 bg-zinc-900 p-6"><p className="font-mono text-[10px] uppercase tracking-[.25em] text-zinc-400">Price · USD</p><p className="mt-2 text-4xl font-bold tracking-tight text-white" data-testid="text-offer-price">{catalogMoney(offer.data.unitAmountCents)}</p><p className="mt-2 text-xs leading-5 text-zinc-400">Final checkout terms are shown by Stripe. Payment amount is determined by CSD, not this page.</p><button onClick={startCheckout} disabled={checkout.isPending} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50" data-testid="button-offer-checkout"><CreditCard className="h-4 w-4" /> {checkout.isPending ? "Opening secure checkout…" : "Buy with Stripe"} <ArrowRight className="h-4 w-4" /></button><a href="#contact-csd" className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 px-5 py-3 text-sm font-bold text-zinc-200 hover:bg-zinc-800" data-testid="link-offer-contact"><Mail className="h-4 w-4" /> Contact us</a></div>
        {(result === "success" || result === "cancelled") && <div role="status" className={`rounded-xl border p-4 text-sm ${result === "success" ? "border-emerald-700 bg-emerald-950/40 text-emerald-200" : "border-amber-800 bg-amber-950/30 text-amber-200"}`}>{result === "success" ? "You returned from checkout. If your payment was completed, Stripe will send a receipt. Contact CSD if you need help with your order." : "You returned from checkout without completing it. You can try again or ask us a question below."}</div>}
        {error && <p role="alert" className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
        <div id="contact-csd" className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6"><p className="font-mono text-[10px] uppercase tracking-[.25em] text-red-400">Talk to a person</p><h2 className="mt-2 text-xl font-bold text-white">Questions about this offer?</h2><p className="mt-1 text-sm text-zinc-400">Send a note to our team and we'll follow up.</p>
          {sent ? <div role="status" className="mt-6 rounded-xl border border-emerald-800 bg-emerald-950/40 p-5 text-emerald-200"><CheckCircle2 className="mb-2 h-6 w-6" /><strong>Request received.</strong><p className="mt-1 text-sm">We'll follow up at {contact.email}. No payment or invoice was created.</p></div> : <form onSubmit={sendInquiry} className="mt-5 space-y-3">{(["name", "email", "phone"] as const).map(field => <label key={field} className="block text-xs font-semibold uppercase tracking-wide text-zinc-400">{field}{field === "phone" ? " (optional)" : ""}<input required={field !== "phone"} type={field === "email" ? "email" : field === "phone" ? "tel" : "text"} value={contact[field]} onChange={e => { requestId.current = null; setContact({ ...contact, [field]: e.target.value }); }} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm font-normal normal-case text-white outline-none focus:border-red-500" data-testid={`input-offer-${field}`} /></label>)}<label className="block text-xs font-semibold uppercase tracking-wide text-zinc-400">Message<textarea required minLength={5} value={contact.message} onChange={e => { requestId.current = null; setContact({ ...contact, message: e.target.value }); }} rows={4} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm font-normal normal-case text-white outline-none focus:border-red-500" data-testid="input-offer-message" /></label><button disabled={inquiry.isPending} type="submit" className="w-full rounded-lg border border-red-500 px-5 py-2.5 text-sm font-bold text-red-300 hover:bg-red-950 disabled:opacity-50" data-testid="button-send-offer-inquiry">{inquiry.isPending ? "Sending…" : "Send message"}</button></form>}
        </div>
      </aside>
    </div>}
  </MarketplaceShell>;
}