import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Check, FileText, Mail, Phone, Save, Settings2 } from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";
import { useInvoiceSettings, useUpdateInvoiceSettings, type InvoiceSettings } from "@/hooks/use-invoices";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";

const fieldClass = "mt-2 w-full rounded-lg border border-[#cbd4dc] bg-[#fffefd] px-3.5 py-2.5 text-sm text-[#14253a] outline-none transition focus:border-[#b51f32] focus:ring-2 focus:ring-[#b51f32]/15";
const labelClass = "block text-sm font-semibold text-[#14253a]";
const addDays = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

export default function InvoiceSettingsPage() {
  const settings = useInvoiceSettings();
  const update = useUpdateInvoiceSettings();
  const [form, setForm] = useState<InvoiceSettings | null>(null);
  const [saved, setSaved] = useState<InvoiceSettings | null>(null);
  const [taxPercent, setTaxPercent] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const initialized = useRef(false);

  useEffect(() => {
    if (!settings.data || initialized.current) return;
    initialized.current = true;
    setForm(settings.data);
    setSaved(settings.data);
    setTaxPercent(String(settings.data.defaultTaxRateBps / 100));
  }, [settings.data]);

  const dirty = !!form && !!saved && (JSON.stringify(form) !== JSON.stringify(saved) || Number(taxPercent) * 100 !== form.defaultTaxRateBps);
  useUnsavedChangesGuard(dirty, "Discard your unsaved invoice settings?");

  const patch = (changes: Partial<InvoiceSettings>) => {
    setForm((previous) => previous ? { ...previous, ...changes } : previous);
    setFeedback("");
    setError("");
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const percent = Number(taxPercent);
    if (!form.businessName.trim()) return setError("Enter a business name.");
    if (!Number.isInteger(form.defaultDueDays) || form.defaultDueDays < 1 || form.defaultDueDays > 365) return setError("Due days must be a whole number from 1 to 365.");
    if (taxPercent.trim() === "" || !Number.isFinite(percent) || percent < 0 || percent > 100 || !Number.isInteger(percent * 100)) return setError("Tax rate must be between 0% and 100%, with at most two decimal places.");
    const payload = { ...form, businessName: form.businessName.trim(), defaultTaxRateBps: Math.round(percent * 100) };
    try {
      setError("");
      setFeedback("");
      const result = await update.mutateAsync(payload);
      setForm(result);
      setSaved(result);
      setTaxPercent(String(result.defaultTaxRateBps / 100));
      setFeedback("Invoice settings saved. New drafts will use these defaults.");
    } catch (failure) {
      setError((failure as Error).message || "Settings could not be saved. Try again.");
    }
  };

  if (settings.isLoading) return <main aria-busy="true" className="min-h-[100dvh] bg-[#f3f5f7] p-6"><div className="mx-auto max-w-6xl animate-pulse space-y-6"><div className="h-12 w-52 rounded bg-[#dce2e8]" /><div className="h-28 rounded-xl bg-[#e2e7eb]" /><div className="grid gap-5 md:grid-cols-2"><div className="h-96 rounded-xl bg-[#e2e7eb]" /><div className="h-96 rounded-xl bg-[#e2e7eb]" /></div></div></main>;
  if (settings.isError || !form) return <main className="min-h-[100dvh] bg-[#f3f5f7] p-6"><div className="mx-auto max-w-xl rounded-xl border border-[#dce2e8] bg-[#fffefd] p-8"><h1 className="text-xl font-semibold text-[#14253a]">Invoice settings unavailable</h1><p className="mt-2 text-sm text-[#59697a]">Your current settings could not be loaded. Nothing has been changed.</p><button type="button" data-testid="button-retry-invoice-settings" onClick={() => settings.refetch()} className="mt-5 rounded-lg bg-[#14253a] px-5 py-2.5 text-sm font-semibold text-white">Try again</button></div></main>;

  const accent = form.accentColor === "navy" ? "#14253a" : "#b51f32";
  return <main className="min-h-[100dvh] bg-[#f3f5f7] p-4 text-[#14253a] lg:p-8">
    <div className="mx-auto max-w-6xl">
      <Link href="/invoices" data-testid="link-back-invoices" className="inline-flex items-center gap-2 text-sm font-semibold text-[#59697a] hover:text-[#b51f32]"><ArrowLeft className="h-4 w-4" /> Invoice desk</Link>
      <header className="mb-8 mt-6 flex flex-col justify-between gap-5 border-b border-[#dce2e8] pb-7 sm:flex-row sm:items-end">
        <div><div className="mb-5 flex items-center gap-3"><img src={csdLogo} alt="Computer Systems Depot" className="h-8 w-auto object-contain" /><span className="h-6 w-px bg-[#cbd4dc]" /><span className="text-xs font-bold uppercase tracking-[.18em] text-[#b51f32]">Billing</span></div><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Invoice settings</h1><p className="mt-2 max-w-xl text-sm leading-6 text-[#59697a]">Make every customer invoice feel like it came from your desk. Defaults apply to new drafts only.</p></div>
        <div className="flex items-center gap-2 rounded-full border border-[#dce2e8] bg-[#fffefd] px-3 py-1.5 text-xs font-semibold text-[#59697a]"><Settings2 className="h-3.5 w-3.5" /> Owner settings</div>
      </header>
      <form onSubmit={save} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm sm:p-7">
            <div className="mb-6 flex items-start gap-3"><div className="rounded-lg bg-[#f7e9eb] p-2.5 text-[#b51f32]"><FileText className="h-5 w-5" /></div><div><h2 className="text-lg font-semibold">Customer-facing identity</h2><p className="mt-1 text-sm text-[#59697a]">Shown alongside the existing CSD logo on public invoices.</p></div></div>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className={labelClass}>Business name<input data-testid="input-invoice-business-name" required maxLength={160} value={form.businessName} onChange={e => patch({ businessName: e.target.value })} className={fieldClass} /></label>
              <fieldset><legend className={labelClass}>Accent color</legend><div className="mt-2 flex gap-2">{(["red", "navy"] as const).map(color => <label key={color} className={`flex flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${form.accentColor === color ? "border-[#14253a] bg-[#f3f5f7]" : "border-[#cbd4dc] hover:bg-[#f3f5f7]"}`}><input data-testid={`input-invoice-accent-${color}`} type="radio" name="accentColor" value={color} checked={form.accentColor === color} onChange={() => patch({ accentColor: color })} className="accent-[#b51f32]" /><span className={`h-3 w-3 rounded-full ${color === "red" ? "bg-[#b51f32]" : "bg-[#14253a]"}`} />{color === "red" ? "CSD red" : "Navy"}</label>)}</div></fieldset>
              <label className={labelClass}>Contact email<input data-testid="input-invoice-contact-email" type="email" maxLength={254} value={form.contactEmail ?? ""} onChange={e => patch({ contactEmail: e.target.value })} placeholder="billing@yourbusiness.com" className={fieldClass} /></label>
              <label className={labelClass}>Contact phone<input data-testid="input-invoice-contact-phone" type="tel" maxLength={60} value={form.contactPhone ?? ""} onChange={e => patch({ contactPhone: e.target.value })} placeholder="(000) 000-0000" className={fieldClass} /></label>
            </div>
            <label className={`${labelClass} mt-5`}>Invoice footer<textarea data-testid="input-invoice-footer" maxLength={500} value={form.footer ?? ""} onChange={e => patch({ footer: e.target.value })} rows={3} placeholder="Questions? Reach out to our billing team." className={`${fieldClass} resize-y whitespace-pre-wrap`} /><span className="mt-1 block text-xs font-normal text-[#738092]">Appears on the CSD invoice page and new Stripe PDFs. Stripe account logo and colors are managed separately.</span></label>
          </section>
          <section className="rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm sm:p-7">
            <div className="mb-6"><h2 className="text-lg font-semibold">New draft defaults</h2><p className="mt-1 text-sm text-[#59697a]">A head start, not a lock. Staff can change these on each invoice or apply a template.</p></div>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className={labelClass}>Due after (days)<input data-testid="input-invoice-default-due-days" type="number" required min={1} max={365} step={1} value={form.defaultDueDays} onChange={e => patch({ defaultDueDays: Number(e.target.value) })} className={fieldClass} /><span className="mt-1 block text-xs font-normal text-[#738092]">1–365 days after creation</span></label>
              <label className={labelClass}>Tax rate (%)<div className="relative"><input data-testid="input-invoice-default-tax-rate" type="number" required min={0} max={100} step="0.01" value={taxPercent} onChange={e => { setTaxPercent(e.target.value); setFeedback(""); setError(""); }} className={`${fieldClass} pr-10`} /><span className="absolute right-4 top-5 text-sm text-[#738092]">%</span></div><span className="mt-1 block text-xs font-normal text-[#738092]">0–100%, up to two decimals</span></label>
            </div>
            <label className={`${labelClass} mt-5`}>Default note<textarea data-testid="input-invoice-default-notes" maxLength={10000} rows={4} value={form.defaultNotes ?? ""} onChange={e => patch({ defaultNotes: e.target.value })} placeholder="A short note to include on new invoices" className={`${fieldClass} resize-y whitespace-pre-wrap`} /></label>
          </section>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#dce2e8] bg-[#fffefd] p-4 sm:px-6">
            <div aria-live="polite" className="text-sm">{error ? <p role="alert" data-testid="status-invoice-settings-error" className="font-medium text-[#a31e31]">{error}</p> : feedback ? <p data-testid="status-invoice-settings-saved" className="flex items-center gap-2 font-medium text-[#206855]"><Check className="h-4 w-4" />{feedback}</p> : <p className="text-[#59697a]">{dirty ? "You have unsaved changes." : "Everything is up to date."}</p>}</div>
            <button type="submit" data-testid="button-save-invoice-settings" disabled={!dirty || update.isPending} className="inline-flex items-center gap-2 rounded-lg bg-[#b51f32] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#94172a] disabled:cursor-not-allowed disabled:opacity-50"><Save className="h-4 w-4" />{update.isPending ? "Saving…" : "Save settings"}</button>
          </div>
        </div>
        <aside className="lg:sticky lg:top-6"><div className="overflow-hidden rounded-2xl border border-[#dce2e8] bg-[#fffefd] shadow-[0_8px_32px_rgba(20,37,58,.05)]"><div className="px-6 py-5" style={{ borderTop: `4px solid ${accent}` }}><p className="text-[11px] font-bold uppercase tracking-[.16em] text-[#738092]">Customer view · Preview</p><img src={csdLogo} alt="Computer Systems Depot" className="mt-5 h-10 w-auto max-w-[190px] object-contain object-left" /><p className="mt-6 text-xs font-bold uppercase tracking-widest" style={{ color: accent }}>{form.businessName || "Business name"}</p><h3 className="mt-2 text-2xl font-semibold">Invoice</h3><p className="mt-1 text-xs text-[#59697a]">Due {addDays(Number.isFinite(form.defaultDueDays) ? form.defaultDueDays : 15)}</p></div><div className="border-t border-[#e4e8ec] px-6 py-5 text-sm"><p className="font-semibold">Questions about your invoice?</p>{form.contactEmail && <p className="mt-3 flex items-start gap-2 break-all text-[#59697a]"><Mail className="mt-0.5 h-4 w-4 shrink-0" />{form.contactEmail}</p>}{form.contactPhone && <p className="mt-2 flex items-start gap-2 text-[#59697a]"><Phone className="mt-0.5 h-4 w-4 shrink-0" />{form.contactPhone}</p>}{form.footer && <p className="mt-5 whitespace-pre-wrap border-t border-[#e4e8ec] pt-4 text-xs leading-5 text-[#59697a]">{form.footer}</p>}</div></div><p className="mt-3 px-1 text-xs leading-5 text-[#738092]">Preview shows identity and contact details. Payment options and invoice amounts remain unchanged.</p></aside>
      </form>
    </div>
  </main>;
}