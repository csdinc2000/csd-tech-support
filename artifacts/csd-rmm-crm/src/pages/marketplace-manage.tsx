import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Eye, Mail, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import MarketplaceShell from "@/components/marketplace/portal-shell";
import ListingForm, { type ListingSubmitPayload } from "@/components/marketplace/listing-form";
import { ListingGallery, ListingSummary, StatusBadge } from "@/components/marketplace/listing-detail";
import { timeAgo, type FullListing, type ListingInquiry } from "@/lib/marketplace";

type ManageView = { listing: FullListing; inquiries: ListingInquiry[] };

function statusExplainer(listing: FullListing) {
  switch (listing.status) {
    case "pending":
      return { icon: Clock, tone: "border-amber-500/50 bg-amber-950/40 text-amber-200", text: "Waiting for our team to review it. We'll email you once it's live — usually within one business day." };
    case "active":
      return { icon: CheckCircle2, tone: "border-emerald-500/50 bg-emerald-950/40 text-emerald-200", text: "Your listing is live. Buyers who message you show up below and in your email." };
    case "sold":
      return { icon: CheckCircle2, tone: "border-zinc-700 bg-zinc-900 text-zinc-200", text: "Marked as sold. It still shows as sold for anyone with the link, but buyers can't contact you." };
    case "rejected":
      return { icon: AlertTriangle, tone: "border-red-500/50 bg-red-950/40 text-red-200", text: listing.reviewNote ? `Our team asked for changes: ${listing.reviewNote} — update the listing and it will be reviewed again.` : "Our team asked for changes. Update the listing and it will be reviewed again." };
    default:
      return { icon: Trash2, tone: "border-zinc-700 bg-zinc-900 text-zinc-200", text: "This listing was removed." };
  }
}

