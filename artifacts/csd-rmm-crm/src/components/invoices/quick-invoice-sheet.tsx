import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { AlertCircle, ArrowRight, Loader2, Plus, Sparkles, Trash2, Wrench } from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import CatalogLinePicker from "@/components/invoices/catalog-line-picker";
import BillingPartyPicker, {
  partyToSelection,
  recipientFor,
  selectionEmail,
  selectionName,
  selectionOrg,
  type BillingSelection,
} from "@/components/invoices/billing-party-picker";
import {
  useBillingParties,
  useCreateInvoice,
  useCreateInvoiceTemplate,
  useDeleteInvoiceTemplate,
  useInvoiceTemplates,
  useInvoiceSettings,
  useSendInvoice,
  useServicePresets,
  type BillingParty,
  type Invoice,
} from "@/hooks/use-invoices";

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

type Line = { description: string; quantity: number; unitAmountCents: number };

const emptyLine = (): Line => ({ description: "", quantity: 1, unitAmountCents: 0 });

/** apiRequest throws "<status>: <body>"; show the server's sentence, not the wrapper. */
const readError = (failure: unknown) => {
  const body = String((failure as Error)?.message ?? "").replace(/^\d+:\s*/, "");
  try {
    const parsed = JSON.parse(body);
    return parsed.error || parsed.message || body;
  } catch {
    return body;
  }
};

const isoDateIn = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const TERMS = [
  { label: "Due on receipt", days: 0 },
  { label: "Net 15", days: 15 },
  { label: "Net 30", days: 30 },
];

/**
 * One-screen invoice creation: pick anyone in the CRM (or type a brand new
 * name), add the work, save or send. The full editor at /invoices/:id stays
 * available for the rarer cases — PayPal links, reminders.
 */
