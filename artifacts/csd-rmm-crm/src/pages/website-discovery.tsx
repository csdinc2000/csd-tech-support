import { useState } from "react";
import { Globe2, Search, ShieldCheck, FileText, Users, AlertTriangle, ClipboardList, Info, RefreshCw } from "lucide-react";
import { Link } from "wouter";

const panels = [
  { title: "Businesses Found", icon: Users, note: "Awaiting provider data" },
  { title: "WordPress Sites", icon: Globe2, note: "Not yet searched" },
  { title: "PHP Sites", icon: ShieldCheck, note: "PHP is not always externally detectable" },
  { title: "Review Opportunities", icon: AlertTriangle, note: "No verified findings" },
  { title: "Audit Reports", icon: FileText, note: "No reports generated" },
  { title: "Saved Leads", icon: ClipboardList, note: "No leads imported" },
];

/** Dedicated CRM module. No sample leads or fabricated security findings. */
export default function WebsiteDiscovery() {
  const [location, setLocation] = useState("Lauderhill, FL");
  const [radius, setRadius] = useState("25");
  const [wordpress, setWordpress] = useState(true);
  const [php, setPhp] = useState(true);
  const [notice, setNotice] = useState("");

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 p-4 md:p-6" data-testid="website-discovery-page">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div className="flex gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-red-200 bg-white text-csd-red">
            <Globe2 className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-csd-red">Website Intelligence</p>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Website Discovery &amp; Security Intelligence</h1>
            <p className="text-sm text-muted-foreground">Find business websites, review detectable technologies, and prepare CSD service proposals.</p>
          </div>
        </div>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900">Setup required · Discovery not running</span>
      </header>

      <section className="rounded-xl border bg-white p-4 shadow-sm" aria-label="Website search criteria">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
          <label className="space-y-1 text-sm font-medium">
            <span>Search location</span>
            <input value={location} onChange={e => setLocation(e.target.value)} maxLength={120} className="h-10 w-full rounded-md border px-3 font-normal" placeholder="City, state" />
          </label>
          <label className="space-y-1 text-sm font-medium">
            <span>Radius</span>
            <select value={radius} onChange={e => setRadius(e.target.value)} className="h-10 w-full rounded-md border bg-white px-2 font-normal">
              <option value="10">10 miles</option><option value="25">25 miles</option><option value="50">50 miles</option><option value="100">100 miles</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-3 pb-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={wordpress} onChange={e => setWordpress(e.target.checked)} /> WordPress</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={php} onChange={e => setPhp(e.target.checked)} /> PHP</label>
          </div>
          <button type="button" onClick={() => setNotice("Technology discovery needs a licensed provider API before real search results are available. No external websites were scanned.")} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-csd-red px-5 font-semibold text-white hover:opacity-90">
            <Search className="h-4 w-4" /> Search
          </button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Only approved public business data and licensed technology intelligence will be used. Active security checks require permission.</p>
        {notice && <p role="status" className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{notice}</p>}
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" aria-label="Discovery statistics">
        {panels.map(({title, icon: Icon, note}) => <div key={title} className="rounded-xl border bg-white p-4 shadow-sm">
          <Icon className="mb-3 h-5 w-5 text-csd-red" />
          <div className="text-sm font-semibold">{title}</div>
          <p className="mt-1 text-xs text-muted-foreground">{note}</p>
        </div>)}
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="min-h-[320px] rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <div><h2 className="font-semibold">Discovery Results</h2><p className="text-xs text-muted-foreground">Business leads and publicly visible technology evidence</p></div>
            <span className="text-xs text-muted-foreground">0 verified results</span>
          </div>
          <div className="flex min-h-[250px] flex-col items-center justify-center gap-2 p-8 text-center">
            <Globe2 className="h-9 w-9 text-slate-300" />
            <p className="font-semibold">No discovery results yet</p>
            <p className="max-w-md text-sm text-muted-foreground">Connect an approved technology intelligence provider to populate this table. There are no invented leads, outdated versions, or vulnerability claims.</p>
          </div>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Selected Lead &amp; CSD Opportunity</h2>
          <p className="mt-1 text-sm text-muted-foreground">Select a verified prospect to review evidence and draft an offer.</p>
          <div className="my-5 flex gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700"><Info className="h-5 w-5 shrink-0" /> Audit reports and proposals require a real lead, supporting evidence, and CSD-approved prices.</div>
          <button disabled className="mb-2 w-full rounded-md bg-csd-red px-3 py-2 font-medium text-white opacity-50">Generate CSD Proposal</button>
          <button disabled className="mb-2 w-full rounded-md border px-3 py-2 font-medium opacity-50">Create Audit Report</button>
          <button disabled className="w-full rounded-md border px-3 py-2 font-medium opacity-50">Save Lead to CRM</button>
          <Link href="/crm/customers" className="mt-4 block text-center text-sm font-medium text-csd-red hover:underline">Open existing CRM</Link>
        </div>
      </section>
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw className="h-3 w-3" /> Development preview: no live searches, integrations, or updates have been activated.</p>
    </div>
  );
}
