import { useDeferredValue, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AtSign, Check, Mail, Search, Send, ShieldCheck, X } from "lucide-react";
import type { CommunicationRecipient, CommunicationRecipientList } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";

const SUPPORT_ADDRESS = "support@computersystemsdepot.com";
const MAX_RECIPIENTS = 20;

type Recipient = CommunicationRecipient;
type ContactEmailPrefill = { id: number; fullName: string; email: string | null };
type EmailError = { status?: "rejected" | "unknown"; message?: string };

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function EmailComposePage() {
  const { toast } = useToast();
  const [searchText, setSearchText] = useState("");
  const search = useDeferredValue(searchText.trim());
  const [selected, setSelected] = useState<Recipient[]>([]);
  const [manualEmail, setManualEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [prefillContactId] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get("contactId");
    return raw && /^[1-9]\d*$/.test(raw) ? raw : "";
  });

  const recipientsQuery = useQuery<CommunicationRecipientList>({
    queryKey: ["/api/communications/recipients", search],
    queryFn: async () => {
      const result = await apiRequest("GET", `/api/communications/recipients?q=${encodeURIComponent(search)}`);
      return result.json();
    },
    enabled: search.length >= 2,
    staleTime: 10_000,
  });
  const prefillQuery = useQuery<ContactEmailPrefill>({
    queryKey: [`/api/crm/contacts/${prefillContactId}`],
    enabled: Boolean(prefillContactId),
  });

  useEffect(() => {
    const contact = prefillQuery.data;
    const email = contact?.email?.trim();
    if (!contact || !email || !validEmail(email)) return;
    setSelected((current) => current.some((item) => item.email.toLowerCase() === email.toLowerCase())
      ? current
      : [...current, {
          id: `contact:${contact.id}`,
          name: contact.fullName,
          email,
          kind: "customer",
          company: null,
        }]);
  }, [prefillQuery.data]);

  function addRecipient(person: Recipient) {
    setSelected((current) => current.some((item) => item.email.toLowerCase() === person.email.toLowerCase())
      ? current.filter((item) => item.email.toLowerCase() !== person.email.toLowerCase())
      : current.length >= MAX_RECIPIENTS ? current : [...current, person]);
    setUncertain(false);
    setNotice("");
  }

  function addManualRecipient() {
    const email = manualEmail.trim().toLowerCase();
    if (!validEmail(email)) {
      toast({ title: "Enter a valid email address", variant: "destructive" });
      return;
    }
    if (selected.some((recipient) => recipient.email.toLowerCase() === email)) {
      toast({ title: "That recipient is already selected" });
      return;
    }
    if (selected.length >= MAX_RECIPIENTS) {
      toast({ title: `Choose up to ${MAX_RECIPIENTS} recipients`, variant: "destructive" });
      return;
    }
    setSelected((current) => [...current, {
      id: `external:${email}`,
      name: email,
      email,
      kind: "customer",
      company: null,
    }]);
    setManualEmail("");
    setUncertain(false);
    setNotice("");
  }

  async function sendReviewedEmail() {
    setPending(true);
    setNotice("");
    try {
      const response = await apiRequest("POST", "/api/communications/email", {
        requestId,
        recipients: selected.map((recipient) => recipient.email),
        subject: subject.trim(),
        body,
      });
      const result = await response.json() as { status: string; message?: string };
      if (result.status !== "accepted") throw new Error(result.message || "The email was not confirmed.");
      setReviewOpen(false);
      setSelected([]);
      setSubject("");
      setBody("");
      setRequestId(crypto.randomUUID());
      setUncertain(false);
      toast({
        title: "Email accepted",
        description: `The email provider accepted the message for ${selected.length} recipient${selected.length === 1 ? "" : "s"}. This does not confirm inbox delivery.`,
      });
    } catch (error) {
      const payload = error instanceof ApiRequestError && typeof error.payload === "object" && error.payload
        ? error.payload as EmailError
        : null;
      const isUncertain = payload?.status === "unknown";
      setUncertain(isUncertain);
      setNotice(payload?.message || (error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Email submission failed."));
      setReviewOpen(false);
      toast({
        title: isUncertain ? "Delivery is uncertain" : "Email was not sent",
        description: payload?.message || "Review the email provider status before retrying.",
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  }

  const selectedEmails = new Set(selected.map((person) => person.email.toLowerCase()));
  const canReview = selected.length > 0 && selected.length <= MAX_RECIPIENTS && subject.trim().length > 0 && body.trim().length > 0;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 lg:p-8" data-testid="support-email-composer">
      <header className="border-l-4 border-csd-red pl-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-csd-red">
          <Mail className="h-4 w-4" /> CSD Support
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">New email</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Find staff or customer contacts, or add any email address. Recipients are hidden from one another.
        </p>
      </header>

      <Card className="overflow-hidden border-slate-200 shadow-sm">
        <CardHeader className="border-b bg-slate-50/70">
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-emerald-700" /> From CSD Support</CardTitle>
          <CardDescription>{SUPPORT_ADDRESS} · Replies go back to Support</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 p-5 sm:p-6">
          <section aria-labelledby="recipients-heading" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="recipients-heading" className="text-sm font-semibold text-slate-900">To</h2>
              <span className="text-xs text-muted-foreground">{selected.length} of {MAX_RECIPIENTS} recipients</span>
            </div>

            {selected.length > 0 && (
              <div className="flex flex-wrap gap-2 rounded-lg border bg-slate-50 p-3" data-testid="email-recipient-chips">
                {selected.map((person) => (
                  <span key={`${person.id}:${person.email}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-xs shadow-sm">
                    <span className="truncate">{person.name}<span className="ml-1 text-muted-foreground">&lt;{person.email}&gt;</span></span>
                    <button
                      type="button"
                      onClick={() => addRecipient(person)}
                      className="rounded-full p-0.5 text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                      aria-label={`Remove ${person.email}`}
                    ><X className="h-3.5 w-3.5" /></button>
                  </span>
                ))}
              </div>
            )}

            <label className="relative block">
              <span className="sr-only">Search staff and customers</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search names or email addresses"
                className="pl-9"
                data-testid="email-recipient-search"
                autoComplete="off"
              />
              {searchText && <button type="button" aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSearchText("")}><X className="h-4 w-4" /></button>}
            </label>

            {search.length < 2 && <p className="text-xs text-muted-foreground">Type at least two characters to search visible staff and CRM contacts.</p>}
            {search.length >= 2 && (
              <div className="max-h-56 overflow-y-auto rounded-lg border" role="listbox" aria-label="Contact search results">
                {recipientsQuery.isLoading && <p className="p-3 text-sm text-muted-foreground">Searching contacts…</p>}
                {recipientsQuery.isError && <p className="p-3 text-sm text-destructive">Could not search contacts. Try again.</p>}
                {!recipientsQuery.isLoading && !recipientsQuery.isError && (recipientsQuery.data?.recipients.length ?? 0) === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No matching staff or customer contacts. Add an email address below instead.</p>
                )}
                {recipientsQuery.data?.recipients.map((person) => {
                  const checked = selectedEmails.has(person.email.toLowerCase());
                  const limitReached = selected.length >= MAX_RECIPIENTS && !checked;
                  return (
                    <button
                      key={person.id}
                      type="button"
                      role="option"
                      aria-selected={checked}
                      disabled={limitReached}
                      onClick={() => addRecipient(person)}
                      className="flex w-full items-center gap-3 border-b px-3 py-2.5 text-left last:border-0 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${checked ? "border-csd-red bg-csd-red text-white" : "border-slate-300"}`}>
                        {checked && <Check className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{person.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{person.email}{person.company ? ` · ${person.company}` : ""}</span>
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                        {person.kind === "staff" ? "Staff" : "Customer"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                type="email"
                value={manualEmail}
                onChange={(event) => setManualEmail(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualRecipient(); } }}
                placeholder="Add any email address"
                aria-label="Add recipient email"
                data-testid="email-manual-recipient"
              />
              <Button type="button" variant="outline" onClick={addManualRecipient} disabled={!manualEmail.trim() || selected.length >= MAX_RECIPIENTS}>
                <AtSign className="mr-1.5 h-4 w-4" /> Add address
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">A maximum of {MAX_RECIPIENTS} recipients per email. Addresses are BCC’d for privacy.</p>
          </section>

          <section className="space-y-4 border-t pt-5" aria-label="Message">
            <label className="block space-y-2 text-sm font-medium">
              Subject
              <Input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} placeholder="What is this email about?" data-testid="email-subject" />
            </label>
            <label className="block space-y-2 text-sm font-medium">
              Message
              <Textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={10000} rows={9} placeholder="Write your message…" data-testid="email-body" />
              <span className="block text-right text-xs font-normal text-muted-foreground">{body.length.toLocaleString()} / 10,000 characters</span>
            </label>
          </section>

          {notice && (
            <div role="status" className={`rounded-lg border p-3 text-sm ${uncertain ? "border-amber-300 bg-amber-50 text-amber-950" : "border-rose-200 bg-rose-50 text-rose-950"}`}>
              <p className="font-medium">{uncertain ? "Check before retrying" : "Email not confirmed"}</p>
              <p className="mt-1">{notice}</p>
              {uncertain && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3 border-amber-400 bg-white"
                  onClick={() => {
                    setRequestId(crypto.randomUUID());
                    setUncertain(false);
                    setNotice("");
                  }}
                >
                  I checked sent mail — prepare a new attempt
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-col-reverse gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
            <Link href="/comms" className="text-center text-sm font-medium text-muted-foreground hover:text-foreground sm:text-left">Back to Communications</Link>
            <Button
              type="button"
              className="bg-csd-red hover:bg-red-700"
              disabled={!canReview || pending || uncertain}
              onClick={() => setReviewOpen(true)}
              data-testid="email-review-send"
            >
              <Send className="mr-2 h-4 w-4" /> Review and send
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={reviewOpen} onOpenChange={(open) => { if (!pending) setReviewOpen(open); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Review email before sending</DialogTitle>
            <DialogDescription>
              This sends from {SUPPORT_ADDRESS} to {selected.length} BCC recipient{selected.length === 1 ? "" : "s"}. Check the addresses and message carefully.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 rounded-lg border bg-slate-50 p-4 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recipients</p>
              <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto">
                {selected.map((person) => <li key={person.id} className="break-all">{person.name} &lt;{person.email}&gt;</li>)}
              </ul>
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</p>
              <p className="mt-1 break-words font-medium">{subject.trim()}</p>
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Message</p>
              <p className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words">{body}</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReviewOpen(false)} disabled={pending}>Keep editing</Button>
            <Button type="button" onClick={sendReviewedEmail} disabled={pending} className="bg-csd-red hover:bg-red-700" data-testid="email-confirm-send">
              {pending ? "Sending…" : <> <Send className="mr-2 h-4 w-4" /> Send email </>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