export default function QuickInvoiceSheet({
  open,
  onOpenChange,
  initialParty,
  initialOffer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialParty?: BillingParty | null;
  initialOffer?: { name: string; unitAmountCents: number; message: string; email: string; originInquiryId: string; correctionOfInvoiceId?: number } | null;
}) {
  const [, setLocation] = useLocation();
  const parties = useBillingParties();
  const presets = useServicePresets();
  const templates = useInvoiceTemplates();
  const settings = useInvoiceSettings();
  const create = useCreateInvoice();
  const createTemplate = useCreateInvoiceTemplate();
  const deleteTemplate = useDeleteInvoiceTemplate();
  const send = useSendInvoice();

  const [selection, setSelection] = useState<BillingSelection | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [dueDate, setDueDate] = useState(isoDateIn(15));
  const [notes, setNotes] = useState("");
  const [taxRateBps, setTaxRateBps] = useState(0);
  const [discountCents, setDiscountCents] = useState(0);
  const [templateLabel, setTemplateLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [existingInvoiceId, setExistingInvoiceId] = useState<number | null>(null);
  const submitting = useRef(false);
  const defaultsApplied = useRef(false);
  const editedDefaults = useRef({ due: false, notes: false, tax: false });

  useEffect(() => {
    if (!open) return;
    void parties.refetch();
    setSelection(initialParty ? partyToSelection(initialParty) : null);
    setJobId(null);
    setLines(initialOffer ? [{ description: initialOffer.name, quantity: 1, unitAmountCents: initialOffer.unitAmountCents }] : [emptyLine()]);
    defaultsApplied.current = false;
    editedDefaults.current = { due: false, notes: false, tax: false };
    setDueDate(isoDateIn(15));
    setNotes("");
    setTaxRateBps(0);
    setDiscountCents(0);
    setTemplateLabel("");
    setError("");
    setBusy(null);
    setExistingInvoiceId(null);
  // A picker refetch may replace the party object without changing who was
  // selected. Do not discard an in-progress invoice on that background refresh.
  }, [open, initialParty?.key, initialOffer]);

  useEffect(() => {
    if (!open || !settings.data || defaultsApplied.current) return;
    defaultsApplied.current = true;
    if (!editedDefaults.current.due) setDueDate(isoDateIn(settings.data.defaultDueDays));
    if (!editedDefaults.current.notes) setNotes(settings.data.defaultNotes);
    if (!editedDefaults.current.tax) setTaxRateBps(settings.data.defaultTaxRateBps);
  }, [open, settings.data, initialOffer]);

  const openJobs = selection?.kind === "party" ? selection.party.openJobs : [];
  const email = selection ? selectionEmail(selection) : "";

  const subtotal = useMemo(
    () => lines.reduce((total, line) => total + (line.quantity || 0) * (line.unitAmountCents || 0), 0),
    [lines],
  );
  // Discount comes off before sales tax.
  const taxCents = Math.round((Math.max(0, subtotal - discountCents) * taxRateBps) / 10000);
  const total = subtotal - discountCents + taxCents;

  const quickServices = useMemo(() => {
    return (presets.data ?? []).filter((preset) => preset.description.trim().length > 0).slice(0, 6);
  }, [presets.data]);

  const setLine = (index: number, changes: Partial<Line>) =>
    setLines((current) => current.map((line, position) => (position === index ? { ...line, ...changes } : line)));

  const addService = (description: string, unitAmountCents: number) =>
    setLines((current) => {
      const blank = current.findIndex((line) => !line.description.trim() && !line.unitAmountCents);
      const line = { description, quantity: 1, unitAmountCents };
      if (blank === -1) return [...current, line];
      return current.map((existing, index) => (index === blank ? line : existing));
    });

  const attachJob = (job: { id: number; jobNumber: string; serviceType: string; description: string | null; estimatedAmountCents: number | null }) => {
    if (jobId === job.id) {
      setJobId(null);
      return;
    }
    setJobId(job.id);
    addService(
      job.description?.trim() || `${job.serviceType.replaceAll("_", " ")} — ${job.jobNumber}`,
      job.estimatedAmountCents ?? 0,
    );
  };

  const applyTemplate = (template: NonNullable<typeof templates.data>[number]) => {
    editedDefaults.current = { due: true, notes: true, tax: true };
    setLines(template.lineItems.map((line) => ({ ...line })));
    setDueDate(isoDateIn(template.dueDays));
    setNotes(template.notes ?? "");
    setTaxRateBps(template.taxRateBps);
    setDiscountCents(template.discountCents);
    setError("");
  };

  const removeTemplate = async (id: number) => {
    if (!window.confirm("Delete this reusable invoice template?")) return;
    setError("");
    try {
      await deleteTemplate.mutateAsync(id);
    } catch (failure) {
      setError(readError(failure) || "The invoice template could not be deleted.");
    }
  };

  const saveTemplate = async () => {
    const label = templateLabel.trim();
    if (!label) return setError("Enter a name for this invoice template.");
    const dueDays = Math.max(0, Math.round(
      (new Date(`${dueDate}T00:00:00`).getTime() - new Date(`${isoDateIn(0)}T00:00:00`).getTime()) / 86_400_000,
    ));
    const knownTerm = TERMS.find((term) => isoDateIn(term.days) === dueDate);
    const terms = knownTerm?.label ?? (dueDays === 0 ? "Due on receipt" : `Net ${dueDays}`);
    setError("");
    try {
      await createTemplate.mutateAsync({
        label,
        lineItems: lines.filter((line) => line.description.trim()).map((line) => ({
          description: line.description.trim(),
          quantity: line.quantity,
          unitAmountCents: line.unitAmountCents,
        })),
        dueDays,
        terms,
        taxRateBps,
        discountCents,
        notes: notes.trim() || null,
      });
      setTemplateLabel("");
    } catch (failure) {
      setError(readError(failure) || "The invoice template could not be saved.");
    }
  };

  const problem = () => {
    if (!selection) return "Choose who this invoice is for.";
    if (lines.every((line) => !line.description.trim())) return "Add at least one line of work.";
    if (lines.some((line) => line.description.trim() && (!Number.isInteger(line.quantity) || line.quantity < 1))) return "Every line needs a whole-number quantity of at least 1.";
    if (discountCents > subtotal) return "Discount cannot exceed the subtotal.";
    return "";
  };

  const submit = async (mode: "draft" | "send") => {
    if (submitting.current) return;
    if (existingInvoiceId) {
      onOpenChange(false);
      setLocation(`/invoices/${existingInvoiceId}`);
      return;
    }
    if (!settings.data) return setError("Invoice settings have not loaded. Please try again shortly.");
    const invalid = problem();
    if (invalid) return setError(invalid);
    if (mode === "send" && !email) return setError("This customer has no email address yet — save the draft and add one first.");

    setError("");
    submitting.current = true;
    setBusy(mode);
    let savedInvoiceId: number | null = null;
    try {
      const invoice = (await create.mutateAsync({
        ...(initialOffer ? { originInquiryId: initialOffer.originInquiryId, correctionOfInvoiceId: initialOffer.correctionOfInvoiceId } : {}),
        recipient: recipientFor(selection!),
        jobId,
        dueDate,
        notes: notes.trim() || null,
        taxRateBps,
        discountCents,
        lineItems: lines
          .filter((line) => line.description.trim())
          .map((line) => ({
            description: line.description.trim(),
            quantity: line.quantity,
            unitAmountCents: line.unitAmountCents,
          })),
      })) as unknown as Invoice;

      savedInvoiceId = invoice.id;
      if (mode === "send") await send.mutateAsync(invoice.id);
      onOpenChange(false);
      setLocation(`/invoices/${invoice.id}`);
    } catch (failure) {
      let conflictId: number | null = null;
      try {
        const body = JSON.parse(String((failure as Error)?.message ?? "").replace(/^\d+:\s*/, ""));
        if (Number.isInteger(body.invoiceId) && body.invoiceId > 0) conflictId = body.invoiceId;
      } catch { /* Network failures have no JSON body; the queue still refetches. */ }
      setExistingInvoiceId(savedInvoiceId ?? conflictId);
      setError(savedInvoiceId ? `Invoice saved, but sending could not be confirmed. Open the saved invoice to check its status. ${readError(failure)}` : readError(failure) || "The invoice could not be saved.");
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 border-l border-[#dce2e8] bg-[#f3f5f7] p-0 sm:max-w-2xl">
        <SheetHeader className="space-y-0 border-b border-[#dce2e8] bg-[#fffefd] px-5 pb-5 pt-6 text-left sm:px-7">
          <img src={csdLogo} alt="Computer Systems Depot" className="mb-5 h-8 w-auto max-w-[155px] object-contain object-left" />
          <p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#b51f32]">New invoice / 01 — Details</p>
          <SheetTitle className="mt-2 text-2xl font-semibold tracking-tight text-[#14253a]">Create an invoice</SheetTitle>
          <SheetDescription className="mt-1 text-sm text-[#59697a]">Add a recipient and the work. Save a draft or send it by email.</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
           {initialOffer && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-[#14253a]">
             <strong>Marketplace request from {initialOffer.email}</strong>
             <p className="mt-2 whitespace-pre-wrap break-words">{initialOffer.message}</p>
             <p className="mt-2 text-xs text-amber-800">This request is for staff reference only. Review the recipient and price before sending; the buyer has not paid.</p>
             {initialOffer.correctionOfInvoiceId && <p className="mt-2 font-semibold text-amber-900">Correction: this creates a separate invoice. The original is not cancelled or refunded.</p>}
           </div>}
          {existingInvoiceId && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
            An invoice already exists. <Link href={`/invoices/${existingInvoiceId}`} onClick={() => onOpenChange(false)} className="font-semibold text-[#b51f32] underline">Open saved invoice</Link> instead of creating another.
          </p>}
          {templates.data && templates.data.length > 0 && (
            <section className="rounded-xl border border-[#dce2e8] bg-[#fffefd] p-4">
              <h3 className="mb-2.5 text-xs font-bold uppercase tracking-wide text-[#59697a]">Start from a template</h3>
              <div className="flex flex-wrap gap-1.5">
                {templates.data.map((template) => (
                  <div key={template.id} className="inline-flex items-center overflow-hidden rounded-lg border border-[#ddd5c9] bg-[#faf8f4]">
                    <button
                      type="button"
                      onClick={() => applyTemplate(template)}
                      className="px-2.5 py-1.5 text-xs font-bold text-[#172436] hover:bg-slate-100"
                      data-testid={`button-apply-invoice-template-${template.id}`}
                    >
                      {template.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeTemplate(template.id)}
                      aria-label={`Delete ${template.label} template`}
                      disabled={deleteTemplate.isPending}
                      className="border-l border-[#ddd5c9] px-2 py-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                      data-testid={`button-delete-invoice-template-${template.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
           <section className="rounded-xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm">
             <div className="mb-4 flex items-center gap-3">
               <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#14253a] text-xs font-bold text-white">1</span>
               <div>
                 <h3 className="text-base font-semibold text-[#14253a]">Bill to</h3>
                 <p className="text-xs text-[#738092]">Select a customer or add a new recipient.</p>
               </div>
             </div>
            <BillingPartyPicker
              parties={parties.data ?? []}
              loading={parties.isLoading}
               error={parties.isError}
               onRetry={() => { void parties.refetch(); }}
              value={selection}
              onChange={(next) => {
                setSelection(next);
                setJobId(null);
                setError("");
              }}
            />
            {selection && !email && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                No email on file, so this one can be saved as a draft but not emailed yet.
              </p>
            )}
            {selection?.kind === "party" && selectionOrg(selection) && (
              <p className="mt-2 text-xs text-slate-500">Billed to {selectionOrg(selection)} · {selectionName(selection)}</p>
            )}

            {openJobs.length > 0 && (
              <div className="mt-3 border-t border-[#eee7dc] pt-3">
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  <Wrench className="h-3.5 w-3.5 text-amber-600" />
                  Open work — tap to bill it
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {openJobs.map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => attachJob(job)}
                      data-testid={`button-attach-job-${job.id}`}
                      className={`rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                        jobId === job.id
                          ? "border-[#b21f32] bg-[#b21f32]/5 text-[#b21f32]"
                          : "border-[#ddd5c9] bg-white text-slate-600 hover:border-[#b21f32]/40"
                      }`}
                    >
                      <span className="font-bold">{job.jobNumber}</span>
                      <span className="ml-1.5 opacity-80">{job.serviceType.replaceAll("_", " ")}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

           <section className="rounded-xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm">
            <div className="mb-2.5 flex items-center justify-between">
               <div className="flex items-center gap-3">
                 <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#14253a] text-xs font-bold text-white">2</span>
                 <h3 className="text-base font-semibold text-[#14253a]">Services &amp; charges</h3>
               </div>
              <button
                type="button"
                onClick={() => setLines((current) => [...current, emptyLine()])}
                data-testid="button-add-line"
                className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-[#172436] transition hover:bg-slate-200"
              >
                <Plus className="h-3.5 w-3.5" /> Line
              </button>
            </div>

             {quickServices.length > 0 && <p className="mb-2 text-xs text-[#738092]">Frequently billed services</p>}
             <div className="mb-3 flex flex-wrap gap-1.5">
              {quickServices.map((preset) => (
                <button
                  key={preset.description}
                  type="button"
                  onClick={() => addService(preset.description, preset.unitAmountCents)}
                  data-testid={`button-preset-${preset.description.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}
                  className="inline-flex items-center gap-1 rounded-full border border-[#ddd5c9] bg-[#faf8f4] px-2.5 py-1 text-xs text-slate-600 transition hover:border-[#b21f32]/40 hover:text-[#172436]"
                >
                  <Sparkles className="h-3 w-3 text-[#b21f32]" />
                  {preset.description}
                  <span className="font-mono text-[11px] text-slate-400">{usd(preset.unitAmountCents)}</span>
                </button>
              ))}
            </div>

             <CatalogLinePicker onSelect={(item) => addService(item.name, item.unitAmountCents)} />
             <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2 rounded-xl border border-[#e5ddd2] bg-[#faf8f4] p-2">
                  <input
                    value={line.description}
                    onChange={(event) => setLine(index, { description: event.target.value })}
                    placeholder="What was done?"
                    data-testid={`input-line-description-${index}`}
                    className="min-w-[9rem] flex-1 rounded-md border border-[#ddd5c9] bg-white px-2.5 py-2 text-sm outline-none focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32]"
                  />
                  <input
                    type="number"
                    min={1}
                    value={line.quantity || ""}
                    onChange={(event) => setLine(index, { quantity: Number(event.target.value) })}
                    aria-label="Quantity"
                    data-testid={`input-line-quantity-${index}`}
                    className="w-14 rounded-md border border-[#ddd5c9] bg-white px-2 py-2 text-center text-sm outline-none focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32]"
                  />
                  <div className="relative w-24">
                    <span className="absolute left-2 top-2 text-slate-400">$</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitAmountCents ? (line.unitAmountCents / 100).toString() : ""}
                      onChange={(event) => setLine(index, { unitAmountCents: Math.round(Number(event.target.value) * 100) })}
                      aria-label="Unit price"
                      data-testid={`input-line-price-${index}`}
                      className="w-full rounded-md border border-[#ddd5c9] bg-white py-2 pl-5 pr-2 text-right text-sm outline-none focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32]"
                    />
                  </div>
                  <span className="w-20 text-right font-mono text-sm font-bold text-[#172436]">
                    {usd((line.quantity || 0) * (line.unitAmountCents || 0))}
                  </span>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      aria-label="Remove line"
                      onClick={() => setLines((current) => current.filter((_, position) => position !== index))}
                      className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

           <section className="rounded-xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm">
             <div className="mb-4 flex items-center gap-3">
               <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#14253a] text-xs font-bold text-white">3</span>
               <h3 className="text-base font-semibold text-[#14253a]">Terms &amp; details</h3>
             </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {TERMS.map((term) => (
                <button
                  key={term.label}
                  type="button"
                  onClick={() => { editedDefaults.current.due = true; setDueDate(isoDateIn(term.days)); }}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-bold uppercase tracking-wide transition ${
                    dueDate === isoDateIn(term.days) ? "bg-[#172436] text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {term.label}
                </button>
              ))}
              <input
                type="date"
                value={dueDate}
                onChange={(event) => { editedDefaults.current.due = true; setDueDate(event.target.value); }}
                data-testid="input-due-date"
                className="rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-2.5 py-1.5 text-sm outline-none focus:border-[#b21f32]"
              />
            </div>
            <textarea
              value={notes}
              onChange={(event) => { editedDefaults.current.notes = true; setNotes(event.target.value); }}
              placeholder="Note on the invoice (optional) — e.g. thank you for your business."
              data-testid="input-notes"
              className="mt-3 min-h-16 w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] p-2.5 text-sm outline-none focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32]"
            />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Tax rate (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={taxRateBps / 100}
                  onChange={(event) => { editedDefaults.current.tax = true; setTaxRateBps(Math.max(0, Math.min(10000, Math.round(Number(event.target.value) * 100)))); }}
                  data-testid="input-tax-rate"
                  className="mt-1 w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-2.5 py-2 text-sm font-normal text-slate-800 outline-none focus:border-[#b21f32]"
                />
              </label>
              <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Discount ($)
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={discountCents / 100}
                  onChange={(event) => setDiscountCents(Math.max(0, Math.round(Number(event.target.value) * 100)))}
                  data-testid="input-discount"
                  className="mt-1 w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-2.5 py-2 text-sm font-normal text-slate-800 outline-none focus:border-[#b21f32]"
                />
              </label>
            </div>
            <div className="mt-3 flex items-end gap-2 border-t border-[#eee7dc] pt-3">
              <label className="flex-1 text-xs font-bold uppercase tracking-wide text-slate-500">
                Save these details as a template
                <input
                  value={templateLabel}
                  onChange={(event) => setTemplateLabel(event.target.value)}
                  maxLength={80}
                  placeholder="e.g. Monthly maintenance"
                  data-testid="input-invoice-template-label"
                  className="mt-1 w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-2.5 py-2 text-sm font-normal normal-case tracking-normal text-slate-800 outline-none focus:border-[#b21f32]"
                />
              </label>
              <button
                type="button"
                onClick={saveTemplate}
                disabled={createTemplate.isPending}
                data-testid="button-save-invoice-template"
                className="rounded-md bg-[#172436] px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-700 disabled:opacity-60"
              >
                {createTemplate.isPending ? "Saving…" : "Save template"}
              </button>
            </div>
          </section>

          {error && (
            <p className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800" data-testid="text-quick-invoice-error">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          )}
        </div>

         <footer className="border-t border-[#dce2e8] bg-[#fffefd] p-4 shadow-[0_-6px_20px_rgba(20,37,58,.04)] sm:px-6">
          <div className="mb-3 flex items-baseline justify-between">
             <span className="text-xs font-bold uppercase tracking-wide text-[#59697a]">Invoice total</span>
             <span className="text-2xl font-bold tracking-tight text-[#14253a]" data-testid="text-quick-invoice-total">{usd(total)}</span>
          </div>
          <div className="mb-3 flex justify-end gap-3 text-xs text-slate-500">
            <span>Subtotal {usd(subtotal)}</span>
            <span>Discount −{usd(discountCents)}</span>
            <span>Tax {usd(taxCents)}</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => submit("draft")}
              disabled={busy !== null}
              data-testid="button-save-draft"
              className="flex-1 rounded-lg border border-[#ddd5c9] bg-white px-4 py-2.5 text-sm font-bold text-[#172436] transition hover:bg-slate-50 disabled:opacity-60"
            >
              {busy === "draft" ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              onClick={() => submit("send")}
              disabled={busy !== null}
              data-testid="button-create-and-send"
               className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#b51f32] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#94172a] disabled:opacity-60"
            >
              {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {busy === "send" ? "Sending…" : "Create & send"}
            </button>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  );
}
