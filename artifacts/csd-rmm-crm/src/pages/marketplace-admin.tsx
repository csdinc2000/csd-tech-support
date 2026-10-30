import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check, ExternalLink, ImageOff, Loader2, Mail, Pencil, Phone, PlusCircle, RotateCcw, Search, Store, Trash2, X, Link2, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import ListingForm, { type ListingSubmitPayload } from "@/components/marketplace/listing-form";
import { ListingGallery, ListingSummary, StatusBadge } from "@/components/marketplace/listing-detail";
import {
  STATUS_LABELS, categoryLabel, formatPrice, imageUrl, timeAgo,
  type FullListing, type ListingInquiry, type MarketplaceStatus,
} from "@/lib/marketplace";

type ListResponse = { listings: FullListing[]; counts: Record<MarketplaceStatus, number> };
type DetailResponse = { listing: FullListing; inquiries: ListingInquiry[] };

const LIST_KEY = ["/api/marketplace/listings"];
const TABS: Array<{ value: MarketplaceStatus | "all"; label: string }> = [
  { value: "pending", label: "Pending review" },
  { value: "active", label: "Active" },
  { value: "sold", label: "Sold" },
  { value: "rejected", label: "Needs changes" },
  { value: "removed", label: "Removed" },
  { value: "all", label: "All" },
];