export default function MarketplaceManagePage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const key = [`/api/portal/marketplace/manage/${token}`];
  const query = useQuery<ManageView>({ queryKey: key, staleTime: 15_000, refetchOnWindowFocus: true });

  const update = useMutation({
    mutationFn: async (payload: ListingSubmitPayload) => {
      const { images: _i, ...body } = payload;
      const res = await apiRequest("PATCH", `/api/portal/marketplace/manage/${token}`, body);
      return res.json() as Promise<ManageView>;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      setEditing(false);
      toast({ title: data.listing.status === "pending" ? "Saved — sent back for review" : "Listing updated" });
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const setStatus = useMutation({
    mutationFn: async (status: "sold" | "removed" | "active") => {
      const res = await apiRequest("POST", `/api/portal/marketplace/manage/${token}/status`, { status });
      return res.json() as Promise<ManageView>;
    },
    onSuccess: (data, status) => {
      queryClient.setQueryData(key, data);
      toast({ title: status === "sold" ? "Marked as sold" : status === "removed" ? "Listing removed" : "Listing is active again" });
    },
    onError: (e: Error) => toast({ title: "Could not update", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  if (query.isLoading) {
    return <MarketplaceShell backHref="/portal/marketplace" backLabel="All listings" width="narrow"><div className="py-20 text-center font-mono text-sm text-zinc-500"><span className="inline-block h-2 w-2 rounded-full bg-red-500 pulse-dot-red mr-2 align-middle" />LOADING YOUR LISTING…</div></MarketplaceShell>;
  }
  if (query.isError || !query.data) {
    return (
      <MarketplaceShell backHref="/portal/marketplace" backLabel="All listings" width="narrow">
        <div className="cyber-panel rounded-xl p-10 text-center" data-testid="text-invalid-link">
          <AlertTriangle className="mx-auto h-10 w-10 text-red-500" />
          <p className="mt-3 font-semibold text-white">This manage link isn't valid.</p>
          <p className="mt-1 text-sm text-zinc-400">Check your email for the most recent link, or call us at 954-637-7300 and we'll send a new one.</p>
        </div>
      </MarketplaceShell>
    );
  }

  const { listing, inquiries } = query.data;
  const info = statusExplainer(listing);
  const Icon = info.icon;

  return (
    <MarketplaceShell backHref="/portal/marketplace" backLabel="All listings" width="wide">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white">Manage your listing</h1>
          <p className="text-sm text-zinc-400">Keep this page's link private — anyone with it can change your listing.</p>
        </div>
        <StatusBadge status={listing.status} />
      </div>

      <div className={`mt-4 flex gap-3 rounded-lg border p-4 text-sm ${info.tone}`} data-testid="text-status-explainer">
        <Icon className="h-5 w-5 shrink-0" />
        <p>{info.text}</p>
      </div>

      {editing ? (
        <div className="mt-6 cyber-panel rounded-xl p-5 sm:p-8">
          <ListingForm
            audience="seller"
            initial={listing}
            submitLabel="Save changes"
            submitting={update.isPending}
            onSubmit={(payload) => update.mutate(payload)}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-8 lg:grid-cols-5">
          <div className="lg:col-span-3 space-y-4">
            <ListingGallery imageIds={listing.imageIds} title={listing.title} />
            <div className="cyber-panel rounded-xl p-5">
              <ListingSummary listing={{ ...listing, sellerName: listing.sellerName, sellerPhone: listing.showPhone ? listing.sellerPhone : null }} showViews />
            </div>
          </div>
          <div className="lg:col-span-2 space-y-4">
            {listing.status !== "removed" && (
              <div className="cyber-panel rounded-xl p-5 space-y-2">
                <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">Actions</h2>
                <Button variant="outline" className="w-full justify-start border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-white" onClick={() => setEditing(true)} data-testid="button-edit-listing">
                  <Pencil className="h-4 w-4 mr-2" /> Edit listing or photos
                </Button>
                {listing.status === "active" && (
                  <Button className="w-full justify-start bg-red-600 hover:bg-red-500 glow-red" onClick={() => setStatus.mutate("sold")} disabled={setStatus.isPending} data-testid="button-mark-sold">
                    <CheckCircle2 className="h-4 w-4 mr-2" /> Mark as sold
                  </Button>
                )}
                {listing.status === "sold" && (
                  <Button variant="outline" className="w-full justify-start border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-white" onClick={() => setStatus.mutate("active")} disabled={setStatus.isPending} data-testid="button-relist">
                    <RotateCcw className="h-4 w-4 mr-2" /> Put it back up for sale
                  </Button>
                )}
                {listing.status === "active" && (
                  <Button asChild variant="outline" className="w-full justify-start border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-white">
                    <Link href={`/portal/marketplace/${listing.id}`}><Eye className="h-4 w-4 mr-2" /> View public listing</Link>
                  </Button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" className="w-full justify-start text-red-400 hover:text-red-300 hover:bg-red-950/50" data-testid="button-remove-listing">
                      <Trash2 className="h-4 w-4 mr-2" /> Remove listing
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove this listing?</AlertDialogTitle>
                      <AlertDialogDescription>It will disappear from the marketplace and can't be edited afterwards. You can always post a new listing later.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction className="bg-red-600 hover:bg-red-500" onClick={() => setStatus.mutate("removed")}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}

            <div className="cyber-panel rounded-xl p-5">
              <h2 className="flex items-center gap-2 font-semibold text-white"><Mail className="h-4 w-4 text-red-500" /> Interested buyers <span className="term-badge text-red-400 border-red-500/60 bg-red-950/40">{inquiries.length}</span></h2>
              {inquiries.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No messages yet. When a buyer contacts you it shows up here and in your email.</p>
              ) : (
                <ul className="mt-3 divide-y divide-zinc-800">
                  {inquiries.map((q) => (
                    <li key={q.id} className="py-3 text-sm" data-testid={`inquiry-${q.id}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-white">{q.buyerName}</span>
                        <span className="font-mono text-xs text-zinc-500">{timeAgo(q.createdAt)}</span>
                      </div>
                      <p className="text-xs text-zinc-400">
                        <a href={`mailto:${q.buyerEmail}`} className="text-red-400 hover:underline">{q.buyerEmail}</a>
                        {q.buyerPhone && <> · <a href={`tel:${q.buyerPhone}`} className="text-red-400 hover:underline">{q.buyerPhone}</a></>}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-zinc-300">{q.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </MarketplaceShell>
  );
}
