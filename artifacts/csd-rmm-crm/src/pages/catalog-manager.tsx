import { useState } from "react";
import { Link } from "wouter";
import { Archive, ArrowLeft, ExternalLink, PackagePlus, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { catalogError, catalogMoney, useCatalogActions, useCatalogOrders, useStaffCatalog, type CatalogInput, type CatalogItem } from "@/hooks/use-catalog";
import CatalogInquiryQueue from "@/components/invoices/catalog-inquiry-queue";

const blank: CatalogInput = { name: "", description: "", kind: "service", unitAmountCents: 0, published: false };
export default function CatalogManager() {
  const catalog = useStaffCatalog();
  const orders = useCatalogOrders();
  const { create, update, archive } = useCatalogActions();
  const [editing, setEditing] = useState<CatalogItem | "new" | null>(null);
  const [form, setForm] = useState<CatalogInput>(blank);
  const [price, setPrice] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const busy = create.isPending || update.isPending || archive.isPending;
  const open = (item: CatalogItem | "new") => {
    setEditing(item); setError("");
    setForm(item === "new" ? blank : { name: item.name, description: item.description, kind: item.kind, unitAmountCents: item.unitAmountCents, published: item.published });
    setPrice(item === "new" ? "" : (item.unitAmountCents / 100).toFixed(2));
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const cents = Math.round(Number(price) * 100);
    if (!form.name.trim() || !form.description.trim()) return setError("Name and description are required.");
    if (!Number.isSafeInteger(cents) || cents < 1 || !price.trim()) return setError("Enter a price of at least $0.01.");
    const input = { ...form, name: form.name.trim(), description: form.description.trim(), unitAmountCents: cents };
    setError("");
    try {
      if (editing === "new") await create.mutateAsync(input);
      else if (editing) await update.mutateAsync({ id: editing.id, input });
      setNotice(editing === "new" ? "Catalog item created." : "Catalog item updated.");
      setEditing(null);
    } catch (failure) { setError(catalogError(failure)); }
  };
  const toggle = async (item: CatalogItem) => {
    setError("");
    try { await update.mutateAsync({ id: item.id, input: { published: !item.published } }); setNotice(item.published ? "Offer unpublished." : "Offer published."); }
    catch (failure) { setError(catalogError(failure)); }
  };
  const remove = async (item: CatalogItem) => {
    if (!window.confirm(`Archive ${item.name}? It will no longer be available for new invoices or public checkout.`)) return;
    setError("");
    try { await archive.mutateAsync(item.id); setNotice("Catalog item archived."); }
    catch (failure) { setError(catalogError(failure)); }
  };
  const items = (catalog.data?.items ?? []).filter(item => showArchived || item.active);
  return <main className="min-h-[100dvh] bg-[#f3f5f7] p-4 text-[#14253a] sm:p-8">
    <div className="mx-auto max-w-6xl">
      <Link href="/invoices" className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-[#59697a] hover:text-[#b51f32]" data-testid="link-invoices-back"><ArrowLeft className="h-4 w-4" /> Invoice desk</Link>
      <header className="mb-6 overflow-hidden rounded-2xl border border-[#dce2e8] bg-[#fffefd] shadow-sm">
        <div className="h-1 bg-[#b51f32]" />
        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-8">
          <div><p className="text-xs font-bold uppercase tracking-[.2em] text-[#b51f32]">Billing / CSD offers</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Product &amp; service catalog</h1><p className="mt-2 max-w-xl text-sm leading-relaxed text-[#59697a]">Keep invoice pricing in one place. Publish selected offers on the public marketplace as products or services sold directly by CSD.</p></div>
          <button onClick={() => open("new")} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#b51f32] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#94172a]" data-testid="button-create-catalog"><Plus className="h-4 w-4" /> New item</button>
        </div>
      </header>
      <div className="mb-4 flex items-center justify-between gap-3"><p className="text-xs font-bold uppercase tracking-widest text-[#738092]">{items.length} item{items.length === 1 ? "" : "s"}</p><label className="flex items-center gap-2 text-sm text-[#59697a]"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} data-testid="input-show-archived" /> Show archived</label></div>
      {notice && <div role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}
      {error && !editing && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {catalog.isLoading ? <div className="space-y-3">{[1,2,3].map(n => <div key={n} className="h-24 animate-pulse rounded-xl bg-[#e1e6eb]" />)}</div> : catalog.isError ? <div className="rounded-xl border bg-[#fffefd] p-8 text-center"><p>Catalog could not load.</p><button onClick={() => catalog.refetch()} className="mt-3 inline-flex items-center gap-2 font-semibold text-[#b51f32]"><RefreshCw className="h-4 w-4" /> Retry</button></div> : items.length === 0 ? <div className="rounded-2xl border border-dashed border-[#cbd4dc] bg-[#fffefd] p-10 text-center"><PackagePlus className="mx-auto h-9 w-9 text-[#b51f32]" /><h2 className="mt-3 font-semibold">Your catalog starts here</h2><p className="mt-1 text-sm text-[#59697a]">Add a product or service to speed up invoicing. Publish it when it's ready for customers to see.</p><button onClick={() => open("new")} className="mt-4 text-sm font-bold text-[#b51f32]">Add first item</button></div> : <div className="space-y-3">{items.map(item => <article key={item.id} className={`rounded-xl border border-[#dce2e8] bg-[#fffefd] p-4 shadow-sm sm:p-5 ${!item.active ? "opacity-60" : ""}`} data-testid={`card-catalog-${item.id}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{item.name}</h2><span className="rounded-full bg-[#e9edf1] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">{item.kind}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${item.published && item.active ? "bg-emerald-50 text-emerald-700" : "bg-[#f3f5f7] text-[#738092]"}`}>{!item.active ? "Archived" : item.published ? "Published" : "Private"}</span></div><p className="mt-1 line-clamp-2 text-sm text-[#59697a]">{item.description}</p><p className="mt-2 font-mono text-sm font-bold">{catalogMoney(item.unitAmountCents)}</p></div><div className="flex flex-wrap gap-2 sm:justify-end">{item.active && <><button disabled={busy} onClick={() => open(item)} className="inline-flex items-center gap-1 rounded-md border border-[#cbd4dc] px-3 py-2 text-xs font-bold hover:bg-[#f3f5f7]" data-testid={`button-edit-catalog-${item.id}`}><Pencil className="h-3.5 w-3.5" /> Edit</button><button disabled={busy} onClick={() => toggle(item)} className="rounded-md border border-[#cbd4dc] px-3 py-2 text-xs font-bold hover:bg-[#f3f5f7]" data-testid={`button-publish-catalog-${item.id}`}>{item.published ? "Unpublish" : "Publish"}</button>{item.published && <Link href={`/portal/marketplace/offers/${item.id}`} className="inline-flex items-center gap-1 rounded-md border border-[#cbd4dc] px-3 py-2 text-xs font-bold hover:bg-[#f3f5f7]"><ExternalLink className="h-3.5 w-3.5" /> View</Link>}<button disabled={busy} onClick={() => remove(item)} className="inline-flex items-center gap-1 rounded-md border border-rose-200 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50" data-testid={`button-archive-catalog-${item.id}`}><Archive className="h-3.5 w-3.5" /> Archive</button></>}</div></div>
      </article>)}</div>}
      <section className="mt-10 rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-5 sm:p-6"><div className="flex items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-[#b51f32]">Direct sales</p><h2 className="mt-1 text-xl font-semibold">Marketplace orders</h2></div><button onClick={() => orders.refetch()} aria-label="Refresh orders" className="rounded-lg border border-[#cbd4dc] p-2 text-[#59697a] hover:bg-[#f3f5f7]" data-testid="button-refresh-catalog-orders"><RefreshCw className="h-4 w-4" /></button></div>
        {orders.isLoading ? <div className="mt-5 h-14 animate-pulse rounded-lg bg-[#e1e6eb]" /> : orders.isError ? <p role="alert" className="mt-5 text-sm text-rose-700">Orders could not load. Try refreshing.</p> : !orders.data?.orders?.length ? <p className="mt-5 text-sm text-[#59697a]">No direct orders yet. Orders from published offers will appear here.</p> : <div className="mt-5 divide-y divide-[#dce2e8]">{orders.data.orders.map((order, index) => <div key={order.id ?? index} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between" data-testid={`row-catalog-order-${order.id ?? index}`}><div><p className="font-semibold">{catalog.data?.items.find(item => item.id === order.productId)?.name ?? order.productId ?? `Order ${order.id ?? index + 1}`}</p><p className="text-xs text-[#59697a]">{order.customerEmail || "Customer"}{order.createdAt ? ` · ${new Date(order.createdAt).toLocaleDateString()}` : ""}</p></div><div className="flex items-center gap-3"><span className="font-mono font-semibold">{typeof order.amountTotalCents === "number" ? catalogMoney(order.amountTotalCents) : ""}</span><span className="rounded-full bg-[#e9edf1] px-2 py-1 text-xs font-bold capitalize">{order.status || "Order"}</span></div></div>)}</div>}
      </section>
      <CatalogInquiryQueue />
    </div>
    {editing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#14253a]/60 p-3" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setEditing(null); }}><div role="dialog" aria-modal="true" aria-labelledby="catalog-form-title" className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-[#fffefd] p-5 shadow-2xl sm:p-7"><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-[#b51f32]">CSD catalog</p><h2 id="catalog-form-title" className="mt-1 text-2xl font-semibold">{editing === "new" ? "New item" : "Edit item"}</h2></div><button aria-label="Close editor" onClick={() => setEditing(null)} className="p-1 text-[#59697a]" data-testid="button-close-catalog"><X className="h-5 w-5" /></button></div>
      <form onSubmit={save} className="mt-6 space-y-4">
        <label className="block text-xs font-bold uppercase tracking-wide text-[#59697a]">Name<input required maxLength={120} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="mt-1 w-full rounded-lg border border-[#cbd4dc] bg-[#faf8f4] px-3 py-2.5 text-sm font-normal normal-case text-[#14253a]" data-testid="input-catalog-name" /></label>
        <label className="block text-xs font-bold uppercase tracking-wide text-[#59697a]">Description<textarea required value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={4} className="mt-1 w-full rounded-lg border border-[#cbd4dc] bg-[#faf8f4] px-3 py-2.5 text-sm font-normal normal-case text-[#14253a]" data-testid="input-catalog-description" /></label>
        <div className="grid grid-cols-2 gap-3"><label className="block text-xs font-bold uppercase tracking-wide text-[#59697a]">Type<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as CatalogInput["kind"] })} className="mt-1 w-full rounded-lg border border-[#cbd4dc] bg-[#faf8f4] px-3 py-2.5 text-sm font-normal text-[#14253a]" data-testid="select-catalog-kind"><option value="service">Service</option><option value="product">Product</option></select></label><label className="block text-xs font-bold uppercase tracking-wide text-[#59697a]">Price (USD)<input required type="number" min="0.01" step="0.01" value={price} onChange={e => setPrice(e.target.value)} className="mt-1 w-full rounded-lg border border-[#cbd4dc] bg-[#faf8f4] px-3 py-2.5 text-sm font-normal text-[#14253a]" data-testid="input-catalog-price" /></label></div>
        <label className="flex items-start gap-3 rounded-lg border border-[#dce2e8] bg-[#f3f5f7] p-3 text-sm"><input type="checkbox" checked={form.published} onChange={e => setForm({ ...form, published: e.target.checked })} className="mt-1" data-testid="input-catalog-published" /><span><strong>Publish as a CSD offer</strong><span className="block text-xs text-[#59697a]">Customers can see this offer and contact us or check out. Leave off to use only for invoices.</span></span></label>
        {error && <p role="alert" className="rounded-md bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setEditing(null)} className="rounded-lg px-4 py-2 text-sm font-semibold text-[#59697a]">Cancel</button><button disabled={busy} type="submit" className="rounded-lg bg-[#b51f32] px-5 py-2 text-sm font-bold text-white disabled:opacity-50" data-testid="button-save-catalog">{busy ? "Saving…" : editing === "new" ? "Create item" : "Save changes"}</button></div>
      </form></div></div>}
  </main>;
}