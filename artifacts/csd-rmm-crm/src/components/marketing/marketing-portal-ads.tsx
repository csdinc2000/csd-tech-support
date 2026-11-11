import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Eye, ImagePlus, Megaphone, MousePointerClick, Pencil, Plus, Trash2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { compressPhoto } from "@/lib/marketplace";
import { describeSuppression, type PortalAd } from "@/lib/portal-ads";
import { cn } from "@/lib/utils";
import { PortalAdDialog } from "@/components/portal/portal-ad-popup";
import { MarketingCard, StatTile } from "./shared";

/**
 * Portal popup ads (Marketing → All modules → Portal popup ads). Staff write
 * the ad, choose when it runs, its priority, the delay before it appears and
 * how long a dismissal hides it. Customers see one ad at a time on the portal
 * pages and can always close it. Server: api-server/src/portal-ads.ts.
 */

type AdState = "live" | "scheduled" | "ended" | "off";
type StaffAd = PortalAd & {
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  state: AdState;
  impressions: number;
  dismissals: number;
  clicks: number;
};

type Draft = {
  id: number | null;
  title: string;
  body: string;
  imageAlt: string;
  linkUrl: string;
  linkLabel: string;
  isActive: boolean;
  startsAt: string;
  endsAt: string;
  priority: number;
  delaySeconds: number;
  suppressHours: number;
  /** Existing image (edit) or new upload preview. */
  imagePreview: string | null;
  imageBase64: string | null;
  removeImage: boolean;
};

const QUERY_KEY = ["/api/crm/portal-ads"];
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");
const SUPPRESS_PRESETS = [
  { hours: 0, label: "This visit" },
  { hours: 24, label: "1 day" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
];
const STATE_TONE: Record<AdState, string> = {
  live: "bg-emerald-100 text-emerald-800",
  scheduled: "bg-blue-100 text-blue-800",
  ended: "bg-gray-100 text-gray-600",
  off: "bg-amber-100 text-amber-800",
};
const STATE_LABEL: Record<AdState, string> = { live: "Live", scheduled: "Scheduled", ended: "Ended", off: "Off" };

const emptyDraft = (): Draft => ({
  id: null, title: "", body: "", imageAlt: "", linkUrl: "", linkLabel: "", isActive: true,
  startsAt: "", endsAt: "", priority: 0, delaySeconds: 3, suppressHours: 24,
  imagePreview: null, imageBase64: null, removeImage: false,
});

const toLocalInput = (iso: string | null) => (iso ? format(new Date(iso), "yyyy-MM-dd'T'HH:mm") : "");
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);
const errorText = (error: unknown) => (error instanceof Error ? error.message.replace(/^\d+:\s*/, "").replace(/^\{"error":"(.*)"\}$/, "$1") : "Request failed");

function draftFrom(ad: StaffAd): Draft {
  return {
    id: ad.id, title: ad.title, body: ad.body, imageAlt: ad.imageAlt, linkUrl: ad.linkUrl ?? "", linkLabel: ad.linkLabel ?? "",
    isActive: ad.isActive, startsAt: toLocalInput(ad.startsAt), endsAt: toLocalInput(ad.endsAt), priority: ad.priority,
    delaySeconds: ad.delaySeconds, suppressHours: ad.suppressHours,
    imagePreview: ad.imageUrl ? `${BASE_PATH}${ad.imageUrl}` : null, imageBase64: null, removeImage: false,
  };
}

/** What the popup would show for this draft (preview uses the real component). */
function previewAd(draft: Draft): PortalAd {
  return {
    id: draft.id ?? 0, title: draft.title || "Your headline", body: draft.body, imageAlt: draft.imageAlt,
    // The preview passes its image separately (imageSrc), as an unsaved upload has no URL yet.
    imageUrl: null, linkUrl: draft.linkUrl.trim() || null, linkLabel: draft.linkLabel.trim() || null,
    priority: draft.priority, delaySeconds: draft.delaySeconds, suppressHours: draft.suppressHours,
  };
}

