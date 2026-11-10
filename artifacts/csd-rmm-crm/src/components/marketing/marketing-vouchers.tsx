import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Ban, CheckCircle2, Clock, Mail, Pencil, Percent, RotateCcw, Search, Send, Ticket, TicketCheck, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { CopyButton, MarketingCard, StatTile } from "./shared";

/**
 * Discount vouchers: staff choose a percentage (1–100, optional dollar cap and
 * expiry) and email a single-use code to a customer. Active vouchers can be
 * adjusted and re-sent without changing the code. "Check a code" is for the
 * counter: look up what the customer hands you, see the discount for their
 * bill, and redeem it. Server: api-server/src/vouchers.ts.
 */

type VoucherState = "active" | "expired" | "redeemed" | "void";
type Voucher = {
  id: number; code: string; percentOff: number; maxDiscountCents: number | null; expiresOn: string | null;
  recipientName: string; recipientEmail: string; contactId: number | null; message: string | null;
  status: "active" | "redeemed" | "void"; state: VoucherState; redeemedAt: string | null; redemptionNote: string | null;
  lastEmailedAt: string | null; emailCount: number; createdAt: string;
};
type VoucherData = {
  today: string;
  summary: { total: number; active: number; redeemed: number; expired: number; void: number };
  vouchers: Voucher[];
};

const QUERY_KEY = ["/api/crm/vouchers"];
const PRESETS = [5, 10, 15, 20, 25, 50];
const STATE_TONE: Record<VoucherState, string> = {
  active: "bg-emerald-100 text-emerald-800",
  expired: "bg-amber-100 text-amber-800",
  redeemed: "bg-blue-100 text-blue-800",
  void: "bg-gray-100 text-gray-600",
};
const FILTERS: { id: VoucherState | "all"; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "expired", label: "Expired" },
  { id: "redeemed", label: "Redeemed" },
  { id: "void", label: "Void" },
  { id: "all", label: "All" },
];

