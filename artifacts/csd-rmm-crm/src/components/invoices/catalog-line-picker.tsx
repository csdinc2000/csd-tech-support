import { useState } from "react";
import { PackagePlus, RotateCw } from "lucide-react";
import { catalogMoney, useStaffCatalog, type CatalogItem } from "@/hooks/use-catalog";

export default function CatalogLinePicker({ onSelect }: { onSelect: (item: CatalogItem) => void }) {
  const catalog = useStaffCatalog();
  const [value, setValue] = useState("");
  const items = (catalog.data?.items ?? []).filter((item) => item.active);
  return (
    <div className="mb-4 rounded-xl border border-[#dce2e8] bg-[#f3f5f7] p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-[#59697a]"><PackagePlus className="h-4 w-4 text-[#b51f32]" /> Add from CSD catalog</div>
      {catalog.isLoading ? <div className="h-9 animate-pulse rounded-md bg-[#e1e6eb]" /> : catalog.isError ? (
        <button type="button" onClick={() => catalog.refetch()} className="inline-flex items-center gap-1 text-xs font-semibold text-[#b51f32]" data-testid="button-retry-catalog-picker"><RotateCw className="h-3 w-3" /> Catalog unavailable. Retry</button>
      ) : items.length === 0 ? <p className="text-xs text-[#59697a]">No active catalog items yet. You can still add a manual line.</p> : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <select value={value} onChange={(event) => setValue(event.target.value)} className="min-w-0 flex-1 rounded-md border border-[#cbd4dc] bg-[#fffefd] px-3 py-2 text-sm text-[#14253a]" aria-label="Choose catalog item" data-testid="select-catalog-line">
            <option value="">Choose a product or service…</option>
            {items.map(item => <option key={item.id} value={item.id}>{item.name} · {catalogMoney(item.unitAmountCents)} · {item.kind}</option>)}
          </select>
          <button type="button" disabled={!value} onClick={() => { const item = items.find(item => String(item.id) === value); if (item) { onSelect(item); setValue(""); } }} className="rounded-md bg-[#14253a] px-4 py-2 text-sm font-semibold text-white hover:bg-[#273d53] disabled:opacity-40" data-testid="button-add-catalog-line">Add to invoice</button>
        </div>
      )}
      <p className="mt-2 text-[11px] text-[#738092]">Copies the current catalog description and price into an editable invoice line. Manual lines stay available.</p>
    </div>
  );
}