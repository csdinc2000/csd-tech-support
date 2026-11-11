import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  ArrowUpRight,
  CircleDollarSign,
  Copy,
  ExternalLink,
  FileUp,
  FileText,
  Plus,
  Search,
  Settings2,
  Send,
  Wrench,
  Zap,
} from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";
import QuickInvoiceSheet from "@/components/invoices/quick-invoice-sheet";
import { Package } from "lucide-react";
import { useBillingParties, useInvoices, type BillingParty, type Invoice, type InvoiceStatus } from "@/hooks/use-invoices";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { formatUsdCents } from "@/lib/format";

const money = (cents: number) => formatUsdCents(cents);

const today = () => new Date(new Date().setHours(0, 0, 0, 0));

const isOverdue = (invoice: Invoice) =>
  invoice.status === "sent" && !!invoice.due_date && new Date(invoice.due_date) < today();

const daysLate = (invoice: Invoice) =>
  invoice.due_date ? Math.round((today().getTime() - new Date(invoice.due_date).getTime()) / 86_400_000) : 0;

const badgeFor = (invoice: Invoice) => {
  if (invoice.status === "draft") return { label: "Draft", className: "bg-slate-100 text-slate-700 border-slate-200" };
  if (invoice.status === "paid") return { label: "Paid", className: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  if (invoice.status === "void") return { label: "Void", className: "bg-stone-100 text-stone-600 border-stone-200" };
  if (isOverdue(invoice)) return { label: `${daysLate(invoice)}d late`, className: "bg-rose-50 text-rose-700 border-rose-200" };
  return { label: "Awaiting", className: "bg-amber-50 text-amber-700 border-amber-200" };
};

type Filter = "all" | InvoiceStatus | "overdue";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "sent", label: "Awaiting" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
  { id: "void", label: "Void" },
];

function Skeleton() {
  return (
    <div className="space-y-3 p-6">
      {[1, 2, 3, 4].map((row) => (
        <div key={row} className="h-16 animate-pulse rounded-xl bg-slate-200/70" />
      ))}
    </div>
  );
}

