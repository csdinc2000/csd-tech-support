import { FormEvent, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { CheckCircle2, FileSignature, ShieldCheck } from "lucide-react";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const contractDate = (value: string) => {
  const datePart = String(value).slice(0, 10);
  const date = new Date(`${datePart}T12:00:00`);
  return Number.isNaN(date.getTime()) ? datePart : date.toLocaleDateString();
};

export default function PublicContract() {
  const { token } = useParams<{ token: string }>();
  const contract = useQuery<any>({ queryKey: [`/api/public/contracts/${token}`], retry: false });
  const [form, setForm] = useState({ signerName: "", signerTitle: "", signerEmail: "", signatureText: "", consent: false });
  const sign = useMutation({
    mutationFn: () => apiRequest("POST", `/api/public/contracts/${token}/sign`, form),
    onSuccess: () => contract.refetch(),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); sign.mutate(); };

  if (contract.isLoading) return <div className="min-h-screen bg-stone-100 p-8 text-center">Loading agreement…</div>;
  if (contract.isError || !contract.data) return <div className="min-h-screen bg-stone-100 p-8"><div className="mx-auto max-w-lg rounded-xl border bg-white p-8 text-center"><h1 className="text-xl font-bold">Agreement unavailable</h1><p className="mt-2 text-sm text-stone-600">{contract.error instanceof ApiRequestError && contract.error.status === 404 ? "This link is no longer valid. A newer signing link may have replaced it. Please ask Computer Systems Depot for a fresh link." : (contract.error as Error)?.message || "This link is invalid or expired."}</p></div></div>;
  const c = contract.data;
  const signed = c.status === "signed";

  return <div className="min-h-screen bg-stone-100 px-3 py-6 sm:px-6">
    <main className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-stone-300 bg-white shadow-lg">
      <header className="border-b-4 border-csd-red bg-stone-950 px-6 py-7 text-white sm:px-10">
        <div className="text-xs font-bold uppercase tracking-[0.18em] text-red-300">Computer Systems Depot Inc.</div>
        <h1 className="mt-2 text-2xl font-bold">{c.title}</h1>
        <p className="mt-2 text-sm text-stone-300">{c.clientName} · Effective {contractDate(c.effectiveDate)}</p>
      </header>
      <article className="space-y-7 px-6 py-8 text-sm leading-6 text-stone-800 sm:px-10">
        <p>This Computer Systems Maintenance Agreement is between <strong>{c.providerName}</strong>, {c.providerAddress} (“Provider”), and <strong>{c.clientName}</strong>, {c.clientAddress} (“Client”).</p>
        <Section title="1. TERM AND FEES"><p>The agreement begins {contractDate(c.effectiveDate)} for one year and {c.renewalType === "auto_annual" ? "renews automatically for successive one-year terms unless either party gives written notice as provided in this agreement" : c.renewalType === "month_to_month" ? "continues month-to-month after the first year" : "ends after the initial one-year term"}. Client will pay {money(c.annualValueCents)} annually in monthly installments of {money(c.monthlyPaymentCents)}. Overdue amounts may accrue interest at the lesser of 1.5% per month or the maximum lawful rate.</p></Section>
        <Section title="2. INCLUDED SUPPORT"><p>{c.terms.includedSupport}</p><p><strong>Support hours:</strong> {c.supportHours}. <strong>Critical-response target:</strong> {c.responseTimeSla}. Response time is an acknowledgement target, not a guaranteed resolution time.</p></Section>
        <Section title="3. DEVICE AND USER LIMITS"><p>{c.terms.deviceLimits}</p></Section>
        <Section title="4. ONSITE WORK AND PROJECTS"><p>{c.terms.onsiteWork}</p><p>Office relocations, major migrations, deployments, cabling, and other substantial work are Projects outside recurring maintenance and require a separate Statement of Work.</p></Section>
        <Section title="5. HARDWARE, LICENSES, AND BACKUPS"><p>Replacement parts, hardware, equipment, consumables, and third-party software or cloud licenses are excluded unless expressly listed. {c.terms.backups}</p></Section>
        <Section title="6. SECURITY AND DATA PROTECTION"><p>Each party will maintain reasonable safeguards. The parties will cooperate regarding notice obligations under the Florida Information Protection Act, Fla. Stat. § 501.171. Provider will notify Client without unreasonable delay after confirming a covered incident and the parties will collaborate during an initial 30-day investigation and notification window, subject to legal requirements. Provider is not liable for breaches caused solely by undisclosed client systems, ignored recommendations, phishing or other end-user action, zero-day exploits, or evolving threats beyond reasonable control.</p></Section>
        <Section title="7. GOVERNING LAW; VENUE; ATTORNEY'S FEES"><p>Florida law governs this agreement. Exclusive venue and jurisdiction lie in the state or federal courts located in Broward County, Florida. The prevailing party in an action arising from this agreement is entitled to recover reasonable attorney’s fees and costs.</p></Section>
        <Section title="8. GENERAL TERMS"><p>Neither party is liable for indirect, special, or consequential damages to the extent permitted by law. This agreement and any signed Statement of Work are the entire agreement and may be amended only in writing signed by both parties. If a provision is unenforceable, the remainder remains effective. Electronic signatures and counterparts are accepted.</p></Section>
        <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">This agreement is a general business template and not legal advice. Each party may consult independent counsel before signing.</div>

        {signed ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center"><CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" /><h2 className="mt-3 text-lg font-bold text-emerald-950">Agreement signed</h2><p className="mt-1 text-emerald-800">Signed by {c.signerName} on {new Date(c.signedAt).toLocaleString()}.</p></div> :
        <form onSubmit={submit} className="rounded-xl border-2 border-stone-300 p-5">
          <h2 className="flex items-center gap-2 text-lg font-bold"><FileSignature className="h-5 w-5 text-csd-red" /> Client acceptance</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Labeled label="Authorized signer"><Input required value={form.signerName} onChange={(e) => setForm({ ...form, signerName: e.target.value })} /></Labeled>
            <Labeled label="Title"><Input required value={form.signerTitle} onChange={(e) => setForm({ ...form, signerTitle: e.target.value })} /></Labeled>
            <Labeled label="Email"><Input required type="email" value={form.signerEmail} onChange={(e) => setForm({ ...form, signerEmail: e.target.value })} /></Labeled>
            <Labeled label="Electronic signature (type full name)"><Input required value={form.signatureText} onChange={(e) => setForm({ ...form, signatureText: e.target.value })} className="font-serif italic" /></Labeled>
          </div>
          <label className="mt-5 flex items-start gap-3 rounded-md bg-stone-100 p-3 text-sm"><Checkbox checked={form.consent} onCheckedChange={(value) => setForm({ ...form, consent: value === true })} /><span>I am authorized to sign for the Client, I have reviewed this agreement, and I agree that my typed signature is my legally binding electronic signature.</span></label>
          {sign.isError && <p className="mt-3 text-sm text-red-700">{(sign.error as Error).message}</p>}
          <Button className="mt-5 w-full bg-csd-red hover:bg-red-800" disabled={!form.consent || sign.isPending}>{sign.isPending ? "Applying signature…" : "Accept and sign agreement"}</Button>
          <p className="mt-3 flex items-center justify-center gap-1 text-xs text-stone-500"><ShieldCheck className="h-3.5 w-3.5" /> Time, consent, document fingerprint, and signing event are recorded.</p>
        </form>}
      </article>
    </main>
  </div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section><h2 className="mb-2 font-bold uppercase tracking-wide text-stone-950">{title}</h2><div className="space-y-2">{children}</div></section>; }
function Labeled({ label, children }: { label: string; children: React.ReactNode }) { return <label className="text-sm font-medium">{label}<div className="mt-1.5">{children}</div></label>; }