const errorText = (error: unknown) => (error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Request failed");
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dollarsToCents = (value: string): number | null => {
  const n = Number(value.replace(/[$,\s]/g, ""));
  return value.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const localDate = (offsetDays = 0) => format(new Date(Date.now() + offsetDays * 86_400_000), "yyyy-MM-dd");
const dateLabel = (date: string) => format(new Date(`${date}T12:00:00`), "MMM d, yyyy");
const describe = (percentOff: number, capCents: number | null) =>
  `${percentOff}% off your next service${capCents != null ? ` (up to ${usd(capCents)})` : ""}`;
const clampPercent = (n: number) => Math.min(100, Math.max(1, Math.round(n)));

export function MarketingVouchers() {
  const { data, isLoading, error } = useQuery<VoucherData>({ queryKey: QUERY_KEY });
  const [filter, setFilter] = useState<VoucherState | "all">("active");

  if (error) return <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Couldn't load vouchers: {errorText(error)}</p>;

  const vouchers = data?.vouchers ?? [];
  const shown = filter === "all" ? vouchers : vouchers.filter((v) => v.state === filter);

  return (
    <div className="space-y-4" data-testid="marketing-vouchers">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <StatTile icon={Ticket} label="Active" value={isLoading ? "–" : data?.summary.active ?? 0} hint="Ready to use" testId="voucher-stat-active" />
        <StatTile icon={TicketCheck} label="Redeemed" value={isLoading ? "–" : data?.summary.redeemed ?? 0} hint="Used by customers" />
        <StatTile icon={Clock} label="Expired" value={isLoading ? "–" : data?.summary.expired ?? 0} hint="Extend to bring back" />
        <StatTile icon={Mail} label="Total" value={isLoading ? "–" : data?.summary.total ?? 0} hint="All vouchers" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:order-2">
          <CreateVoucherCard />
          <CheckCodeCard />
        </div>

        <MarketingCard
          icon={Ticket}
          title="Vouchers"
          description="Adjust, re-send, redeem or void vouchers you've sent"
          className="xl:order-1 xl:col-span-2 xl:self-start"
          bodyClassName="p-0"
          testId="voucher-list"
        >
          <div className="flex gap-1.5 overflow-x-auto border-b border-gray-100 px-4 py-2 [scrollbar-width:none]" role="tablist" aria-label="Filter vouchers">
            {FILTERS.map((f) => {
              const count = f.id === "all" ? vouchers.length : vouchers.filter((v) => v.state === f.id).length;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-medium", filter === f.id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200")}
                  data-testid={`voucher-filter-${f.id}`}
                >
                  {f.label} <span className="tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
          {isLoading ? (
            <p className="px-4 py-10 text-center text-sm text-gray-500">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-gray-500">
              {vouchers.length === 0 ? "No vouchers yet. Send one with the form on this page." : "Nothing in this view."}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {shown.map((voucher) => <VoucherRow key={voucher.id} voucher={voucher} />)}
            </ul>
          )}
        </MarketingCard>
      </div>
    </div>
  );
}

/** Slider + exact number + quick presets, so any whole percentage is one move away. */
function PercentPicker({ value, onChange, idPrefix }: { value: number; onChange: (n: number) => void; idPrefix: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${idPrefix}-percent`} className="text-xs">Discount</Label>
        <div className="flex items-center gap-1">
          <Input
            id={`${idPrefix}-percent`}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            step={1}
            value={value}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && e.target.value !== "") onChange(clampPercent(n)); }}
            className="h-8 w-20 text-right text-sm font-semibold tabular-nums"
            data-testid={`${idPrefix}-percent`}
          />
          <Percent className="h-4 w-4 text-gray-500" />
        </div>
      </div>
      <Slider min={1} max={100} step={1} value={[value]} onValueChange={([n]) => onChange(n)} aria-label="Discount percentage" />
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", value === p ? "bg-csd-red text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200")}
            data-testid={`${idPrefix}-preset-${p}`}
          >
            {p}%
          </button>
        ))}
      </div>
      {value >= 50 && <p className="text-[11px] font-medium text-amber-700">That's a big discount — double-check before sending.</p>}
    </div>
  );
}

function TermsFields({
  idPrefix, expiresOn, setExpiresOn, cap, setCap, message, setMessage,
}: {
  idPrefix: string;
  expiresOn: string; setExpiresOn: (v: string) => void;
  cap: string; setCap: (v: string) => void;
  message: string; setMessage: (v: string) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-expires`} className="text-xs">Valid through</Label>
          <Input id={`${idPrefix}-expires`} type="date" min={localDate()} value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className="h-9 text-sm" />
          <p className="text-[11px] text-gray-500">{expiresOn ? <button type="button" className="hover:text-csd-red" onClick={() => setExpiresOn("")}>Remove expiry</button> : "No expiry"}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-cap`} className="text-xs">Max discount ($)</Label>
          <Input id={`${idPrefix}-cap`} inputMode="decimal" placeholder="No limit" value={cap} onChange={(e) => setCap(e.target.value)} className="h-9 text-sm" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-message`} className="text-xs">Personal note (optional)</Label>
        <Textarea id={`${idPrefix}-message`} rows={2} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Thanks for choosing us! Here's a little something for your next visit." className="text-sm" />
      </div>
    </>
  );
}

function CreateVoucherCard() {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [percentOff, setPercentOff] = useState(10);
  const [expiresOn, setExpiresOn] = useState(localDate(30));
  const [cap, setCap] = useState("");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ voucher: Voucher; emailed: boolean } | null>(null);
  const capCents = dollarsToCents(cap);

  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/crm/vouchers", {
      recipientName: name, recipientEmail: email, percentOff, expiresOn: expiresOn || null, maxDiscountCents: capCents, message: message || null,
    })).json() as Promise<{ voucher: Voucher; emailed: boolean }>,
    onSuccess: (res) => {
      setResult(res);
      setName(""); setEmail(""); setMessage("");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({
        title: res.emailed ? `${res.voucher.percentOff}% voucher sent` : "Voucher created, but the email failed",
        description: res.emailed ? `Emailed to ${res.voucher.recipientEmail}` : "Copy the code below and share it another way.",
        variant: res.emailed ? "default" : "destructive",
      });
    },
    onError: (err) => toast({ title: "Couldn't create voucher", description: errorText(err), variant: "destructive" }),
  });

  return (
    <MarketingCard icon={Send} title="Send a voucher" description="Pick a discount and we'll email the customer a code" testId="voucher-create">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
          <div className="space-y-1.5">
            <Label htmlFor="voucher-name" className="text-xs">Customer name</Label>
            <Input id="voucher-name" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voucher-email" className="text-xs">Customer email</Label>
            <Input id="voucher-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <PercentPicker idPrefix="voucher" value={percentOff} onChange={setPercentOff} />
        <TermsFields idPrefix="voucher" expiresOn={expiresOn} setExpiresOn={setExpiresOn} cap={cap} setCap={setCap} message={message} setMessage={setMessage} />
        {cap.trim() && capCents == null && <p className="text-[11px] text-red-700">Enter the max discount as a dollar amount, or leave it blank.</p>}

        <div className="rounded-lg border-2 border-dashed border-csd-red/40 bg-red-50/40 p-3 text-center" data-testid="voucher-preview">
          <p className="text-2xl font-extrabold leading-none text-csd-red">{percentOff}% OFF</p>
          <p className="mt-1 text-xs text-gray-700">{describe(percentOff, capCents)}</p>
          <p className="mt-1 text-[11px] text-gray-500">{expiresOn ? `Valid through ${dateLabel(expiresOn)}` : "No expiry date"} · single use</p>
        </div>

        <Button type="submit" size="sm" className="w-full bg-csd-red hover:bg-red-700" disabled={create.isPending || (cap.trim() !== "" && capCents == null)} data-testid="voucher-send">
          <Mail className="mr-1.5 h-3.5 w-3.5" />{create.isPending ? "Sending…" : `Email ${percentOff}% voucher`}
        </Button>
      </form>
      {result && (
        <div className={cn("mt-3 space-y-2 rounded-lg border p-3 text-xs", result.emailed ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900")} data-testid="voucher-create-result">
          <p>
            {result.voucher.percentOff}% off for {result.voucher.recipientName}
            {result.emailed ? " — emailed." : " — the email could not be sent; share the code yourself."}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{result.voucher.code}</code>
            <CopyButton text={result.voucher.code} label="Copy code" className="h-7 shrink-0" />
          </div>
        </div>
      )}
    </MarketingCard>
  );
}

function CheckCodeCard() {
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [note, setNote] = useState("");
  const [found, setFound] = useState<{ voucher: Voucher; discountCents: number | null } | null>(null);
  const subtotalCents = dollarsToCents(subtotal);

  const lookup = useMutation({
    mutationFn: async () => {
      const qs = subtotalCents ? `?subtotalCents=${subtotalCents}` : "";
      return (await apiRequest("GET", `/api/crm/vouchers/lookup/${encodeURIComponent(code.trim())}${qs}`)).json() as Promise<{ voucher: Voucher; discountCents: number | null }>;
    },
    onSuccess: setFound,
    onError: (err) => { setFound(null); toast({ title: "Voucher not found", description: errorText(err), variant: "destructive" }); },
  });
  const redeem = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/crm/vouchers/redeem", { code: found?.voucher.code, note: note || undefined })).json() as Promise<{ voucher: Voucher }>,
    onSuccess: (res) => {
      setFound({ voucher: res.voucher, discountCents: null });
      setNote("");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: "Voucher redeemed", description: `${res.voucher.code} can't be used again.` });
    },
    onError: (err) => toast({ title: "Couldn't redeem", description: errorText(err), variant: "destructive" }),
  });

  return (
    <MarketingCard icon={Search} title="Check a code" description="At checkout: look up a customer's voucher and redeem it" testId="voucher-check">
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); lookup.mutate(); }}>
        <div className="grid grid-cols-[1fr_7rem] gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CSD-XXXXXX" aria-label="Voucher code" className="font-mono uppercase" data-testid="voucher-check-code" />
          <Input value={subtotal} onChange={(e) => setSubtotal(e.target.value)} inputMode="decimal" placeholder="Bill $" aria-label="Bill subtotal in dollars" />
        </div>
        <Button type="submit" size="sm" variant="outline" className="w-full" disabled={!code.trim() || lookup.isPending}>
          <Search className="mr-1.5 h-3.5 w-3.5" />{lookup.isPending ? "Checking…" : "Check code"}
        </Button>
      </form>
      {found && (
        <div className="mt-3 space-y-2 rounded-lg border border-gray-200 p-3 text-sm" data-testid="voucher-check-result">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono font-semibold">{found.voucher.code}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", STATE_TONE[found.voucher.state])}>{found.voucher.state}</span>
          </div>
          <p className="text-xs text-gray-700">{describe(found.voucher.percentOff, found.voucher.maxDiscountCents)} · for {found.voucher.recipientName}</p>
          {found.voucher.expiresOn && <p className="text-xs text-gray-500">Valid through {dateLabel(found.voucher.expiresOn)}</p>}
          {found.discountCents != null && subtotalCents != null && (
            <p className="rounded-md bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900">
              Take <strong>{usd(found.discountCents)}</strong> off {usd(subtotalCents)} → <strong>{usd(subtotalCents - found.discountCents)}</strong> before tax
            </p>
          )}
          {found.voucher.state === "redeemed" && found.voucher.redeemedAt && (
            <p className="text-xs text-gray-500">Redeemed {format(new Date(found.voucher.redeemedAt), "MMM d, yyyy h:mm a")}{found.voucher.redemptionNote ? ` · ${found.voucher.redemptionNote}` : ""}</p>
          )}
          {found.voucher.state === "active" && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); redeem.mutate(); }}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Invoice # (optional)" className="h-8 text-xs" aria-label="Redemption note" />
              <Button type="submit" size="sm" className="shrink-0 bg-csd-red hover:bg-red-700" disabled={redeem.isPending} data-testid="voucher-check-redeem">
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Redeem
              </Button>
            </form>
          )}
        </div>
      )}
    </MarketingCard>
  );
}