export default function Invoices() {
  const { data, isLoading, error, refetch } = useInvoices();
  const parties = useBillingParties();
  const { isAdmin } = useAdminAccess();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickParty, setQuickParty] = useState<BillingParty | null>(null);
  const search = useSearch();
  const [, setLocation] = useLocation();

  const openQuickInvoice = (party: BillingParty | null) => {
    setQuickParty(party);
    setQuickOpen(true);
  };

  // "Bill this customer" links from the CRM arrive as /invoices?bill=client:4
  // (or contact:9, or new) and open the sheet already pointed at them.
  const requested = new URLSearchParams(search).get("bill");
  useEffect(() => {
    if (!requested || !parties.data) return;
    const party = parties.data.find((candidate) => candidate.key === requested) ?? null;
    if (party || requested === "new") openQuickInvoice(party);
    setLocation("/invoices", { replace: true });
  }, [requested, parties.data, setLocation]);

  const rows = useMemo(
    () =>
      (data ?? []).filter((invoice) => {
        const matchesFilter =
          filter === "all"
            ? true
            : filter === "overdue"
              ? isOverdue(invoice)
              : invoice.status === filter && !(filter === "sent" && isOverdue(invoice));
        const haystack = `${invoice.invoice_number} ${invoice.client_name} ${invoice.client_email ?? ""} ${invoice.job_number ?? ""}`.toLowerCase();
        return matchesFilter && haystack.includes(query.trim().toLowerCase());
      }),
    [data, filter, query],
  );

  const totals = useMemo(
    () =>
      (data ?? []).reduce(
        (accumulator, invoice) => {
          if (invoice.status === "draft") accumulator.draft += invoice.total_cents;
          if (invoice.status === "paid") accumulator.paid += invoice.total_cents;
          if (invoice.status === "sent") {
            if (isOverdue(invoice)) accumulator.overdue += invoice.total_cents;
            else accumulator.sent += invoice.total_cents;
          }
          return accumulator;
        },
        { draft: 0, sent: 0, overdue: 0, paid: 0 },
      ),
    [data],
  );

  // Customers with work open and nothing billed for it yet: the shortest path
  // from "we did the job" to "the invoice is out".
  const readyToBill = useMemo(
    () => (parties.data ?? []).filter((party) => party.openJobCount + party.openRequestCount > 0).slice(0, 6),
    [parties.data],
  );

  if (isLoading) return <Skeleton />;
  if (error)
    return (
      <main className="p-6">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8">
          <h1 className="text-xl font-bold">Invoices are unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">The billing ledger could not be reached.</p>
          <button onClick={() => refetch()} className="mt-5 rounded-lg bg-[#172436] px-4 py-2 text-sm font-semibold text-white">
            Try again
          </button>
        </div>
      </main>
    );

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-[#f3f5f7] p-4 text-[#14253a] lg:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="mb-8 flex flex-col gap-5 border-b border-[#dce2e8] pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-6 flex items-center gap-4">
              <img src={csdLogo} alt="Computer Systems Depot" className="h-9 w-auto max-w-[170px] object-contain object-left" />
              <span className="h-7 w-px bg-[#cbd4dc]" aria-hidden="true" />
              <span className="text-xs font-bold uppercase tracking-[.18em] text-[#b51f32]">Billing</span>
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-[#14253a] sm:text-4xl">Invoice desk</h1>
            <p className="mt-2 text-sm text-[#59697a]">Create, send, and follow up on customer invoices.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isAdmin && <Link href="/invoices/catalog" data-testid="link-invoice-catalog" className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#cbd4dc] bg-[#fffefd] px-4 py-2.5 text-sm font-semibold text-[#14253a] transition hover:border-[#b51f32] hover:bg-[#fdf6f6]"><Package className="h-4 w-4 text-[#b51f32]" /> Catalog</Link>}
            {isAdmin && <Link href="/invoices/settings" data-testid="link-invoice-settings" className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#cbd4dc] bg-[#fffefd] px-4 py-2.5 text-sm font-semibold text-[#14253a] transition hover:border-[#b51f32] hover:bg-[#fdf6f6]"><Settings2 className="h-4 w-4 text-[#b51f32]" />Invoice settings</Link>}
            <Link
              href="/invoices/import-paypal"
              data-testid="link-import-paypal"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#cbd4dc] bg-[#fffefd] px-4 py-2.5 text-sm font-semibold text-[#14253a] transition hover:border-[#b51f32] hover:bg-[#fdf6f6]"
            >
              <FileUp className="h-4 w-4 text-[#b21f32]" />
              Import PayPal history
            </Link>
            <button
              onClick={() => openQuickInvoice(null)}
              data-testid="button-new-invoice"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b51f32] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#94172a]"
            >
              <Plus className="h-4 w-4" />
              New invoice
            </button>
          </div>
        </header>

        <section aria-label="Invoice totals" className="mb-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={FileText} label="Draft" value={money(totals.draft)} tone="text-slate-700" active={filter === "draft"} onClick={() => setFilter(filter === "draft" ? "all" : "draft")} />
          <Stat icon={Send} label="Awaiting" value={money(totals.sent)} tone="text-amber-700" active={filter === "sent"} onClick={() => setFilter(filter === "sent" ? "all" : "sent")} />
          <Stat icon={CircleDollarSign} label="Overdue" value={money(totals.overdue)} tone="text-rose-700" active={filter === "overdue"} onClick={() => setFilter(filter === "overdue" ? "all" : "overdue")} />
          <Stat icon={CircleDollarSign} label="Collected" value={money(totals.paid)} tone="text-emerald-700" active={filter === "paid"} onClick={() => setFilter(filter === "paid" ? "all" : "paid")} />
        </section>

        {readyToBill.length > 0 && (
          <section className="mb-7 rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500">
              <Zap className="h-4 w-4 text-amber-600" />
              Ready to bill
              <span className="font-normal normal-case tracking-normal text-[#738092]">— open work that may be ready to invoice</span>
            </h2>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {readyToBill.map((party) => (
                <button
                  key={party.key}
                  onClick={() => openQuickInvoice(party)}
                  data-testid={`button-bill-${party.key}`}
                  className="group flex min-w-[13rem] shrink-0 items-center justify-between gap-3 rounded-lg border border-[#dce2e8] bg-[#f7f9fa] px-3 py-3 text-left transition hover:border-[#b51f32] hover:bg-white"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-[#172436]">{party.name}</span>
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                      <Wrench className="h-3 w-3 text-amber-600" />
                      {party.openJobCount + party.openRequestCount} open
                      {party.org ? ` · ${party.org}` : ""}
                    </span>
                  </span>
                  <Plus className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-[#b21f32]" />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="overflow-hidden rounded-2xl border border-[#dce2e8] bg-[#fffefd] shadow-sm">
          <div className="flex flex-col gap-4 border-b border-[#e4e8ec] p-5 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <label htmlFor="invoice-search" className="sr-only">Search invoices</label>
              <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <input
                id="invoice-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search customers, invoice numbers, or jobs…"
                data-testid="input-search-invoices"
                className="w-full rounded-lg border border-[#cbd4dc] bg-[#f7f9fa] py-2 pl-9 pr-3 text-sm outline-none focus:border-[#b51f32] focus:ring-1 focus:ring-[#b51f32]"
              />
            </div>
            <div className="flex flex-wrap gap-1.5" aria-label="Filter invoices">
              {FILTERS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setFilter(option.id)}
                  data-testid={`button-filter-${option.id}`}
                  className={`rounded-md px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition ${
                    filter === option.id ? "bg-[#14253a] text-white" : "bg-[#f0f3f5] text-[#526276] hover:bg-[#e3e9ed]"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="p-14 text-center">
              <FileText className="mx-auto h-10 w-10 text-slate-300" />
              <h2 className="mt-4 font-serif text-xl font-bold text-[#172436]">
                {(data ?? []).length === 0 ? "No invoices yet" : "No invoices match"}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">
                {(data ?? []).length === 0
                  ? "Bill a customer from the CRM, or add someone new while you create the invoice."
                  : "Adjust the search or filters to see more."}
              </p>
              <button
                onClick={() => openQuickInvoice(null)}
                data-testid="button-empty-new-invoice"
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#b21f32] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#8e1728]"
              >
                <Plus className="h-4 w-4" />
                New invoice
              </button>
            </div>
          ) : (
            <div className="divide-y divide-[#eee7dc]">
              <div className="hidden grid-cols-[100px_minmax(200px,1fr)_120px_150px_120px_40px] items-center gap-4 bg-[#f7f9fa] px-4 py-3 text-xs font-bold uppercase tracking-wider text-[#738092] sm:grid">
                <div>Number</div>
                <div>Customer</div>
                <div>Due</div>
                <div>Status</div>
                <div className="text-right">Total</div>
                <div />
              </div>
              {rows.map((invoice) => (
                <InvoiceRow key={invoice.id} invoice={invoice} />
              ))}
            </div>
          )}
        </section>
      </div>

      <QuickInvoiceSheet open={quickOpen} onOpenChange={setQuickOpen} initialParty={quickParty} />
    </main>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
  active,
  onClick,
}: {
  icon: typeof FileText;
  label: string;
  value: string;
  tone: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={`button-stat-${label.toLowerCase()}`}
      className={`rounded-xl border bg-[#fffefd] p-4 text-left shadow-sm transition hover:border-[#b51f32]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b51f32] ${
        active ? "border-[#b51f32] ring-1 ring-[#b51f32]/30" : "border-[#dce2e8]"
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500">
        <Icon className={`h-4 w-4 ${tone}`} />
        {label}
      </div>
      <div className={`mt-3 font-serif text-2xl font-bold ${tone}`}>{value}</div>
    </button>
  );
}

function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const badge = badgeFor(invoice);

  const copyLink = () => {
    if (invoice.publicUrl) navigator.clipboard.writeText(invoice.publicUrl);
  };

  const openLink = () => {
    if (invoice.publicUrl) window.open(invoice.publicUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="group relative transition hover:bg-[#f7f9fa]">
    <Link
      href={`/invoices/${invoice.id}`}
      data-testid={`link-invoice-${invoice.id}`}
      className="flex flex-col gap-2 p-4 pr-24 transition active:bg-[#edf1f4] sm:grid sm:grid-cols-[100px_minmax(200px,1fr)_120px_150px_120px_40px] sm:items-center sm:gap-4 sm:pr-4"
    >
      <div className="flex items-center justify-between sm:block">
        <span className="font-mono text-sm font-bold text-[#172436] group-hover:text-[#b21f32]">{invoice.invoice_number}</span>
        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider sm:hidden ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[#172436]">{invoice.client_name}</p>
        <p className="truncate text-xs text-slate-500">
          {invoice.job_number ? `Job ${invoice.job_number}` : invoice.client_email || "No email on file"}
        </p>
      </div>

      <div className="text-sm text-slate-600">{invoice.due_date ?? "—"}</div>

      <div className="hidden items-center gap-2 sm:flex">
        <span className={`inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-bold uppercase tracking-wider ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      <div className="text-left sm:text-right">
        <p className="font-mono text-sm font-bold text-[#172436]">{money(invoice.total_cents)}</p>
      </div>

      <div className="hidden justify-end sm:flex">
        <ArrowUpRight className="h-4 w-4 text-slate-300 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-[#b21f32]" />
      </div>
    </Link>
    {invoice.publicUrl && (
      <div className="absolute right-3 top-3 flex items-center gap-0.5 sm:right-[15%] sm:top-1/2 sm:-translate-y-1/2">
        <button type="button" onClick={copyLink} aria-label={`Copy customer link for ${invoice.invoice_number}`} className="rounded p-2 text-[#738092] hover:bg-[#e9edf1] hover:text-[#14253a]" title="Copy customer link">
          <Copy className="h-4 w-4" />
        </button>
        <button type="button" onClick={openLink} aria-label={`Open customer link for ${invoice.invoice_number}`} className="rounded p-2 text-[#738092] hover:bg-[#e9edf1] hover:text-[#14253a]" title="Open customer link">
          <ExternalLink className="h-4 w-4" />
        </button>
      </div>
    )}
    </div>
  );
}
