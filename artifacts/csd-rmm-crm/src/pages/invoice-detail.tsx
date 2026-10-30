import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock3, CreditCard, Download, Mail, Plus, RefreshCw, Send, Trash2, XCircle, Copy, ExternalLink, Building, FileText, Wrench } from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";
import { useBillingParties, useCreateInvoice, useDeleteInvoice, useInvoice, useInvoiceSettings, useManualMarkPaid, useResendInvoiceEmail, useRetryInvoiceEmail, useScheduleInvoiceReminders, useSendInvoice, useStripeCheckout, useUpdateInvoice, useVoidInvoice, type BillingParty, type InvoiceInput, type StripeDocumentIncident as StripeDocumentIncidentEntry } from "@/hooks/use-invoices";
import BillingPartyPicker, { partyToSelection, recipientFor, selectionEmail, selectionOrg, type BillingSelection } from "@/components/invoices/billing-party-picker";
import CatalogLinePicker from "@/components/invoices/catalog-line-picker";

type Line = { description: string; quantity: number; unitAmountCents: number };

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
const base = (): InvoiceInput => ({ dueDate: "", notes: "", paypalCheckoutUrl: "", taxRateBps: 0, discountCents: 0, lineItems: [{ description: "", quantity: 1, unitAmountCents: 0 }] });

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === "new";
  const [, setLocation] = useLocation();
  const detail = useInvoice(isNew ? undefined : id);
  const settings = useInvoiceSettings();
  const parties = useBillingParties();

  const create = useCreateInvoice();
  const update = useUpdateInvoice();
  const send = useSendInvoice();
  const resend = useResendInvoiceEmail();
  const scheduleReminders = useScheduleInvoiceReminders();
  const retryEmail = useRetryInvoiceEmail();
  const remove = useDeleteInvoice();
  const voidInvoice = useVoidInvoice();
  const markPaid = useManualMarkPaid();
  const checkout = useStripeCheckout();

  const [form, setForm] = useState<InvoiceInput>(base);
  const [notice, setNotice] = useState("");
  const [reference, setReference] = useState("");
  const [reminderDays, setReminderDays] = useState("1, 7, 14");
  const initializedForId = useRef<number | null>(null);
  const newDefaultsApplied = useRef(false);
  const editedDefaults = useRef({ due: false, notes: false, tax: false });

  const [selection, setSelection] = useState<BillingSelection | null>(null);
  // Which invoice the picker was filled in from, so a refetch never overwrites
  // a customer the user just changed.
  const hydrated = useRef<{ invoiceId: number; matched: boolean } | null>(null);

  useEffect(() => {
    if (!isNew || !settings.data || newDefaultsApplied.current) return;
    newDefaultsApplied.current = true;
    const due = new Date();
    due.setDate(due.getDate() + settings.data.defaultDueDays);
    setForm((current) => ({
      ...current,
      dueDate: editedDefaults.current.due ? current.dueDate : `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`,
      notes: editedDefaults.current.notes ? current.notes : settings.data!.defaultNotes,
      taxRateBps: editedDefaults.current.tax ? current.taxRateBps : settings.data!.defaultTaxRateBps,
    }));
  }, [isNew, settings.data]);

  useEffect(() => {
    if (detail.data && !isNew && initializedForId.current !== detail.data.id) {
      initializedForId.current = detail.data.id;
      setReference(detail.data.external_payment_pending ? detail.data.external_payment_reference ?? "" : "");
      setForm({
        jobId: detail.data.job_id,
        dueDate: detail.data.due_date || "",
        notes: detail.data.notes || "",
        paypalCheckoutUrl: detail.data.paypal_checkout_url || "",
        taxRateBps: detail.data.tax_rate_bps,
        discountCents: detail.data.discount_cents,
        lineItems: detail.data.lineItems.map((l: any) => ({
          description: l.description,
          quantity: l.quantity,
          unitAmountCents: l.unit_amount_cents ?? l.unitAmountCents ?? 0
        }))
      });
    }
  }, [detail.data, isNew]);

  // An existing invoice already names its customer; match it back to the
  // picker list so the same control works for editing and for a new draft.
  useEffect(() => {
    const invoice = detail.data;
    if (!invoice || isNew) return;
    const known = (parties.data ?? []).find((party) => party.kind === "contact" && party.contactId === invoice.contact_id);
    if (hydrated.current?.invoiceId === invoice.id && (hydrated.current.matched || !known)) return;
    hydrated.current = { invoiceId: invoice.id, matched: !!known };
    setSelection(
      partyToSelection(
        known ?? {
          key: `contact:${invoice.contact_id}`,
          kind: "contact",
          contactId: invoice.contact_id,
          clientId: invoice.client_id ?? null,
          name: invoice.client_name,
          org: null,
          email: invoice.client_email ?? null,
          phone: null,
          invoiceCount: 0,
          lastInvoiceAt: null,
          openBalanceCents: 0,
          openJobCount: 0,
          openRequestCount: 0,
          openJobs: [],
        } satisfies BillingParty,
      ),
    );
  }, [detail.data, isNew, parties.data]);

  const total = useMemo(() => {
    const subtotal = form.lineItems.reduce((n: number, l: any) => n + (l.quantity || 0) * (l.unitAmountCents || 0), 0);
    const tax = Math.round(subtotal * (form.taxRateBps || 0) / 10000);
    return { subtotal, tax, total: subtotal + tax - (form.discountCents || 0) };
  }, [form]);

  const readonly = !!detail.data && detail.data.status !== "draft";
  const patch = (values: Partial<InvoiceInput>) => setForm((f) => ({ ...f, ...values }));
  const updateLine = (index: number, changes: Partial<Line>) => {
    const v = [...form.lineItems];
    v[index] = { ...v[index], ...changes };
    patch({ lineItems: v });
  };

  const applyTerms = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    editedDefaults.current.due = true;
    patch({ dueDate: `${yyyy}-${mm}-${dd}` });
  };

  const save = () => {
    if (isNew && !settings.data) return setNotice("Invoice settings have not loaded. Please try again shortly.");
    if (!selection) return setNotice("Choose who this invoice is for.");
    if (form.lineItems.some((l) => !l.description.trim() || l.quantity < 1))
      return setNotice("Complete every line item description and quantity.");
    if (form.discountCents > total.subtotal + total.tax)
      return setNotice("Discount cannot exceed subtotal plus tax.");
    const input: InvoiceInput = { ...form, recipient: recipientFor(selection) };
    const options = {
      onSuccess: (invoice: any) => setLocation(`/invoices/${invoice.id}`),
      onError: (e: Error) => setNotice(e.message)
    };
    if (isNew) create.mutate(input, options);
    else update.mutate({ id: Number(id), input }, options);
  };

  if (!isNew && detail.isLoading) return <main className="p-6"><div className="h-80 animate-pulse rounded-2xl bg-slate-200"/></main>;
  if (!isNew && detail.error) return <main className="p-6"><button onClick={() => detail.refetch()} className="rounded-lg bg-[#172436] px-4 py-2 text-sm font-bold text-white">Retry invoice</button></main>;

  const inv = detail.data;
  const isOverdue = inv?.status === "sent" && inv?.due_date && new Date(inv.due_date) < new Date(new Date().setHours(0,0,0,0));

  const openJobs = selection?.kind === "party" ? selection.party.openJobs : [];

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-[#f3f5f7] p-4 text-[#14253a] lg:p-8">
      <div className="mx-auto max-w-6xl">
        <button onClick={() => setLocation("/invoices")} className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-[#59697a] hover:text-[#b51f32] transition-colors">
          <ArrowLeft className="h-4 w-4"/>
          Invoice desk
        </button>

        <header className="mb-6 overflow-hidden rounded-2xl border border-[#dce2e8] bg-[#fffefd] shadow-sm">
          <div className="h-1 bg-[#b51f32]" />
          <div className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between md:p-8">
          <div>
            <img src={csdLogo} alt="Computer Systems Depot" className="mb-6 h-9 w-auto max-w-[170px] object-contain object-left" />
            <div className="flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider ${isNew ? 'bg-[#e9edf1] text-[#526276]' : isOverdue ? 'bg-[#f9e5e8] text-[#a21d31]' : inv?.status === "paid" ? 'bg-[#e8f3ef] text-[#206855]' : 'bg-[#fff1e7] text-[#95502c]'}`}>
                {isNew ? "New draft" : isOverdue ? "Overdue" : inv?.status === "sent" ? "Awaiting payment" : inv?.status}
              </span>
              <p className="text-xs font-bold uppercase tracking-[.2em] text-[#738092]">Billing record</p>
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{isNew ? "Create an invoice" : `Invoice ${inv?.invoice_number}`}</h1>
            <p className="mt-2 text-sm text-[#59697a]">
              {isNew ? "Review the details, save a draft, then send it when it's ready." : `${inv?.client_name} · ${usd(inv?.total_cents ?? 0)} ${inv?.due_date ? `· Due ${inv.due_date}` : ""}`}
            </p>
          </div>

          {!isNew && (
            <Actions
              status={inv!.status}
              sending={send.isPending || resend.isPending}
              publicUrl={inv!.publicUrl}
              stripePdfUrl={inv!.stripe_invoice_pdf_url}
              onSend={() => { if (!window.confirm(`Publish and email this invoice to ${inv?.client_email || "the selected contact"}?`)) return; send.mutate(inv!.id, { onSuccess: () => { setNotice("Published and queued for email delivery."); detail.refetch(); }, onError: (e) => setNotice(e.message) }); }}
              onResend={() => resend.mutate({ id: inv!.id, requestKey: crypto.randomUUID() }, { onSuccess: () => { setNotice("Invoice email queued again."); detail.refetch(); }, onError: (e) => setNotice(e.message) })}
               onVoid={() => { if(window.confirm("Void this invoice? This cannot be undone.")) voidInvoice.mutate(inv!.id, { onSuccess: () => detail.refetch(), onError: (e) => setNotice(e.message) }) }}
               onDelete={() => { if (window.confirm("Delete this draft invoice permanently?")) remove.mutate(inv!.id, { onSuccess: () => setLocation("/invoices"), onError: (e) => setNotice(e.message) }); }}
               onCheckout={() => checkout.mutate(inv!.id, { onSuccess: (url) => window.open(String(url), "_blank", "noopener,noreferrer"), onError: (e) => setNotice(e.message) })}
            />
          )}
          </div>
        </header>

        {notice && (
          <div role="status" className="mb-6 flex items-center justify-between rounded-lg border border-[#dce2e8] bg-[#fffefd] px-4 py-3 text-sm text-[#14253a] shadow-sm">
            <span className="font-medium">{notice}</span>
            <button onClick={() => setNotice("")} className="text-rose-600 hover:text-rose-900"><XCircle className="h-5 w-5"/></button>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <section className="space-y-6">
            {/* Bill To */}
             <div className="rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm sm:p-6">
               <h2 className="flex items-center gap-3 text-lg font-semibold tracking-tight text-[#14253a]">
                 <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#14253a] text-xs font-bold text-white">1</span>
                 <Building className="h-4 w-4 text-[#b51f32]" /> Bill to
              </h2>
              <div className="mt-5">
                <BillingPartyPicker
                  error={parties.isError}
                  onRetry={() => { void parties.refetch(); }}
                  parties={parties.data ?? []}
                  loading={parties.isLoading}
                  value={selection}
                  onChange={(next) => { setSelection(next); patch({ jobId: null }); setNotice(""); }}
                  disabled={readonly}
                />
                {selection && !selectionEmail(selection) && (
                  <p className="mt-2 text-xs text-amber-700">No email on file yet — this invoice can be saved as a draft but not emailed.</p>
                )}
                {selection && selectionOrg(selection) && (
                  <p className="mt-2 text-xs text-slate-500">Billed to the {selectionOrg(selection)} account.</p>
                )}

                {!readonly && openJobs.length > 0 && (
                  <div className="mt-4 border-t border-[#eee7dc] pt-4">
                    <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                      <Wrench className="h-3.5 w-3.5 text-amber-600" /> Attach open work
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {openJobs.map((job) => (
                        <button
                          key={job.id}
                          type="button"
                          onClick={() => patch({ jobId: form.jobId === job.id ? null : job.id })}
                          className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${form.jobId === job.id ? "border-[#b21f32] bg-[#b21f32]/5 text-[#b21f32]" : "border-[#ddd5c9] bg-white text-slate-600 hover:border-[#b21f32]/40"}`}
                        >
                          <span className="font-bold">{job.jobNumber}</span>
                          <span className="ml-1.5 opacity-80">{job.serviceType.replaceAll("_", " ")}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Work Performed */}
             <div className="rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm sm:p-6">
              <div className="flex items-center justify-between">
                 <h2 className="flex items-center gap-3 text-lg font-semibold tracking-tight text-[#14253a]">
                   <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#14253a] text-xs font-bold text-white">2</span>
                   <FileText className="h-4 w-4 text-[#b51f32]" /> Services &amp; charges
                </h2>
                {!readonly && (
                  <button onClick={() => patch({ lineItems: [...form.lineItems, { description: "", quantity: 1, unitAmountCents: 0 }] })} className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-bold text-[#172436] transition-colors hover:bg-slate-200">
                    <Plus className="h-4 w-4"/> Add line
                  </button>
                )}
              </div>

               {!readonly && <div className="mt-5"><CatalogLinePicker onSelect={(item) => patch({ lineItems: (() => { const line = { description: item.name, quantity: 1, unitAmountCents: item.unitAmountCents }; const blank = form.lineItems.findIndex(l => !l.description.trim() && !l.unitAmountCents); return blank < 0 ? [...form.lineItems, line] : form.lineItems.map((entry, index) => index === blank ? line : entry); })() })} /></div>}
               <div className="mt-5 space-y-3">
                {/* Desktop Header */}
                <div className="hidden grid-cols-[1fr_80px_110px_90px_32px] gap-2 px-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 sm:grid">
                  <div>Description</div>
                  <div className="text-center">Qty</div>
                  <div className="text-right">Unit Price</div>
                  <div className="text-right">Total</div>
                  <div></div>
                </div>

                {form.lineItems.map((line, n) => {
                  const lineTotal = (line.quantity || 0) * (line.unitAmountCents || 0);
                  return (
                    <div key={n} className="group relative flex flex-col gap-3 rounded-xl border border-[#e5ddd2] bg-slate-50/50 p-4 sm:flex-row sm:items-center sm:gap-2 sm:border-transparent sm:bg-transparent sm:p-1">
                      <div className="flex-1">
                        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500 sm:hidden">Description</label>
                        <input disabled={readonly} value={line.description} onChange={(e) => updateLine(n, {description: e.target.value})} placeholder="Item description" className="w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-3 py-2 text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32] disabled:opacity-60"/>
                      </div>
                      <div className="flex gap-3 sm:w-[300px] sm:gap-2">
                        <div className="flex-1 sm:w-[80px] sm:flex-none">
                          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500 sm:hidden">Qty</label>
                          <input disabled={readonly} min="1" type="number" value={line.quantity || ""} onChange={(e) => updateLine(n, {quantity: Number(e.target.value)})} className="w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-2 py-2 text-center text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32] disabled:opacity-60"/>
                        </div>
                        <div className="flex-1 sm:w-[110px] sm:flex-none">
                          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500 sm:hidden">Unit Price</label>
                          <div className="relative">
                            <span className="absolute left-2.5 top-2 text-slate-400">$</span>
                            <input disabled={readonly} min="0" step="0.01" type="number" value={line.unitAmountCents ? (line.unitAmountCents/100).toString() : ""} onChange={(e) => updateLine(n, {unitAmountCents: Math.round(Number(e.target.value)*100)})} className="w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] py-2 pl-6 pr-2 text-right text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32] disabled:opacity-60"/>
                          </div>
                        </div>
                        <div className="flex flex-1 items-end justify-between sm:w-[90px] sm:flex-none sm:items-center sm:justify-end">
                          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500 sm:hidden">Total</label>
                          <div className="py-2 text-right font-mono text-sm font-bold text-[#172436]">{usd(lineTotal)}</div>
                        </div>
                      </div>
                      <div className="absolute right-2 top-2 sm:static sm:w-[32px] sm:flex-none sm:text-right">
                        {!readonly && (
                          <button aria-label="Remove line" onClick={() => patch({lineItems: form.lineItems.filter((_, index)=>index!==n)})} className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-colors sm:opacity-0 sm:group-hover:opacity-100">
                            <Trash2 className="h-4 w-4"/>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Terms */}
             <div className="rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm sm:p-6">
               <h2 className="flex items-center gap-3 text-lg font-semibold tracking-tight text-[#14253a]">
                 <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#14253a] text-xs font-bold text-white">3</span>
                 Terms &amp; details
               </h2>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">Due date</label>
                  <input disabled={readonly} type="date" value={form.dueDate || ""} onChange={(e)=>{ editedDefaults.current.due = true; patch({dueDate:e.target.value}); }} className="mt-1.5 w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-3 py-2 text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32] disabled:opacity-60"/>
                  {!readonly && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => applyTerms(0)} className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-600 hover:bg-slate-200 transition-colors">Receipt</button>
                      <button type="button" onClick={() => applyTerms(15)} className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-600 hover:bg-slate-200 transition-colors">Net 15</button>
                      <button type="button" onClick={() => applyTerms(30)} className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-600 hover:bg-slate-200 transition-colors">Net 30</button>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">Tax rate (%)</label>
                  <input disabled={readonly} type="number" min="0" step="0.01" value={form.taxRateBps ? (form.taxRateBps / 100).toString() : ""} onChange={(e)=>{ editedDefaults.current.tax = true; patch({taxRateBps:Math.round(Number(e.target.value)*100)}); }} className="mt-1.5 w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-3 py-2 text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32] disabled:opacity-60"/>
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">Discount ($)</label>
                  <div className="relative mt-1.5">
                    <span className="absolute left-3 top-2 text-slate-400">$</span>
                    <input disabled={readonly} type="number" min="0" step="0.01" value={form.discountCents ? (form.discountCents / 100).toString() : ""} onChange={(e)=>patch({discountCents:Math.round(Number(e.target.value)*100)})} className="w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] py-2 pl-7 pr-3 text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32] disabled:opacity-60"/>
                  </div>
                </div>

                 <div>
                   <label htmlFor="external-paypal-url" className="block text-xs font-bold uppercase tracking-wide text-slate-500">
                     Optional external PayPal URL
                   </label>
                   <input
                     id="external-paypal-url"
                     type="url"
                     disabled={readonly}
                     value={form.paypalCheckoutUrl || ""}
                     onChange={(e) => patch({ paypalCheckoutUrl: e.target.value })}
                     placeholder="https://www.paypal.com/..."
                     className="mt-1.5 w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-3 py-2 text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32] disabled:opacity-60"
                   />
                   <p className="mt-1.5 text-xs leading-5 text-[#59697a]">
                     PayPal opens outside CSD. Confirm payment and reconcile manually; no PayPal status tracking is connected.
                   </p>
                 </div>
              </div>

              <div className="mt-5">
                <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">Notes to client</label>
                <textarea disabled={readonly} value={form.notes || ""} onChange={(e)=>{ editedDefaults.current.notes = true; patch({notes:e.target.value}); }} placeholder="Thank you for your business." className="mt-1.5 min-h-24 w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] p-3 text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32] disabled:opacity-60"/>
              </div>
            </div>

            {inv && (
              <>
                <StripeDocumentIncident invoice={inv} />
                <StripeDocumentIncidentHistory incidents={inv.stripeDocumentIncidents ?? []} />
                <StripeReconciliationIncident invoice={inv} />
                <FirstCustomerView invoice={inv} />
                <EmailDeliveryPanel
                  invoice={inv}
                  reminderDays={reminderDays}
                  setReminderDays={setReminderDays}
                  scheduling={scheduleReminders.isPending}
                  onSchedule={() => {
                    const days = [...new Set(reminderDays.split(",").map(v => Number(v.trim())).filter(Number.isInteger))];
                    scheduleReminders.mutate({ id: inv.id, daysAfterDue: days }, { onSuccess: () => { setNotice("Overdue reminders scheduled."); detail.refetch(); }, onError: e => setNotice(e.message) });
                  }}
                  onRetry={(deliveryId) => retryEmail.mutate({ id: inv.id, deliveryId }, { onSuccess: () => detail.refetch(), onError: e => setNotice(e.message) })}
                />
              </>
            )}
          </section>

          <aside>
            <div className="sticky top-20 flex flex-col gap-6">
              <div className="rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm sm:p-6">
                <p className="text-xs font-bold uppercase tracking-[.16em] text-[#738092]">Invoice total</p>

                <div className="mt-5 space-y-3 text-sm text-slate-600">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span className="font-mono">{usd(total.subtotal)}</span>
                  </div>
                  {total.tax > 0 && (
                    <div className="flex justify-between">
                      <span>Tax ({(form.taxRateBps / 100).toFixed(2)}%)</span>
                      <span className="font-mono">{usd(total.tax)}</span>
                    </div>
                  )}
                  {form.discountCents > 0 && (
                    <div className="flex justify-between text-[#b21f32]">
                      <span>Discount</span>
                      <span className="font-mono">− {usd(form.discountCents)}</span>
                    </div>
                  )}
                </div>

                <div className="mt-5 border-t border-[#e5ddd2] pt-5">
                  <div className="flex items-center justify-between">
                     <span className="text-base font-semibold text-[#14253a]">Total</span>
                     <span className="text-2xl font-bold tracking-tight tabular-nums text-[#14253a]">{usd(total.total)}</span>
                  </div>
                </div>

                {!readonly && (
                  <button disabled={create.isPending || update.isPending} onClick={save} className="mt-6 w-full rounded-md bg-[#b51f32] px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#94172a] disabled:opacity-60">
                    {isNew ? "Save draft invoice" : "Update draft"}
                  </button>
                )}

                {inv?.status === "sent" && (
                  <div className="mt-6 rounded-xl bg-slate-50 p-4 border border-slate-100">
                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">Manually reconcile external payment</p>
                     <p className="mb-3 text-xs leading-5 text-[#59697a]">Confirm the funds arrived outside CSD first. CSD will close the Stripe invoice before recording this payment. PayPal links are not tracked automatically.</p>
                     {inv.external_payment_pending && <p role="alert" className="mb-3 text-xs font-semibold text-amber-800">Stripe closure is still unresolved. Check Stripe and the external payment, then retry with the same provider and reference. Do not record another payment while this is pending.</p>}
                     <input value={reference} onChange={e=>setReference(e.target.value)} placeholder="Check or payment reference #" className="w-full rounded-md border border-[#ddd5c9] bg-white px-3 py-2 text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32]"/>
                     <button disabled={!reference.trim() || markPaid.isPending} onClick={()=>{
                       const provider = inv.external_payment_provider ?? (inv.paypal_checkout_url ? "paypal" : "manual");
                       if (!window.confirm(`Have you confirmed the ${provider === "paypal" ? "PayPal" : "external"} payment was received? CSD will close the Stripe invoice before marking this paid.`)) return;
                       markPaid.mutate({id:inv.id,provider,reference:reference.trim()},{onSuccess:()=>{ setReference(""); setNotice("Stripe invoice closed and external payment recorded."); detail.refetch(); }, onError:(e)=>{ setNotice(e.message); detail.refetch(); }});
                     }} className="mt-3 w-full rounded-md bg-[#172436] py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-40">
                       {inv.external_payment_pending ? "Retry Stripe reconciliation" : "Close Stripe invoice & mark paid"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>

      </div>
    </main>
  );
}

function Actions({ status, sending, publicUrl, stripePdfUrl, onSend, onResend, onVoid, onDelete, onCheckout }: { status: string; sending: boolean; publicUrl?: string; stripePdfUrl?: string | null; onSend: () => void; onResend: () => void; onVoid: () => void; onDelete: () => void; onCheckout: () => void }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 md:mt-0">
      {publicUrl && (
        <div className="flex flex-wrap items-center gap-2 md:border-r md:border-[#dce2e8] md:pr-3">
          <button onClick={() => navigator.clipboard.writeText(publicUrl)} className="inline-flex h-9 items-center gap-2 rounded-md border border-[#cbd4dc] px-3 text-sm font-semibold text-[#14253a] transition hover:bg-[#f3f5f7]" title="Copy customer invoice link">
            <Copy className="h-4 w-4" /> Copy link
          </button>
          <button onClick={() => window.open(publicUrl, '_blank', 'noopener,noreferrer')} className="inline-flex h-9 items-center gap-2 rounded-md border border-[#cbd4dc] px-3 text-sm font-semibold text-[#14253a] transition hover:bg-[#f3f5f7]" title="Open customer invoice link">
            <ExternalLink className="h-4 w-4" /> Customer link
          </button>
        </div>
      )}

      {status === "draft" && (
        <>
          <button onClick={onDelete} className="inline-flex h-9 items-center gap-2 rounded-md border border-[#cbd4dc] px-4 text-sm font-semibold text-[#14253a] transition hover:bg-[#f3f5f7]">
            <Trash2 className="h-4 w-4"/> Delete
          </button>
          <button disabled={sending} onClick={onSend} className="inline-flex h-9 items-center gap-2 rounded-md bg-[#b51f32] px-4 text-sm font-semibold text-white transition hover:bg-[#94172a] disabled:opacity-60">
            <Send className="h-4 w-4"/> Send invoice
          </button>
        </>
      )}

      {status === "sent" && (
        <>
          <button disabled={sending} onClick={onResend} className="inline-flex h-9 items-center gap-2 rounded-md bg-[#b51f32] px-4 text-sm font-semibold text-white transition hover:bg-[#94172a] disabled:opacity-60">
            <Mail className="h-4 w-4"/> Resend email
          </button>
          <button onClick={onCheckout} className="inline-flex h-9 items-center gap-2 rounded-md border border-[#cbd4dc] px-4 text-sm font-semibold text-[#14253a] transition hover:bg-[#f3f5f7]">
            <CreditCard className="h-4 w-4"/> Open Stripe invoice
          </button>
          {stripePdfUrl && (
            <button onClick={() => window.open(stripePdfUrl, "_blank", "noopener,noreferrer")} className="inline-flex h-9 items-center gap-2 rounded-md border border-[#cbd4dc] px-4 text-sm font-semibold text-[#14253a] transition hover:bg-[#f3f5f7]">
              <Download className="h-4 w-4"/> PDF
            </button>
          )}
        </>
      )}

      {(status === "draft" || status === "sent") && (
        <button onClick={onVoid} className="inline-flex h-9 items-center gap-2 rounded-md border border-[#cbd4dc] px-4 text-sm font-semibold text-[#526276] transition hover:border-[#b51f32] hover:text-[#b51f32]">
          <XCircle className="h-4 w-4"/> Void
        </button>
      )}

      {status === "paid" && (
        <span className="inline-flex h-9 items-center gap-2 rounded-md bg-[#e8f3ef] px-4 text-sm font-bold text-[#206855]">
          <CheckCircle2 className="h-4 w-4"/> Paid in full
        </span>
      )}
    </div>
  );
}

function StripeDocumentIncident({ invoice }: { invoice: any }) {
  const incident = [...(invoice.stripeDocumentIncidents ?? [])]
    .reverse()
    .find((entry: StripeDocumentIncidentEntry) => entry.resolutionStatus === "active");
  if (!incident) return null;

  const documentKind = incident.documentKind === "invoice_pdf" ? "Invoice PDF" : "Hosted invoice page";
  const category = incident.failureCategory === "exhausted" ? "Retries exhausted" : "Permanent document failure";

  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
        <div className="min-w-0">
          <h2 className="font-serif text-xl font-bold text-amber-950">Stripe document blocked this email</h2>
          <p className="mt-1 text-sm text-amber-900">
            The invoice stayed in its current state because Stripe’s customer document could not be verified. Retry after the document is available.
          </p>
        </div>
      </div>
      <dl className="mt-4 grid gap-3 text-xs text-amber-950 sm:grid-cols-2">
        <div><dt className="font-bold uppercase tracking-wide text-amber-800">Document</dt><dd className="mt-1">{documentKind}</dd></div>
        <div><dt className="font-bold uppercase tracking-wide text-amber-800">Status</dt><dd className="mt-1">{category}</dd></div>
        <div><dt className="font-bold uppercase tracking-wide text-amber-800">Attempts</dt><dd className="mt-1">{incident.attempts}</dd></div>
        <div><dt className="font-bold uppercase tracking-wide text-amber-800">Last seen</dt><dd className="mt-1">{new Date(incident.lastSeenAt).toLocaleString()}</dd></div>
      </dl>
    </div>
  );
}

function StripeDocumentIncidentHistory({ incidents }: { incidents: StripeDocumentIncidentEntry[] }) {
  const resolved = incidents.filter((incident) => incident.resolutionStatus === "resolved" && incident.resolvedAt);
  if (resolved.length === 0) return null;

  return (
    <div className="rounded-2xl border border-[#ded6c9] bg-[#fffdfa] p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
        <h2 className="font-serif text-xl font-bold text-[#172436]">Resolved Stripe document history</h2>
      </div>
      <p className="mt-1 text-sm text-slate-600">Past document checks that were cleared after a successful retry.</p>
      <div className="mt-5 divide-y divide-[#e5ddd2] rounded-xl border border-[#e5ddd2] bg-white">
        {resolved.map((incident) => (
          <dl key={incident.id} className="grid gap-3 p-4 text-xs text-slate-700 sm:grid-cols-4">
            <div><dt className="font-bold uppercase tracking-wide text-slate-500">Document</dt><dd className="mt-1">{incident.documentKind === "invoice_pdf" ? "Invoice PDF" : "Hosted invoice page"}</dd></div>
            <div><dt className="font-bold uppercase tracking-wide text-slate-500">Failure category</dt><dd className="mt-1">{incident.failureCategory === "exhausted" ? "Retries exhausted" : "Permanent failure"}</dd></div>
            <div><dt className="font-bold uppercase tracking-wide text-slate-500">Attempts</dt><dd className="mt-1">{incident.attempts}</dd></div>
            <div><dt className="font-bold uppercase tracking-wide text-slate-500">Resolved</dt><dd className="mt-1">{new Date(incident.resolvedAt!).toLocaleString()}</dd></div>
          </dl>
        ))}
      </div>
    </div>
  );
}

function StripeReconciliationIncident({ invoice }: { invoice: any }) {
  const incident = [...(invoice.audit ?? [])]
    .reverse()
    .find((entry: any) => entry.action === "stripe_reconciliation_failed");
  if (!incident) return null;

  const details = incident.details ?? {};
  const eventId = typeof details.stripeEventId === "string" ? details.stripeEventId : "Unavailable";
  const attempts = typeof details.attemptCount === "number" ? details.attemptCount : 1;
  const error = typeof details.lastError === "string" ? details.lastError : "Reconciliation failed without a recorded reason.";
  const lastSeen = typeof details.lastSeenAt === "string" ? details.lastSeenAt : incident.created_at;

  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
        <div className="min-w-0">
          <h2 className="font-serif text-xl font-bold text-rose-950">Stripe payment needs attention</h2>
          <p className="mt-1 text-sm text-rose-800">
            CRM reconciliation failed after Stripe accepted the webhook. This incident is updated on repeated delivery.
          </p>
        </div>
      </div>
      <dl className="mt-4 grid gap-3 text-xs text-rose-900 sm:grid-cols-2">
        <div><dt className="font-bold uppercase tracking-wide text-rose-700">Stripe event</dt><dd className="mt-1 break-all font-mono">{eventId}</dd></div>
        <div><dt className="font-bold uppercase tracking-wide text-rose-700">Attempts</dt><dd className="mt-1">{attempts}</dd></div>
        <div className="sm:col-span-2"><dt className="font-bold uppercase tracking-wide text-rose-700">Latest error</dt><dd className="mt-1 break-words">{error}</dd></div>
        <div className="sm:col-span-2"><dt className="font-bold uppercase tracking-wide text-rose-700">Last seen</dt><dd className="mt-1">{new Date(lastSeen).toLocaleString()}</dd></div>
      </dl>
    </div>
  );
}

function FirstCustomerView({ invoice }: { invoice: any }) {
  const viewedAt = invoice.first_viewed_at;
  return (
    <section className="rounded-2xl border border-[#ded6c9] bg-[#fffdfa] p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <ExternalLink className={`mt-0.5 h-5 w-5 shrink-0 ${viewedAt ? "text-emerald-600" : "text-slate-400"}`} />
        <div>
          <h2 className="font-serif text-xl font-bold text-[#172436]">First CSD invoice view</h2>
          <p className="mt-1 text-sm text-slate-600">
            {viewedAt
              ? `Customer invoice page first opened ${new Date(viewedAt).toLocaleString()}.`
              : "Not opened in the customer invoice page yet."}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Email acceptance confirms provider handoff only; it does not mean the customer opened the invoice.
          </p>
        </div>
      </div>
    </section>
  );
}

function EmailDeliveryPanel({ invoice, reminderDays, setReminderDays, scheduling, onSchedule, onRetry }: { invoice: any; reminderDays: string; setReminderDays: (value: string) => void; scheduling: boolean; onSchedule: () => void; onRetry: (id: number) => void }) {
  const deliveries = invoice.emailDeliveries ?? [];
  return (
    <div className="rounded-2xl border border-[#ded6c9] bg-[#fffdfa] p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-2">
        <Mail className="h-5 w-5 text-slate-400"/>
        <h2 className="font-serif text-xl font-bold text-[#172436]">Communication log</h2>
      </div>

      {invoice.status === "sent" && invoice.due_date && (
        <div className="mt-5 rounded-xl border border-amber-100 bg-amber-50/50 p-4">
          <p className="text-sm font-bold text-[#172436]">Automated overdue reminders</p>
          <p className="mt-1 text-xs text-slate-600">Send automatic emails this many days after the due date. Skips automatically if paid.</p>
          <div className="mt-3 flex gap-2">
            <input value={reminderDays} onChange={e=>setReminderDays(e.target.value)} aria-label="Reminder days after due date" placeholder="e.g. 1, 7, 14" className="min-w-0 flex-1 rounded-md border border-[#ddd5c9] bg-white px-3 py-2 text-sm focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32]"/>
            <button disabled={scheduling} onClick={onSchedule} className="inline-flex items-center rounded-md bg-[#172436] px-4 py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-50">
              <Clock3 className="mr-1.5 h-4 w-4"/> Schedule
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 space-y-3">
        {deliveries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#ddd5c9] p-6 text-center">
            <p className="text-sm text-slate-500">No emails have been sent for this invoice yet.</p>
          </div>
        ) : deliveries.map((delivery: any) => (
          <div key={delivery.id} className="flex items-start justify-between gap-3 rounded-xl border border-[#e5ddd2] bg-white p-4 shadow-sm">
            <div>
              <p className="text-sm font-bold capitalize text-[#172436]">
                {delivery.kind} · {delivery.status === "accepted" ? <span className="text-emerald-600">Accepted by email provider</span> : <span className="text-amber-600">{delivery.status}</span>}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                To: {delivery.recipient_email} <br/>
                {delivery.status === "accepted" && delivery.accepted_at ? `Provider accepted at ${new Date(delivery.accepted_at).toLocaleString()}` : `Scheduled for ${new Date(delivery.scheduled_at).toLocaleString()}`}
              </p>
              {delivery.last_error && <p className="mt-1.5 text-xs font-medium text-rose-600">Error: {delivery.last_error}</p>}
            </div>
            {delivery.status === "failed" && (
              <button onClick={()=>onRetry(delivery.id)} className="inline-flex items-center gap-1.5 rounded-md bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 transition hover:bg-rose-100">
                <RefreshCw className="h-3.5 w-3.5"/> Retry
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}