export function MarketingPortalAds() {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Draft | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const adsQuery = useQuery<{ ads: StaffAd[] }>({ queryKey: QUERY_KEY });
  const ads = adsQuery.data?.ads ?? [];

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const payload = {
        title: d.title, body: d.body, imageAlt: d.imageAlt, linkUrl: d.linkUrl.trim() || null,
        linkLabel: d.linkLabel.trim() || null, isActive: d.isActive, startsAt: fromLocalInput(d.startsAt),
        endsAt: fromLocalInput(d.endsAt), priority: d.priority, delaySeconds: d.delaySeconds, suppressHours: d.suppressHours,
        ...(d.imageBase64 ? { imageBase64: d.imageBase64 } : {}),
        ...(d.removeImage && !d.imageBase64 ? { removeImage: true } : {}),
      };
      const res = await apiRequest(d.id ? "PUT" : "POST", d.id ? `/api/crm/portal-ads/${d.id}` : "/api/crm/portal-ads", payload);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: draft?.id ? "Ad updated" : "Ad created" });
      setDraft(null);
    },
    onError: (error) => toast({ title: "Could not save the ad", description: errorText(error), variant: "destructive" }),
  });

  const toggle = useMutation({
    mutationFn: async (ad: StaffAd) => {
      const d = { ...draftFrom(ad), isActive: !ad.isActive };
      return (await apiRequest("PUT", `/api/crm/portal-ads/${ad.id}`, {
        title: d.title, body: d.body, imageAlt: d.imageAlt, linkUrl: d.linkUrl || null, linkLabel: d.linkLabel || null,
        isActive: d.isActive, startsAt: ad.startsAt, endsAt: ad.endsAt, priority: d.priority,
        delaySeconds: d.delaySeconds, suppressHours: d.suppressHours,
      })).json();
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (error) => toast({ title: "Could not update the ad", description: errorText(error), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (ad: StaffAd) => apiRequest("DELETE", `/api/crm/portal-ads/${ad.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: "Ad deleted" });
    },
    onError: (error) => toast({ title: "Could not delete the ad", description: errorText(error), variant: "destructive" }),
  });

  const pickImage = async (file: File | undefined) => {
    if (!file || !draft) return;
    try {
      const photo = await compressPhoto(file);
      setDraft({ ...draft, imagePreview: photo.previewUrl, imageBase64: photo.dataBase64, removeImage: false });
    } catch (error) {
      toast({ title: "Could not use that image", description: errorText(error), variant: "destructive" });
    }
  };

  const totals = ads.reduce(
    (sum, ad) => ({ impressions: sum.impressions + ad.impressions, dismissals: sum.dismissals + ad.dismissals, clicks: sum.clicks + ad.clicks }),
    { impressions: 0, dismissals: 0, clicks: 0 },
  );
  const live = ads.filter((ad) => ad.state === "live").length;

  return (
    <div className="space-y-4" data-testid="portal-ads-manager">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={Megaphone} label="Live ads" value={live} hint={`${ads.length} total`} testId="portal-ads-live" />
        <StatTile icon={Eye} label="Times shown" value={totals.impressions} />
        <StatTile icon={MousePointerClick} label="Link clicks" value={totals.clicks} />
        <StatTile icon={XCircle} label="Closed" value={totals.dismissals} />
      </div>

      <MarketingCard
        icon={Megaphone}
        title="Portal popup ads"
        description="Shown one at a time on the customer portal (home, ticket, referrals, marketplace). Customers can always close them."
        actions={!draft && (
          <Button size="sm" onClick={() => setDraft(emptyDraft())} data-testid="portal-ad-new">
            <Plus className="mr-1.5 h-4 w-4" /> New ad
          </Button>
        )}
      >
        {draft && (
          <form
            className="mb-6 space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4"
            onSubmit={(event) => { event.preventDefault(); save.mutate(draft); }}
            data-testid="portal-ad-form"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{draft.id ? "Edit ad" : "New ad"}</h3>
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} aria-label="Cancel editing">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="ad-title">Headline</Label>
                <Input id="ad-title" value={draft.title} maxLength={120} required onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="ad-body">Message</Label>
                <Textarea id="ad-body" value={draft.body} maxLength={1000} rows={3} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <Label>Image (optional)</Label>
                <div className="flex flex-wrap items-center gap-3">
                  {draft.imagePreview && !draft.removeImage ? (
                    <img src={draft.imagePreview} alt="" className="h-20 w-32 rounded border object-cover" />
                  ) : (
                    <div className="flex h-20 w-32 items-center justify-center rounded border border-dashed text-xs text-gray-400">No image</div>
                  )}
                  <input ref={fileInput} type="file" accept="image/*" className="sr-only" aria-label="Upload ad image" onChange={(e) => void pickImage(e.target.files?.[0])} />
                  <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                    <ImagePlus className="mr-1.5 h-4 w-4" /> {draft.imagePreview && !draft.removeImage ? "Replace" : "Upload"}
                  </Button>
                  {draft.imagePreview && !draft.removeImage && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, removeImage: true, imageBase64: null })}>Remove</Button>
                  )}
                </div>
                {draft.imagePreview && !draft.removeImage && (
                  <Input
                    aria-label="Image description for screen readers"
                    placeholder="Describe the image for screen readers"
                    value={draft.imageAlt}
                    maxLength={200}
                    onChange={(e) => setDraft({ ...draft, imageAlt: e.target.value })}
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ad-link">Link (optional)</Label>
                <Input id="ad-link" placeholder="/portal/referrals or https://…" value={draft.linkUrl} maxLength={500} onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ad-link-label">Button text</Label>
                <Input id="ad-link-label" placeholder="Learn more" value={draft.linkLabel} maxLength={60} onChange={(e) => setDraft({ ...draft, linkLabel: e.target.value })} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ad-start">Starts (optional)</Label>
                <Input id="ad-start" type="datetime-local" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ad-end">Ends (optional)</Label>
                <Input id="ad-end" type="datetime-local" value={draft.endsAt} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ad-priority">Priority (0–100, highest shows first)</Label>
                <Input id="ad-priority" type="number" min={0} max={100} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ad-delay">Delay before showing (seconds, 0–120)</Label>
                <Input id="ad-delay" type="number" min={0} max={120} value={draft.delaySeconds} onChange={(e) => setDraft({ ...draft, delaySeconds: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })} />
              </div>

              <fieldset className="space-y-1.5 md:col-span-2">
                <legend className="text-sm font-medium">After a customer closes it, hide it</legend>
                <div className="flex flex-wrap items-center gap-2">
                  {SUPPRESS_PRESETS.map((preset) => (
                    <Button
                      key={preset.hours}
                      type="button"
                      size="sm"
                      variant={draft.suppressHours === preset.hours ? "default" : "outline"}
                      aria-pressed={draft.suppressHours === preset.hours}
                      onClick={() => setDraft({ ...draft, suppressHours: preset.hours })}
                    >
                      {preset.label}
                    </Button>
                  ))}
                  <Label htmlFor="ad-suppress" className="ml-2 text-xs text-gray-500">or hours:</Label>
                  <Input id="ad-suppress" type="number" min={0} max={8760} className="w-24" value={draft.suppressHours} onChange={(e) => setDraft({ ...draft, suppressHours: Math.max(0, Math.min(8760, Number(e.target.value) || 0)) })} />
                </div>
                <p className="text-xs text-gray-500">Hidden {describeSuppression(draft.suppressHours)} on that device.</p>
              </fieldset>

              <div className="flex items-center gap-2">
                <Switch id="ad-active" checked={draft.isActive} onCheckedChange={(checked) => setDraft({ ...draft, isActive: checked })} />
                <Label htmlFor="ad-active">Active</Label>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setPreview(draft)}>
                <Eye className="mr-1.5 h-4 w-4" /> Preview
              </Button>
              <Button type="submit" disabled={save.isPending || !draft.title.trim()} data-testid="portal-ad-save">
                {save.isPending ? "Saving…" : draft.id ? "Save changes" : "Create ad"}
              </Button>
            </div>
          </form>
        )}

        {adsQuery.isLoading && <p className="text-sm text-gray-500">Loading ads…</p>}
        {adsQuery.error && <p className="text-sm text-red-700">Ads could not be loaded: {errorText(adsQuery.error)}</p>}
        {!adsQuery.isLoading && ads.length === 0 && !draft && (
          <p className="text-sm text-gray-500">No ads yet. Create one to promote an offer on the customer portal.</p>
        )}

        <ul className="divide-y divide-gray-100" data-testid="portal-ad-list">
          {ads.map((ad) => {
            const closeRate = ad.impressions ? Math.round((ad.dismissals / ad.impressions) * 100) : null;
            const clickRate = ad.impressions ? Math.round((ad.clicks / ad.impressions) * 100) : null;
            return (
              <li key={ad.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center" data-testid={`portal-ad-row-${ad.id}`}>
                {ad.imageUrl ? (
                  <img src={`${BASE_PATH}${ad.imageUrl}`} alt="" className="h-14 w-20 shrink-0 rounded border object-cover" />
                ) : (
                  <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded border border-dashed text-gray-300"><Megaphone className="h-5 w-5" /></div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">{ad.title}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATE_TONE[ad.state])}>{STATE_LABEL[ad.state]}</span>
                    <span className="text-[11px] text-gray-500">Priority {ad.priority}</span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {ad.startsAt ? `From ${format(new Date(ad.startsAt), "MMM d, h:mm a")}` : "No start date"}
                    {" · "}
                    {ad.endsAt ? `until ${format(new Date(ad.endsAt), "MMM d, h:mm a")}` : "no end date"}
                    {" · "}after {ad.delaySeconds}s · hidden {describeSuppression(ad.suppressHours)} once closed
                  </p>
                  <p className="text-xs text-gray-500">
                    Shown {ad.impressions} · clicked {ad.clicks}{clickRate != null ? ` (${clickRate}%)` : ""} · closed {ad.dismissals}{closeRate != null ? ` (${closeRate}%)` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={ad.isActive}
                    onCheckedChange={() => toggle.mutate(ad)}
                    aria-label={ad.isActive ? `Turn off ${ad.title}` : `Turn on ${ad.title}`}
                  />
                  <Button variant="ghost" size="sm" onClick={() => setPreview(draftFrom(ad))} aria-label={`Preview ${ad.title}`}><Eye className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => setDraft(draftFrom(ad))} aria-label={`Edit ${ad.title}`}><Pencil className="h-4 w-4" /></Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { if (window.confirm(`Delete "${ad.title}"? This can't be undone.`)) remove.mutate(ad); }}
                    aria-label={`Delete ${ad.title}`}
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </MarketingCard>

      {preview && (
        <PreviewDialog draft={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

/** Staff preview: the real customer popup, without counting or remembering anything. */
function PreviewDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const ad = previewAd(draft);
  const image = draft.imagePreview && !draft.removeImage ? draft.imagePreview : null;
  return (
    <PortalAdDialog
      ad={ad}
      imageSrc={image}
      open
      onClose={onClose}
      // Don't leave the staff page from a preview.
      onLinkClick={(event) => { event.preventDefault(); onClose(); }}
    />
  );
}
