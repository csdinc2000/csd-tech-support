import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Building2, Check, ChevronsUpDown, Mail, Phone, UserPlus, Wrench, X } from "lucide-react";
import { Anchor as PopoverAnchor } from "@radix-ui/react-popover";
import { Popover, PopoverContent } from "@/components/ui/popover";
import type { BillingParty } from "@/hooks/use-invoices";

/**
 * Who an invoice is for. A saved customer or account is a `party`; anyone the
 * CRM has never met is a `new` payer that the server turns into a contact when
 * the invoice is saved.
 */
export type BillingSelection =
  | { kind: "party"; party: BillingParty }
  | { kind: "new"; name: string; email: string; phone: string; company: string };

export const selectionName = (selection: BillingSelection) =>
  selection.kind === "party" ? selection.party.name : selection.name;

export const selectionEmail = (selection: BillingSelection) =>
  (selection.kind === "party" ? selection.party.email : selection.email) || "";

export const selectionOrg = (selection: BillingSelection) =>
  (selection.kind === "party" ? selection.party.org : selection.company) || "";

/** The payload POST/PUT /api/invoices expects for this selection. */
export function recipientFor(selection: BillingSelection) {
  if (selection.kind === "party") {
    return selection.party.kind === "contact"
      ? { kind: "contact" as const, contactId: selection.party.contactId! }
      : { kind: "client" as const, clientId: selection.party.clientId! };
  }
  return {
    kind: "new" as const,
    name: selection.name.trim(),
    email: selection.email.trim() || null,
    phone: selection.phone.trim() || null,
    company: selection.company.trim() || null,
  };
}

export const partyToSelection = (party: BillingParty): BillingSelection => ({ kind: "party", party });

const needsService = (party: BillingParty) => party.openJobCount + party.openRequestCount > 0;

const searchText = (party: BillingParty) =>
  `${party.name} ${party.org ?? ""} ${party.email ?? ""} ${party.phone ?? ""}`.toLowerCase();

const GROUPS: { id: string; label: string; match: (party: BillingParty) => boolean }[] = [
  { id: "service", label: "Needs service now", match: needsService },
  { id: "recent", label: "Billed before", match: (party) => !needsService(party) && party.invoiceCount > 0 },
  { id: "accounts", label: "Client accounts", match: (party) => !needsService(party) && party.invoiceCount === 0 && party.kind === "client" },
  { id: "people", label: "Contacts", match: (party) => !needsService(party) && party.invoiceCount === 0 && party.kind === "contact" },
];

// Long customer lists are common; render a workable slice per group and let the
// search box reach the rest instead of mounting thousands of rows.
const PER_GROUP = 25;

