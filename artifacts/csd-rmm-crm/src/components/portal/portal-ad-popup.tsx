import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  browserStores,
  pickPortalAd,
  rememberDismissal,
  type PortalAd,
  type PortalAdEvent,
} from "@/lib/portal-ads";

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

export type PortalAdDismissReason = "close-button" | "skip" | "escape" | "outside" | "link";

export type PortalAdCallbacks = {
  /** The ad became visible. */
  onImpression?: (ad: PortalAd) => void;
  /** The visitor closed the ad (X, "No thanks", Escape, clicking outside). */
  onDismiss?: (ad: PortalAd, reason: PortalAdDismissReason) => void;
  /** The visitor followed the ad's link. */
  onAdClick?: (ad: PortalAd) => void;
};

/**
 * Default analytics: count the event on the server (shown to staff on the ad
 * list) and publish a `csd:portal-ad` DOM event any analytics tag can listen
 * to, e.g. window.addEventListener("csd:portal-ad", (e) => gtag(...)).
 */
export function recordPortalAdEvent(ad: PortalAd, type: PortalAdEvent, reason?: PortalAdDismissReason): void {
  try {
    window.dispatchEvent(new CustomEvent("csd:portal-ad", { detail: { type, adId: ad.id, title: ad.title, reason } }));
  } catch {
    // Old browsers without CustomEvent: the server count still happens.
  }
  void fetch(`${BASE_PATH}/api/portal/ads/${ad.id}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
    keepalive: true,
  }).catch(() => {});
}

const defaultCallbacks: Required<PortalAdCallbacks> = {
  onImpression: (ad) => recordPortalAdEvent(ad, "impression"),
  onDismiss: (ad, reason) => recordPortalAdEvent(ad, "dismiss", reason),
  onAdClick: (ad) => recordPortalAdEvent(ad, "click"),
};

function isInternalLink(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/**
 * The ad itself. Uses the shared Radix dialog, so it is announced as a dialog,
 * traps focus while open, closes on Escape or a click outside, and returns
 * focus to where the visitor was. There is always a way out: the corner X and
 * "No thanks".
 */
export function PortalAdDialog({
  ad,
  open,
  onClose,
  onLinkClick,
  imageSrc,
}: {
  ad: PortalAd;
  open: boolean;
  onClose: (reason: PortalAdDismissReason) => void;
  onLinkClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  /** Overrides the image URL (staff preview of an unsaved upload). */
  imageSrc?: string | null;
}) {
  // Radix reports every close through onOpenChange; remember which control did it.
  const reason = useRef<PortalAdDismissReason>("close-button");
  // Radix only returns focus to a trigger button, and this popup opens on its
  // own, so remember what had focus when it opened and go back there on close.
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = open;
  const href = ad.linkUrl ? (isInternalLink(ad.linkUrl) ? `${BASE_PATH}${ad.linkUrl}` : ad.linkUrl) : null;
  const src = imageSrc !== undefined ? imageSrc : ad.imageUrl ? `${BASE_PATH}${ad.imageUrl}` : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose(reason.current);
        reason.current = "close-button";
      }}
    >
      <DialogContent
        className="max-w-md gap-0 overflow-hidden p-0"
        data-testid="portal-ad"
        onEscapeKeyDown={() => { reason.current = "escape"; }}
        onPointerDownOutside={() => { reason.current = "outside"; }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocus.current;
          if (target && target.isConnected && target !== document.body) target.focus();
        }}
      >
        {src && (
          <img
            src={src}
            alt={ad.imageAlt}
            className="max-h-64 w-full bg-muted object-cover"
            data-testid="portal-ad-image"
          />
        )}
        <div className="space-y-2 p-6 pr-10">
          <DialogTitle className="text-lg font-semibold leading-tight">{ad.title}</DialogTitle>
          {ad.body ? (
            <DialogDescription className="whitespace-pre-line text-sm text-muted-foreground">{ad.body}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">Announcement from Computer Systems Depot</DialogDescription>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t bg-muted/40 px-6 py-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={() => { reason.current = "skip"; onClose("skip"); }}
            data-testid="portal-ad-skip"
          >
            No thanks
          </Button>
          {href && (
            <Button asChild className="bg-csd-red text-white hover:bg-red-700">
              <a
                href={href}
                {...(isInternalLink(ad.linkUrl!) ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                onClick={(event) => onLinkClick?.(event)}
                data-testid="portal-ad-link"
              >
                {ad.linkLabel || "Learn more"}
                {!isInternalLink(ad.linkUrl!) && <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />}
                {!isInternalLink(ad.linkUrl!) && <span className="sr-only"> (opens in a new tab)</span>}
              </a>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Loads live ads, waits the ad's configured delay, and shows the one
 * highest-priority ad the visitor hasn't dismissed. Mounted once for the
 * customer portal pages (App.tsx). Pass callbacks to plug in another analytics
 * provider; by default events are counted on the server and published as
 * `csd:portal-ad` DOM events.
 */
export default function PortalAdPopup({
  ads: providedAds,
  ...callbacks
}: PortalAdCallbacks & { ads?: PortalAd[] }) {
  const { onImpression, onDismiss, onAdClick } = { ...defaultCallbacks, ...callbacks };
  const [ad, setAd] = useState<PortalAd | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const choose = (ads: PortalAd[]) => {
      if (cancelled) return;
      const next = pickPortalAd(ads, browserStores());
      if (!next) return;
      setAd(next);
      timer = setTimeout(() => {
        if (!cancelled) setOpen(true);
      }, Math.max(0, next.delaySeconds) * 1000);
    };
    if (providedAds) {
      choose(providedAds);
    } else {
      fetch(`${BASE_PATH}/api/portal/ads/active`, { credentials: "same-origin" })
        .then((res) => (res.ok ? res.json() : { ads: [] }))
        .then((data: { ads?: PortalAd[] }) => choose(Array.isArray(data.ads) ? data.ads : []))
        .catch(() => {
          // No ads is always a safe outcome; the portal keeps working.
        });
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Ads are chosen once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const impressionSent = useRef<number | null>(null);
  useEffect(() => {
    if (open && ad && impressionSent.current !== ad.id) {
      impressionSent.current = ad.id;
      onImpression(ad);
    }
  }, [open, ad, onImpression]);

  if (!ad) return null;

  const close = (reason: PortalAdDismissReason) => {
    rememberDismissal(ad, browserStores());
    setOpen(false);
    if (reason === "link") onAdClick(ad);
    else onDismiss(ad, reason);
  };

  return <PortalAdDialog ad={ad} open={open} onClose={close} onLinkClick={() => close("link")} />;
}
