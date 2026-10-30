import { useMemo, useState } from "react";
import { Link } from "wouter";
import { RefreshCw } from "lucide-react";
import { catalogError, catalogMoney, useCatalogInquiries, useResolveCatalogInquiry, type CatalogInquiry } from "@/hooks/use-catalog";
import { useBillingParties, type BillingParty } from "@/hooks/use-invoices";
import QuickInvoiceSheet from "./quick-invoice-sheet";

export default function CatalogInquiryQueue() {
  const inquiries = useCatalogInquiries();
  const parties = useBillingParties();
  const resolve = useResolveCatalogInquiry();
  const [selected, setSelected] = useState<CatalogInquiry | null>(null);
  const [search, setSearch] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);

  const selectedParty: BillingParty | undefined = selected?.contactId
    ? parties.data?.find((party) => party.key === `contact:${selected.contactId}`)
    : undefined;
  const initialOffer = useMemo(() => selected ? {
    name: selected.offerName, unitAmountCents: selected.unitAmountCents,
    message: selected.message, email: selected.email,
    originInquiryId: selected.id, correctionOfInvoiceId: selected.invoiceId ?? undefined,
  } : null, [selected]);

  const resolveInquiry = async (inquiry: CatalogInquiry, target?: { contactId?: number; clientId?: number }) => {
    setError((old) => ({ ...old, [inquiry.id]: "" }));
    try {
      await resolve.mutateAsync({ id: inquiry.id, ...target });
    } catch (failure) {
      setError((old) => ({ ...old, [inquiry.id]: catalogError(failure) }));
    }
  };

  return <section className="mt-10 rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 sm:p-6" data-testid="catalog-inquiry-queue">
    <div className="flex items-center justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-widest text-[#b51f32]">Customer follow-up</p><h2 className="mt-1 text-xl font-semibold">Marketplace invoice requests</h2><p className="mt-1 text-sm text-[#59697a]">Review the buyer's identity before issuing an invoice. Matching email alone does not verify ownership.</p></div>
      <button onClick={() => void inquiries.refetch()} aria-label="Refresh inquiries" className="rounded-lg border p-2"><RefreshCw className="h-4 w-4" /></button>
    </div>
    {inquiries.isLoading ? <p className="mt-5 text-sm">Loading requests…</p> : inquiries.isError ? <p role="alert" className="mt-5 text-sm text-rose-700">Requests could not load. Try refreshing.</p> :
      !inquiries.data?.inquiries.length ? <p className="mt-5 text-sm text-[#59697a]">No invoice requests yet.</p> :
      <div className="mt-5 divide-y divide-[#dce2e8]">
        {inquiries.data.inquiries.map((inquiry) => {
          const term = (search[inquiry.id] ?? inquiry.email).toLowerCase();
          const matches = (parties.data ?? []).filter((party) => (
            party.name.toLowerCase().includes(term) || party.email?.toLowerCase().includes(term)
          )).slice(0, 30);
          const party = parties.data?.find((candidate) => candidate.key === `contact:${inquiry.contactId}`);
          return <article key={inquiry.id} className="py-4 text-sm" data-testid={`catalog-inquiry-${inquiry.id}`}>
            <div className="flex flex-wrap justify-between gap-2">
              <div><strong>{inquiry.offerName}</strong> · {catalogMoney(inquiry.unitAmountCents)}
                <p className="mt-1 text-[#59697a]">{inquiry.name} · {inquiry.email}{inquiry.phone && ` · ${inquiry.phone}`} · {new Date(inquiry.createdAt).toLocaleString()}</p>
              </div>
              <span className={`self-start rounded-full px-2 py-1 text-xs font-semibold ${inquiry.invoiceId || inquiry.contactId ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{inquiry.invoiceId ? `Invoiced · ${inquiry.invoiceStatus ?? "saved"}` : inquiry.contactId ? "Linked contact" : "Identity review"}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-[#14253a]">{inquiry.message}</p>
            {inquiry.invoiceId && <p className="mt-3">
              <Link href={`/invoices/${inquiry.invoiceId}`} className="font-semibold text-[#b51f32] underline">Open {inquiry.invoiceNumber ?? `invoice #${inquiry.invoiceId}`}</Link>
              <span className="ml-2 text-xs text-[#59697a]">Already invoiced. Open the invoice to edit a draft or review its status.</span>
            </p>}
            {inquiry.contactId ? <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="text-xs text-[#59697a]">Linked to {inquiry.contactName}</span>
              <Link href={inquiry.accountId ? `/crm/customers/${inquiry.accountId}` : "/crm/contacts"} className="text-xs font-semibold text-[#b51f32] underline">{inquiry.accountId ? "Customer history" : "Find contact history"}</Link>
              <button disabled={!party} onClick={() => {
                if (inquiry.invoiceId && !window.confirm(`Create a separate correction invoice for ${inquiry.invoiceNumber ?? `invoice #${inquiry.invoiceId}`}? The original invoice will remain unchanged and will not be cancelled or refunded. To edit a draft, open the existing invoice instead.`)) return;
                setSelected(inquiry); setOpen(true);
              }} className={`rounded-lg px-3 py-2 text-xs font-bold disabled:opacity-50 ${inquiry.invoiceId ? "border border-[#dce2e8] text-[#59697a]" : "bg-[#b51f32] text-white"}`}>{inquiry.invoiceId ? "Create correction invoice…" : "Create invoice from request"}</button>
              {!party && <span className="text-xs text-rose-700">Contact unavailable for billing; refresh the page.</span>}
            </div> : <div className="mt-3 space-y-2 rounded-lg bg-[#f3f5f7] p-3">
              <p className="text-xs text-[#59697a]">No unique CRM contact was found. Search and select the correct contact or customer account, or create a new contact after checking the buyer's details.</p>
              <input aria-label={`Find recipient for ${inquiry.name}`} placeholder="Search contacts or customer accounts" value={search[inquiry.id] ?? inquiry.email} onChange={(e) => setSearch((old) => ({ ...old, [inquiry.id]: e.target.value }))} className="w-full rounded border px-2 py-1.5" />
              <div className="flex flex-wrap gap-2">
                <select aria-label={`CRM match for ${inquiry.name}`} value={choice[inquiry.id] ?? ""} onChange={(e) => setChoice((old) => ({ ...old, [inquiry.id]: e.target.value }))} className="max-w-full rounded border px-2 py-1.5">
                  <option value="">Select a contact or account</option>
                  {matches.map((match) => <option key={match.key} value={match.key}>{match.kind === "client" ? "Account" : "Contact"}: {match.name} · {match.email || "No email"}{match.org ? ` · ${match.org}` : ""}</option>)}
                </select>
                <button disabled={!choice[inquiry.id] || resolve.isPending} onClick={() => {
                  const chosen = parties.data?.find((party) => party.key === choice[inquiry.id]);
                  if (chosen?.kind === "contact" && chosen.contactId) void resolveInquiry(inquiry, { contactId: chosen.contactId });
                  if (chosen?.kind === "client" && chosen.clientId) void resolveInquiry(inquiry, { clientId: chosen.clientId });
                }} className="rounded border px-3 py-1.5 font-semibold disabled:opacity-50">Link selected match</button>
                <button disabled={resolve.isPending} onClick={() => void resolveInquiry(inquiry)} className="rounded border px-3 py-1.5 font-semibold disabled:opacity-50">Create new contact</button>
              </div>
            </div>}
            {error[inquiry.id] && <p role="alert" className="mt-2 text-rose-700">{error[inquiry.id]}</p>}
          </article>;
        })}
      </div>}
    <QuickInvoiceSheet open={open} onOpenChange={setOpen} initialParty={selectedParty} initialOffer={initialOffer} />
  </section>;
}