const publicPath = (id: number) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/portal/marketplace/${id}`;
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Please try again.");

function ListingRow({ listing, onOpen, active }: { listing: FullListing; onOpen: () => void; active: boolean }) {
  const cover = imageUrl(listing.coverImageId);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`row-listing-${listing.id}`}
      className={cn(
        "flex w-full items-center gap-4 rounded-lg border bg-white p-3 text-left transition hover:border-red-300 hover:shadow-sm",
        active && "border-csd-red ring-1 ring-csd-red",
      )}
    >
      <div className="h-16 w-20 shrink-0 overflow-hidden rounded-md bg-gray-100">
        {cover ? <img src={cover} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-gray-300"><ImageOff className="h-5 w-5" /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-gray-900 truncate">{listing.title}</span>
          <StatusBadge status={listing.status} />
          {listing.source === "staff" && <Badge variant="outline">Posted by staff</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-gray-600 truncate">
          {formatPrice(listing.priceCents)} · {categoryLabel(listing.category)} · {listing.sellerName} · {listing.sellerEmail}
        </p>
        <p className="mt-0.5 text-xs text-gray-500">
          {listing.status === "pending" ? `Submitted ${timeAgo(listing.createdAt)}` : `Updated ${timeAgo(listing.updatedAt)}`}
          {listing.inquiryCount > 0 && <> · <span className="font-medium text-gray-700">{listing.inquiryCount} buyer message{listing.inquiryCount === 1 ? "" : "s"}</span></>}
          {listing.status === "active" && <> · {listing.viewCount} views</>}
        </p>
      </div>
      {listing.status === "pending" && <Clock className="h-5 w-5 shrink-0 text-amber-500" />}
    </button>
  );
}

function ListingDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const key = [`/api/marketplace/listings/${id}`];
  const query = useQuery<DetailResponse>({ queryKey: key, staleTime: 10_000 });

  const refresh = (data: DetailResponse) => {
    queryClient.setQueryData(key, data);
    void queryClient.invalidateQueries({ queryKey: LIST_KEY });
  };

  const setStatus = useMutation({
    mutationFn: async (input: { status: MarketplaceStatus; note?: string }) => {
      const res = await apiRequest("POST", `/api/marketplace/listings/${id}/status`, input);
      return res.json() as Promise<DetailResponse & { emailed: boolean | null }>;
    },
    onSuccess: (data, input) => {
      refresh(data);
      setRejecting(false);
      setRejectNote("");
      const label = input.status === "active" ? "Listing approved and live" : input.status === "rejected" ? "Sent back to the seller" : `Marked ${STATUS_LABELS[input.status].toLowerCase()}`;
      toast({ title: label, description: data.emailed === false ? "The seller email could not be sent." : undefined });
    },
    onError: (e) => toast({ title: "Could not update listing", description: errText(e), variant: "destructive" }),
  });

  const update = useMutation({
    mutationFn: async (payload: ListingSubmitPayload) => {
      const { images: _i, ...body } = payload;
      const res = await apiRequest("PATCH", `/api/marketplace/listings/${id}`, body);
      return res.json() as Promise<DetailResponse>;
    },
    onSuccess: (data) => { refresh(data); setEditing(false); toast({ title: "Listing updated" }); },
    onError: (e) => toast({ title: "Could not save", description: errText(e), variant: "destructive" }),
  });

  const resendLink = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/marketplace/listings/${id}/resend-link`)).json() as Promise<{ emailed: boolean }>,
    onSuccess: (data) => toast({
      title: data.emailed ? "New manage link emailed to the seller" : "Link regenerated, but the email failed",
      description: data.emailed ? undefined : "Check the email provider status and try again.",
      variant: data.emailed ? undefined : "destructive",
    }),
    onError: (e) => toast({ title: "Could not resend", description: errText(e), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/marketplace/listings/${id}`),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: LIST_KEY }); toast({ title: "Listing deleted" }); onClose(); },
    onError: (e) => toast({ title: "Could not delete", description: errText(e), variant: "destructive" }),
  });

  const listing = query.data?.listing;
  const inquiries = query.data?.inquiries ?? [];

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto p-0">
        {!listing ? (
          <div className="p-8 text-sm text-muted-foreground">{query.isError ? "Listing not found." : "Loading…"}</div>
        ) : editing ? (
          <div className="p-6">
            <SheetHeader className="mb-6"><SheetTitle>Edit listing</SheetTitle><SheetDescription>Changes are visible immediately — the seller is not notified.</SheetDescription></SheetHeader>
            <div className="cyber rounded-xl bg-zinc-950 border border-zinc-800 p-4 sm:p-6">
              <ListingForm audience="staff" initial={listing} requirePhoto={false} submitLabel="Save changes" submitting={update.isPending}
                onSubmit={(payload) => update.mutate(payload)} onCancel={() => setEditing(false)} />
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-6" data-testid="drawer-listing">
            <SheetHeader>
              <div className="flex items-center gap-2 pr-8">
                <StatusBadge status={listing.status} />
                {listing.source === "staff" && <Badge variant="outline">Posted by staff</Badge>}
                <span className="text-xs text-gray-500">#{listing.id}</span>
              </div>
              <SheetTitle className="sr-only">{listing.title}</SheetTitle>
              <SheetDescription className="sr-only">Listing details and moderation actions</SheetDescription>
            </SheetHeader>

            {/* Moderation actions */}
            <div className="rounded-lg border bg-gray-50 p-4">
              {listing.status === "pending" && !rejecting && (
                <div className="flex flex-wrap gap-2">
                  <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setStatus.mutate({ status: "active" })} disabled={setStatus.isPending} data-testid="button-approve">
                    <Check className="h-4 w-4 mr-2" /> Approve &amp; publish
                  </Button>
                  <Button variant="outline" onClick={() => setRejecting(true)} data-testid="button-reject">
                    <X className="h-4 w-4 mr-2" /> Send back for changes
                  </Button>
                </div>
              )}
              {rejecting && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-900">What should the seller fix?</p>
                  <Textarea rows={3} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="e.g. Please add a photo of the actual computer instead of a stock image." data-testid="input-reject-note" />
                  <div className="flex gap-2">
                    <Button className="bg-csd-red hover:bg-red-700" disabled={!rejectNote.trim() || setStatus.isPending} onClick={() => setStatus.mutate({ status: "rejected", note: rejectNote.trim() })} data-testid="button-confirm-reject">
                      Send to seller
                    </Button>
                    <Button variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
                  </div>
                </div>
              )}
              {listing.status !== "pending" && !rejecting && (
                <div className="flex flex-wrap gap-2">
                  {listing.status === "active" && (
                    <>
                      <Button variant="outline" onClick={() => setStatus.mutate({ status: "sold" })} disabled={setStatus.isPending}>Mark sold</Button>
                      <Button variant="outline" onClick={() => setStatus.mutate({ status: "removed" })} disabled={setStatus.isPending}>Take down</Button>
                      <Button asChild variant="outline"><a href={publicPath(listing.id)} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4 mr-2" /> View public page</a></Button>
                    </>
                  )}
                  {(listing.status === "sold" || listing.status === "removed" || listing.status === "rejected") && (
                    <Button variant="outline" onClick={() => setStatus.mutate({ status: "active" })} disabled={setStatus.isPending}>
                      <RotateCcw className="h-4 w-4 mr-2" /> Publish again
                    </Button>
                  )}
                </div>
              )}
              {listing.status === "rejected" && listing.reviewNote && (
                <p className="mt-3 text-sm text-gray-700"><span className="font-medium">Note sent to seller:</span> {listing.reviewNote}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)} data-testid="button-edit"><Pencil className="h-4 w-4 mr-2" /> Edit</Button>
                <Button variant="ghost" size="sm" onClick={() => resendLink.mutate()} disabled={resendLink.isPending}>
                  {resendLink.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />} Resend manage link
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-csd-red hover:text-red-700 hover:bg-red-50" data-testid="button-delete"><Trash2 className="h-4 w-4 mr-2" /> Delete permanently</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this listing?</AlertDialogTitle>
                      <AlertDialogDescription>The listing, its photos and buyer messages are permanently removed. Prefer "Take down" if you may need it again.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction className="bg-csd-red hover:bg-red-700" onClick={() => remove.mutate()}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>

            {/* Seller */}
            <div className="rounded-lg border p-4 text-sm">
              <p className="font-semibold text-gray-900">Seller</p>
              <p className="mt-1 text-gray-800">{listing.sellerName}</p>
              <p className="flex flex-wrap gap-x-4 text-gray-600">
                <a href={`mailto:${listing.sellerEmail}`} className="inline-flex items-center gap-1 hover:text-csd-red"><Mail className="h-3.5 w-3.5" />{listing.sellerEmail}</a>
                {listing.sellerPhone && <a href={`tel:${listing.sellerPhone}`} className="inline-flex items-center gap-1 hover:text-csd-red"><Phone className="h-3.5 w-3.5" />{listing.sellerPhone}{listing.showPhone ? " (shown publicly)" : " (hidden)"}</a>}
              </p>
            </div>

            {/* Rendered in the marketplace's dark theme — this is what buyers see. */}
            <div className="cyber rounded-xl bg-zinc-950 border border-zinc-800 p-4 space-y-4" data-testid="preview-listing">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">Public preview</p>
              <ListingGallery imageIds={listing.imageIds} title={listing.title} />
              <ListingSummary listing={{ ...listing, sellerPhone: null }} showViews />
            </div>

            {/* Inquiries */}
            <div className="rounded-lg border p-4">
              <p className="font-semibold text-gray-900">Buyer messages ({inquiries.length})</p>
              {inquiries.length === 0 ? (
                <p className="mt-1 text-sm text-gray-500">No buyer has contacted the seller yet.</p>
              ) : (
                <ul className="mt-2 divide-y text-sm">
                  {inquiries.map((q) => (
                    <li key={q.id} className="py-2">
                      <div className="flex justify-between gap-2"><span className="font-medium">{q.buyerName}</span><span className="text-xs text-gray-500">{timeAgo(q.createdAt)}</span></div>
                      <p className="text-xs text-gray-600">{q.buyerEmail}{q.buyerPhone ? ` · ${q.buyerPhone}` : ""}</p>
                      <p className="mt-1 whitespace-pre-wrap text-gray-700">{q.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function MarketplaceAdminPage() {
  const { toast } = useToast();
  const [location, navigate] = useLocation();
  const [tab, setTab] = useState<MarketplaceStatus | "all">("pending");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState<{ emailed: boolean; email: string } | null>(null);

  const query = useQuery<ListResponse>({ queryKey: LIST_KEY, staleTime: 15_000, refetchInterval: 60_000, refetchOnWindowFocus: true });

  // Deep link from the "listing awaiting review" email: /marketplace?listing=123
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("listing");
    if (wanted && /^\d+$/.test(wanted)) {
      setSelectedId(Number(wanted));
      navigate(location, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Land on the first tab that has anything in it (pending first).
  useEffect(() => {
    if (!query.data) return;
    if (tab === "pending" && query.data.counts.pending === 0 && query.data.counts.active > 0) setTab("active");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  const create = useMutation({
    mutationFn: async (payload: ListingSubmitPayload) => {
      const { addImages: _a, removeImageIds: _r, ...body } = payload;
      const res = await apiRequest("POST", "/api/marketplace/listings", body);
      return { ...(await res.json()) as { listing: FullListing; emailed: boolean }, email: payload.sellerEmail };
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      setPosting(false);
      setPostResult({ emailed: data.emailed, email: data.email });
      setTab("active");
      setSelectedId(data.listing.id);
      toast({ title: "Listing published", description: data.emailed ? `Manage link emailed to ${data.email}` : "The seller email could not be sent — use “Resend manage link” once email is back." });
    },
    onError: (e) => toast({ title: "Could not post listing", description: errText(e), variant: "destructive" }),
  });

  const rows = useMemo(() => {
    const all = query.data?.listings ?? [];
    const q = search.trim().toLowerCase();
    return all.filter((l) =>
      (tab === "all" || l.status === tab) &&
      (!q || l.title.toLowerCase().includes(q) || l.sellerName.toLowerCase().includes(q) || l.sellerEmail.toLowerCase().includes(q) || String(l.id) === q),
    );
  }, [query.data, tab, search]);

  const counts = query.data?.counts;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6" data-testid="page-marketplace-admin">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold"><Store className="h-8 w-8 text-csd-red" /> Community Marketplace</h1>
          <p className="mt-1 text-muted-foreground">Review customer listings before they go live, and post listings for customers who call in.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline"><a href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/portal/marketplace`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4 mr-2" /> Public page</a></Button>
          <Button className="bg-csd-red hover:bg-red-700" onClick={() => setPosting(true)} data-testid="button-post-for-customer"><PlusCircle className="h-4 w-4 mr-2" /> Post for a customer</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([["pending", "Awaiting review", "text-amber-600"], ["active", "Live now", "text-emerald-600"], ["sold", "Sold", "text-gray-700"], ["rejected", "Needs changes", "text-csd-red"]] as const).map(([status, label, tone]) => (
          <Card key={status} className={cn("cursor-pointer transition hover:border-red-300", tab === status && "border-csd-red")} onClick={() => setTab(status)}>
            <CardContent className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className={cn("mt-1 text-3xl font-bold", tone)} data-testid={`stat-${status}`}>{counts ? counts[status] : "–"}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as MarketplaceStatus | "all")}>
          <TabsList className="flex-wrap h-auto">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} data-testid={`tab-${t.value}`}>
                {t.label}{counts && t.value !== "all" ? <span className="ml-1.5 rounded-full bg-gray-200 px-1.5 text-[11px] text-gray-700">{counts[t.value]}</span> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative md:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title, seller, email, #id" className="pl-9 bg-white" data-testid="input-admin-search" />
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading listings…</p>
      ) : query.isError ? (
        <Card className="border-red-200"><CardContent className="p-6"><p>Listings could not load.</p><Button variant="outline" className="mt-3" onClick={() => query.refetch()}>Try again</Button></CardContent></Card>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border bg-white p-12 text-center text-sm text-muted-foreground" data-testid="text-admin-empty">
          {tab === "pending" ? "Nothing waiting for review. 🎉" : "No listings here."}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((l) => <ListingRow key={l.id} listing={l} active={selectedId === l.id} onOpen={() => setSelectedId(l.id)} />)}
        </div>
      )}

      {selectedId != null && <ListingDrawer id={selectedId} onClose={() => setSelectedId(null)} />}

      <Dialog open={posting} onOpenChange={setPosting}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Post a listing for a customer</DialogTitle>
            <DialogDescription>Goes live immediately. The customer gets an email with a private link to edit or remove it. Photos can be added later if you don't have them yet.</DialogDescription>
          </DialogHeader>
          <div className="cyber rounded-xl bg-zinc-950 border border-zinc-800 p-4 sm:p-6">
            <ListingForm audience="staff" requirePhoto={false} submitLabel="Publish listing" submitting={create.isPending} onSubmit={(p) => create.mutate(p)} onCancel={() => setPosting(false)} />
          </div>
        </DialogContent>
      </Dialog>

      {postResult && !postResult.emailed && (
        <p className="text-xs text-muted-foreground">Heads-up: the manage-link email to {postResult.email} failed. Open the listing and use “Resend manage link”.</p>
      )}
    </div>
  );
}