function VoucherRow({ voucher }: { voucher: Voucher }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"view" | "adjust" | "redeem">("view");
  const [percentOff, setPercentOff] = useState(voucher.percentOff);
  const [expiresOn, setExpiresOn] = useState(voucher.expiresOn ?? "");
  const [cap, setCap] = useState(voucher.maxDiscountCents != null ? String(voucher.maxDiscountCents / 100) : "");
  const [message, setMessage] = useState(voucher.message ?? "");
  const [note, setNote] = useState("");
  const capCents = dollarsToCents(cap);
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiRequest("PATCH", `/api/crm/vouchers/${voucher.id}`, body)).json() as Promise<{ voucher: Voucher; emailed: boolean }>,
    onSuccess: (res, body) => {
      refresh();
      setMode("view");
      if (body.resend) toast({ title: res.emailed ? "Voucher emailed" : "Email could not be sent", variant: res.emailed ? "default" : "destructive" });
      else if (body.status === "void") toast({ title: "Voucher voided", description: `${voucher.code} can no longer be used.` });
      else toast({ title: "Voucher updated" });
    },
    onError: (err) => toast({ title: "Couldn't update voucher", description: errorText(err), variant: "destructive" }),
  });
  const redeem = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/crm/vouchers/${voucher.id}/redeem`, { note: note || undefined }),
    onSuccess: () => { refresh(); setMode("view"); toast({ title: "Voucher redeemed" }); },
    onError: (err) => toast({ title: "Couldn't redeem", description: errorText(err), variant: "destructive" }),
  });
  const busy = patch.isPending || redeem.isPending;
  const startAdjust = () => {
    setPercentOff(voucher.percentOff);
    setExpiresOn(voucher.expiresOn ?? "");
    setCap(voucher.maxDiscountCents != null ? String(voucher.maxDiscountCents / 100) : "");
    setMessage(voucher.message ?? "");
    setMode("adjust");
  };
  const adjustBody = () => ({ percentOff, expiresOn: expiresOn || null, maxDiscountCents: capCents, message: message || null });
  const editable = voucher.status === "active";

  return (
    <li className="space-y-3 px-4 py-3" data-testid={`voucher-row-${voucher.id}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn("flex h-11 w-14 shrink-0 items-center justify-center rounded-md text-base font-extrabold tabular-nums", voucher.state === "active" ? "bg-csd-red/10 text-csd-red" : "bg-gray-100 text-gray-500")}>
            {voucher.percentOff}%
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-gray-900">{voucher.recipientName}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", STATE_TONE[voucher.state])}>{voucher.state}</span>
              <span className="font-mono text-xs text-gray-500">{voucher.code}</span>
            </div>
            <p className="truncate text-xs text-gray-500">{voucher.recipientEmail}</p>
            <p className="text-xs text-gray-500">
              {voucher.maxDiscountCents != null && <>Up to {usd(voucher.maxDiscountCents)} · </>}
              {voucher.expiresOn ? `Valid through ${dateLabel(voucher.expiresOn)}` : "No expiry"}
              {" · "}{voucher.emailCount > 0 ? `Emailed ${voucher.emailCount}×` : "Not emailed"}
              {" · "}Created {format(new Date(voucher.createdAt), "MMM d, yyyy")}
            </p>
            {voucher.state === "redeemed" && voucher.redeemedAt && (
              <p className="text-xs text-blue-800">Redeemed {format(new Date(voucher.redeemedAt), "MMM d, yyyy")}{voucher.redemptionNote ? ` · ${voucher.redemptionNote}` : ""}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <CopyButton text={voucher.code} label="Copy" className="h-8" />
          {voucher.state === "active" && (
            <>
              <Button size="sm" className="bg-csd-red hover:bg-red-700" disabled={busy} onClick={() => setMode(mode === "redeem" ? "view" : "redeem")} data-testid={`voucher-redeem-${voucher.id}`}>
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Redeem
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => patch.mutate({ resend: true })}>
                <Mail className="mr-1.5 h-3.5 w-3.5" />Resend
              </Button>
            </>
          )}
          {editable && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => (mode === "adjust" ? setMode("view") : startAdjust())} data-testid={`voucher-adjust-${voucher.id}`}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />{voucher.state === "expired" ? "Extend / adjust" : "Adjust"}
            </Button>
          )}
          {editable ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => patch.mutate({ status: "void" })}>
              <Ban className="mr-1.5 h-3.5 w-3.5" />Void
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => patch.mutate({ status: "active" })}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />{voucher.status === "redeemed" ? "Undo redeem" : "Reactivate"}
            </Button>
          )}
        </div>
      </div>

      {mode === "redeem" && (
        <form className="flex flex-col gap-2 rounded-lg bg-gray-50 p-3 sm:flex-row" onSubmit={(e) => { e.preventDefault(); redeem.mutate(); }}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Invoice # or note (optional)" className="h-8 text-xs" aria-label="Redemption note" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>Confirm redeem</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode("view")}><XCircle className="mr-1 h-3.5 w-3.5" />Cancel</Button>
          </div>
        </form>
      )}

      {mode === "adjust" && (
        <form className="space-y-3 rounded-lg bg-gray-50 p-3" onSubmit={(e) => { e.preventDefault(); patch.mutate({ ...adjustBody(), resend: true }); }} data-testid={`voucher-adjust-form-${voucher.id}`}>
          <PercentPicker idPrefix={`voucher-${voucher.id}`} value={percentOff} onChange={setPercentOff} />
          <TermsFields idPrefix={`voucher-${voucher.id}`} expiresOn={expiresOn} setExpiresOn={setExpiresOn} cap={cap} setCap={setCap} message={message} setMessage={setMessage} />
          <p className="text-xs text-gray-600">Customer will see: <strong>{describe(percentOff, capCents)}</strong>. The code stays {voucher.code}.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="bg-csd-red hover:bg-red-700" disabled={busy || (cap.trim() !== "" && capCents == null)}>
              <Mail className="mr-1.5 h-3.5 w-3.5" />Save & email update
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || (cap.trim() !== "" && capCents == null)} onClick={() => patch.mutate(adjustBody())}>Save only</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode("view")}>Cancel</Button>
          </div>
        </form>
      )}
    </li>
  );
}
