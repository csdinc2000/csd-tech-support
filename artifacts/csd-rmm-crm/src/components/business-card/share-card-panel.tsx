import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, Download, ExternalLink, Loader2, Mail, MessageSquare, QrCode as QrIcon, RefreshCw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cardSmsBody, toE164, type MyBusinessCard } from "@/lib/business-card";
import { BusinessCardView } from "./business-card-view";
import { QrCode, downloadQrPng } from "./qr-code";

const CARD_KEY = ["/api/staff-profile/me/card"] as const;

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const json = message.match(/\{.*\}$/)?.[0];
  if (json) {
    try { return (JSON.parse(json) as { error?: string }).error ?? message; } catch { /* fall through */ }
  }
  return message;
}

export function ShareCardPanel() {
  const { toast } = useToast();
  const { data, isLoading, isError } = useQuery<MyBusinessCard>({ queryKey: CARD_KEY, retry: false });
  const [showQr, setShowQr] = useState(false);
  const [sendMode, setSendMode] = useState<"sms" | "email" | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [headline, setHeadline] = useState("");
  const [recipient, setRecipient] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => { setHeadline(data?.settings.headline ?? ""); }, [data?.settings.headline]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: CARD_KEY });

  const saveSettings = useMutation({
    mutationFn: async (body: Partial<{ headline: string | null; showEmail: boolean; showDirectPhone: boolean }>) =>
      apiRequest("PATCH", "/api/staff-profile/me/card", body),
    onSuccess: refresh,
    onError: (e) => toast({ title: "Could not save card", description: errorText(e), variant: "destructive" }),
  });

  const rotate = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/staff-profile/me/card/rotate"),
    onSuccess: async () => {
      await refresh();
      setConfirmRotate(false);
      toast({ title: "New card link created", description: "Old links and QR codes no longer work." });
    },
    onError: (e) => toast({ title: "Could not replace link", description: errorText(e), variant: "destructive" }),
  });

  const send = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error("Card not loaded");
      if (sendMode === "sms") {
        const to = toE164(recipient);
        if (!to) throw new Error("Enter a valid mobile number, like (954) 555-0101.");
        await apiRequest("POST", "/api/sms/send", { to, body: cardSmsBody(data.card, recipientName) });
      } else {
        await apiRequest("POST", "/api/staff-profile/me/card/email", {
          to: recipient.trim(),
          recipientName: recipientName.trim() || undefined,
          message: note.trim() || undefined,
        });
      }
    },
    onSuccess: () => {
      toast({ title: "Card sent", description: `Your card was ${sendMode === "sms" ? "texted" : "emailed"} to ${recipient.trim()}.` });
      setSendMode(null);
      setRecipient(""); setRecipientName(""); setNote("");
    },
    onError: (e) => toast({ title: "Could not send card", description: errorText(e), variant: "destructive" }),
  });

  if (isLoading) {
    return <Card><CardContent className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></CardContent></Card>;
  }
  if (isError || !data) {
    return <Card><CardContent className="py-6 text-sm text-destructive">Could not load your business card.</CardContent></Card>;
  }

  const { card, settings } = data;
  const fileBase = card.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "card";

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(card.cardUrl);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Could not copy", description: card.cardUrl, variant: "destructive" });
    }
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: `${card.name} | ${card.company.name}`, text: `${card.name}'s contact card`, url: card.cardUrl });
    } catch { /* user cancelled */ }
  };

  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <Card data-testid="share-card-panel">
      <CardHeader>
        <CardTitle>My digital business card</CardTitle>
        <CardDescription>Send it to customers by text or email, or let them scan the QR code from your screen.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        <BusinessCardView card={card} preview className="mx-auto" />

        <div className="space-y-6">
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={() => setShowQr(true)} data-testid="button-show-qr">
              <QrIcon className="mr-2 h-4 w-4" /> Show QR to scan
            </Button>
            <Button variant="outline" onClick={() => { setRecipient(""); setSendMode("sms"); }} data-testid="button-text-card">
              <MessageSquare className="mr-2 h-4 w-4" /> Text card
            </Button>
            <Button
              variant="outline"
              onClick={() => { setRecipient(""); setSendMode("email"); }}
              disabled={!data.emailAvailable}
              title={data.emailAvailable ? undefined : "Company email is not set up yet"}
              data-testid="button-email-card"
            >
              <Mail className="mr-2 h-4 w-4" /> Email card
            </Button>
            {canNativeShare ? (
              <Button variant="outline" onClick={nativeShare} data-testid="button-share-card">
                <Share2 className="mr-2 h-4 w-4" /> Share…
              </Button>
            ) : (
              <Button variant="outline" onClick={copyLink} data-testid="button-copy-card-link">
                <Copy className="mr-2 h-4 w-4" /> Copy link
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-gray-50 p-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-600" data-testid="text-card-url">{card.cardUrl}</span>
            {canNativeShare && (
              <Button size="sm" variant="ghost" onClick={copyLink}><Copy className="h-4 w-4" /><span className="sr-only">Copy link</span></Button>
            )}
            <Button size="sm" variant="ghost" asChild>
              <a href={card.cardUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /><span className="sr-only">Open card</span></a>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => downloadQrPng(card.cardUrl, `${fileBase}-qr.png`)} data-testid="button-download-qr">
              <Download className="mr-1 h-4 w-4" /> QR image
            </Button>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">What's on your card</h3>
            <div className="space-y-1.5">
              <Label htmlFor="card-headline">Tagline (optional)</Label>
              <div className="flex gap-2">
                <Input
                  id="card-headline"
                  value={headline}
                  maxLength={140}
                  placeholder="e.g. Laptop & gaming PC repair specialist"
                  onChange={(e) => setHeadline(e.target.value)}
                  data-testid="input-card-headline"
                />
                <Button
                  variant="secondary"
                  disabled={saveSettings.isPending || headline.trim() === (settings.headline ?? "")}
                  onClick={() => saveSettings.mutate({ headline: headline.trim() || null })}
                  data-testid="button-save-headline"
                >
                  Save
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="card-show-email">Show my email</Label>
                <p className="text-xs text-gray-500">Otherwise the company email is shown.</p>
              </div>
              <Switch
                id="card-show-email"
                checked={settings.showEmail}
                disabled={saveSettings.isPending}
                onCheckedChange={(value) => saveSettings.mutate({ showEmail: value })}
                data-testid="switch-card-show-email"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="card-show-phone">Show my direct phone</Label>
                <p className="text-xs text-gray-500">
                  {data.hasDirectPhone
                    ? "Off by default. Customers always see the office line."
                    : "No phone on your staff profile. Ask an administrator to add one."}
                </p>
              </div>
              <Switch
                id="card-show-phone"
                checked={settings.showDirectPhone && data.hasDirectPhone}
                disabled={saveSettings.isPending || !data.hasDirectPhone}
                onCheckedChange={(value) => saveSettings.mutate({ showDirectPhone: value })}
                data-testid="switch-card-show-phone"
              />
            </div>
            <Button variant="ghost" size="sm" className="text-gray-600" onClick={() => setConfirmRotate(true)} data-testid="button-rotate-card">
              <RefreshCw className="mr-2 h-4 w-4" /> Replace card link
            </Button>
          </div>
        </div>
      </CardContent>

      {/* Full-screen QR for a customer to scan from the technician's phone. */}
      <Dialog open={showQr} onOpenChange={setShowQr}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Scan to get my card</DialogTitle>
            <DialogDescription>Ask the customer to point their phone camera at this code.</DialogDescription>
          </DialogHeader>
          <QrCode value={card.cardUrl} className="mx-auto w-full max-w-[320px] rounded-xl p-2" label={`QR code for ${card.name}'s card`} />
          <p className="text-center text-sm font-medium">{card.name} · {card.company.name}</p>
        </DialogContent>
      </Dialog>

      <Dialog open={sendMode !== null} onOpenChange={(open) => { if (!open) setSendMode(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{sendMode === "sms" ? "Text my card" : "Email my card"}</DialogTitle>
            <DialogDescription>
              {sendMode === "sms"
                ? "Sent from the business line. Replies arrive in the shared inbox."
                : "Sent from the company mailbox. Replies come to your email."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); send.mutate(); }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="card-recipient">{sendMode === "sms" ? "Customer's mobile number" : "Customer's email"}</Label>
              <Input
                id="card-recipient"
                type={sendMode === "sms" ? "tel" : "email"}
                autoComplete="off"
                required
                value={recipient}
                placeholder={sendMode === "sms" ? "(954) 555-0101" : "customer@example.com"}
                onChange={(e) => setRecipient(e.target.value)}
                data-testid="input-card-recipient"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="card-recipient-name">Customer's first name (optional)</Label>
              <Input id="card-recipient-name" value={recipientName} maxLength={120} onChange={(e) => setRecipientName(e.target.value)} data-testid="input-card-recipient-name" />
            </div>
            {sendMode === "email" ? (
              <div className="space-y-1.5">
                <Label htmlFor="card-note">Personal note (optional)</Label>
                <Textarea id="card-note" value={note} maxLength={1000} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="It was great working with you today…" />
              </div>
            ) : (
              <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-600" data-testid="text-sms-preview">
                {cardSmsBody(card, recipientName)}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSendMode(null)}>Cancel</Button>
              <Button type="submit" disabled={send.isPending || !recipient.trim()} data-testid="button-send-card">
                {send.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your card link?</AlertDialogTitle>
            <AlertDialogDescription>
              Every link and QR code you've already shared or printed will stop working. Use this if a link was shared somewhere it shouldn't be.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); rotate.mutate(); }} disabled={rotate.isPending}>
              Replace link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