export default function BillingPartyPicker({
  parties,
  value,
  onChange,
  disabled,
  loading,
  error,
  onRetry,
}: {
  parties: BillingParty[];
  value: BillingSelection | null;
  onChange: (selection: BillingSelection) => void;
  disabled?: boolean;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", email: "", phone: "", company: "" });
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setAdding(false);
    }
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? parties.filter((party) => searchText(party).includes(needle)) : parties;
  }, [parties, query]);

  const groups = useMemo(
    () => GROUPS.map((group) => ({ ...group, items: matches.filter(group.match) })).filter((group) => group.items.length > 0),
    [matches],
  );

  const startNewPayer = () => {
    setDraft({ name: query.trim(), email: "", phone: "", company: "" });
    setAdding(true);
  };

  const commitNewPayer = () => {
    if (draft.name.trim().length < 2) return;
    onChange({ kind: "new", ...draft });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="flex w-full items-center gap-3 rounded-xl border border-[#ddd5c9] bg-white px-3.5 transition focus-within:border-[#b21f32]/40 focus-within:ring-2 focus-within:ring-[#b21f32]/30">
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-label="Customer name"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={open}
            disabled={disabled}
            value={open ? query : value ? selectionName(value) : ""}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(event) => { setQuery(event.target.value); setAdding(false); setOpen(true); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
              if (event.key !== "Enter" || adding || error || loading) return;
              event.preventDefault();
              if (!query.trim()) return;
              const onlyMatch = matches.length === 1 ? matches[0] : null;
              if (onlyMatch) {
                onChange(partyToSelection(onlyMatch));
                setOpen(false);
              } else if (matches.length === 0) startNewPayer();
            }}
            placeholder={loading ? "Loading customers…" : "Search customer name, company, email, or phone"}
            data-testid="input-billing-party-search"
            className="min-w-0 flex-1 bg-transparent py-3 text-sm text-[#172436] outline-none placeholder:text-slate-500 disabled:cursor-not-allowed"
          />
          <ChevronsUpDown className="pointer-events-none h-4 w-4 shrink-0 text-slate-400" />
        </div>
      </PopoverAnchor>

      <PopoverContent
        className="w-[min(28rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-0"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (searchRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
      >
        {adding ? (
          <div className="p-3">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold text-[#172436]">Bill someone new</h3>
              <button type="button" onClick={() => setAdding(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-[#172436]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2.5">
              {([
                { key: "name", label: "Name", placeholder: "Dana Reyes", required: true },
                { key: "email", label: "Email", placeholder: "dana@example.com", required: false },
                { key: "phone", label: "Phone", placeholder: "(954) 555-0134", required: false },
                { key: "company", label: "Business (optional)", placeholder: "Reyes Dental", required: false },
              ] as const).map((field) => (
                <label key={field.key} className="block">
                  <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">{field.label}</span>
                  <input
                    autoFocus={field.key === "name"}
                    value={draft[field.key]}
                    onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                    onKeyDown={(event) => event.key === "Enter" && commitNewPayer()}
                    placeholder={field.placeholder}
                    data-testid={`input-new-payer-${field.key}`}
                    className="w-full rounded-md border border-[#ddd5c9] bg-[#faf8f4] px-3 py-2 text-sm outline-none focus:border-[#b21f32] focus:ring-1 focus:ring-[#b21f32]"
                  />
                </label>
              ))}
            </div>
            <p className="mt-2.5 text-[11px] leading-snug text-slate-500">
              They are added to the CRM as a customer when the invoice is saved. An email is needed only to send it.
            </p>
            <button
              type="button"
              onClick={commitNewPayer}
              disabled={draft.name.trim().length < 2}
              data-testid="button-use-new-payer"
              className="mt-3 w-full rounded-lg bg-[#b21f32] px-3 py-2 text-sm font-bold text-white transition hover:bg-[#8e1728] disabled:opacity-50"
            >
              Use this customer
            </button>
          </div>
        ) : (
          <div className="flex max-h-[26rem] flex-col">
            <div id={listId} role="listbox" aria-label="CRM customers" className="flex-1 overflow-y-auto py-1">
              {error ? (
                <div className="px-3 py-4 text-sm text-rose-700">
                  Customer records could not load. Try again before adding someone new.
                  {onRetry && <button type="button" onClick={onRetry} className="ml-2 font-bold underline">Retry</button>}
                </div>
              ) : groups.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-slate-500">
                  {loading ? "Loading customers…" : "Nobody matches that yet."}
                </p>
              ) : (
                groups.map((group) => (
                  <div key={group.id} className="py-1">
                    <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{group.label}</p>
                    {group.items.slice(0, PER_GROUP).map((party) => {
                      const selected = value?.kind === "party" && value.party.key === party.key;
                      return (
                        <button
                          type="button"
                          key={party.key}
                          onClick={() => {
                            onChange(partyToSelection(party));
                            setOpen(false);
                          }}
                          data-testid={`option-party-${party.key}`}
                           role="option"
                           aria-selected={selected}
                          className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-[#f7f2ea] ${selected ? "bg-[#f7f2ea]" : ""}`}
                        >
                          <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${party.kind === "client" ? "bg-[#172436]/5 text-[#172436]" : "bg-[#b21f32]/10 text-[#b21f32]"}`}>
                            {party.kind === "client" ? <Building2 className="h-3.5 w-3.5" /> : <span className="text-[11px] font-bold">{party.name.slice(0, 1).toUpperCase()}</span>}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold text-[#172436]">{party.name}</span>
                              {needsService(party) && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                                  <Wrench className="h-2.5 w-2.5" />
                                  {party.openJobCount + party.openRequestCount} open
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-slate-500">
                              {party.org && <span className="truncate">{party.org}</span>}
                              {party.email && (
                                <span className="inline-flex items-center gap-1 truncate">
                                  <Mail className="h-3 w-3" />
                                  {party.email}
                                </span>
                              )}
                              {!party.email && party.phone && (
                                <span className="inline-flex items-center gap-1">
                                  <Phone className="h-3 w-3" />
                                  {party.phone}
                                </span>
                              )}
                            </span>
                          </span>
                          {selected && <Check className="mt-1 h-4 w-4 shrink-0 text-[#b21f32]" />}
                        </button>
                      );
                    })}
                    {group.items.length > PER_GROUP && (
                      <p className="px-3 py-1 text-[11px] text-slate-400">
                        +{group.items.length - PER_GROUP} more — keep typing to narrow it down
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>

            {!error && !loading && <button
              type="button"
              onClick={startNewPayer}
              data-testid="button-add-new-payer"
              className="flex items-center gap-2 border-t border-[#e5ddd2] bg-[#faf8f4] px-3 py-2.5 text-sm font-bold text-[#b21f32] transition hover:bg-[#f5efe5]"
            >
              <UserPlus className="h-4 w-4" />
              {query.trim() ? `Bill "${query.trim()}" as someone new` : "Bill someone new"}
            </button>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
