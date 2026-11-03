import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ArrowLeft, CheckCircle2, Copy, Check, Gift, Mail, MessageSquare, PartyPopper, Send, Share2, UserPlus, Users, Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

type Program = { active: boolean; referrerReward: string; friendReward: string; terms: string };
type Dashboard = {
  referrer: { firstName: string; code: string; shareUrl: string; status: "active" | "paused" };
  program: Program;
  summary: { total: number; pending: number; qualified: number; rewarded: number; declined: number };
  referrals: { friendName: string; status: string; createdAt: string; rewardedAt: string | null }[];
};

const PHONE_DISPLAY = "954-637-7300";
const errorText = (error: unknown) => (error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Something went wrong. Please try again.");

function PortalFrame({ children, back = { href: "/portal", label: "Back to Customer Portal" } }: { children: React.ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
        <Link href={back.href} className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-red-600" data-testid="link-back">
          <ArrowLeft className="h-4 w-4" />
          {back.label}
        </Link>
        {children}
        <p className="pb-8 text-center text-sm text-gray-500">
          Questions? Call <a href="tel:9546377300" className="font-semibold text-red-600 hover:text-red-700">{PHONE_DISPLAY}</a>
        </p>
      </div>
    </div>
  );
}

function Terms({ terms }: { terms: string }) {
  return (
    <details className="rounded-xl border bg-white p-4 text-sm text-gray-600">
      <summary className="cursor-pointer font-medium text-gray-800">Program terms</summary>
      <p className="mt-2 whitespace-pre-line">{terms}</p>
    </details>
  );
}

// ---------------------------------------------------------------------------
// /portal/referrals — explain the program and sign up
// ---------------------------------------------------------------------------

export default function PortalReferralsPage() {
  const { data: program, isLoading, error } = useQuery<Program>({ queryKey: ["/api/portal/referrals/program"] });
  const [form, setForm] = useState({ fullName: "", email: "", phone: "" });
  const join = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/portal/referrals/join", form)).json() as Promise<{ message: string }>,
  });

  const steps = [
    { icon: Share2, title: "Share your link", body: "Join below and we'll email you a personal link and code to send to friends and family." },
    { icon: Wrench, title: "They get help", body: program ? `Your friend requests service with your link and gets ${program.friendReward}.` : "Your friend requests service with your link." },
    { icon: Gift, title: "You get rewarded", body: program ? `After their first service is completed, you get ${program.referrerReward}.` : "After their first service is completed, you get a reward." },
  ];

  return (
    <PortalFrame>
      <section className="overflow-hidden rounded-2xl bg-gray-950 text-white shadow-lg">
        <div className="flex flex-col gap-6 p-6 sm:p-8 md:flex-row md:items-center">
          <div className="min-w-0 flex-1 space-y-3">
            <img src={csdLogo} alt="Computer Systems Depot" className="h-10 rounded bg-white px-2 py-1" />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-400">Refer a friend</p>
            <h1 className="text-2xl font-bold sm:text-3xl" data-testid="referral-headline">
              {program ? <>Give {program.friendReward}. Get {program.referrerReward}.</> : "Share the help. Get rewarded."}
            </h1>
            <p className="text-sm text-gray-300 sm:text-base">
              Know someone with a slow, broken or infected computer? Send them to the people you trust — and we'll thank you for it.
            </p>
          </div>
          <div className="flex h-20 w-20 shrink-0 items-center justify-center self-start rounded-2xl bg-red-600 md:h-28 md:w-28 md:self-auto">
            <Gift className="h-10 w-10 md:h-14 md:w-14" />
          </div>
        </div>
      </section>

      <ol className="grid gap-3 sm:grid-cols-3" aria-label="How it works">
        {steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <li key={step.title} className="flex gap-3 rounded-xl border bg-white p-4 sm:flex-col">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
                <Icon className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xs font-semibold text-red-600">Step {i + 1}</p>
                <h2 className="font-semibold text-gray-900">{step.title}</h2>
                <p className="mt-1 text-sm text-gray-600">{step.body}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <section className="rounded-xl border bg-white p-5 sm:p-6" data-testid="referral-join">
        {isLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : error || !program ? (
          <p className="text-sm text-red-700">We couldn't load the referral program. Please try again later.</p>
        ) : !program.active ? (
          <p className="text-sm text-gray-700" data-testid="referral-paused">The referral program is paused right now. Please check back soon.</p>
        ) : join.isSuccess ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center" data-testid="referral-join-success">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <Mail className="h-6 w-6" />
            </span>
            <h2 className="text-lg font-semibold text-gray-900">Check your email</h2>
            <p className="max-w-md text-sm text-gray-600">
              We sent your personal referral link and code to <strong>{form.email}</strong>. It also has a private link to track your referrals.
            </p>
            <Button variant="outline" size="sm" onClick={() => join.reset()}>Use a different email</Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => { event.preventDefault(); join.mutate(); }}
          >
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900"><UserPlus className="h-5 w-5 text-red-600" />Get my referral link</h2>
              <p className="text-sm text-gray-600">Already joined? Enter the same email and we'll send your link again.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ref-name">Your name</Label>
                <Input id="ref-name" autoComplete="name" required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ref-email">Email</Label>
                <Input id="ref-email" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ref-phone">Mobile phone <span className="font-normal text-gray-500">(optional)</span></Label>
                <Input id="ref-phone" type="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>
            {join.isError && <p role="alert" className="text-sm text-red-700">{errorText(join.error)}</p>}
            <Button type="submit" className="w-full bg-red-600 hover:bg-red-700 sm:w-auto" disabled={join.isPending} data-testid="referral-join-submit">
              <Send className="mr-2 h-4 w-4" />
              {join.isPending ? "Sending…" : "Email me my link"}
            </Button>
          </form>
        )}
      </section>

      {program && <Terms terms={program.terms} />}
    </PortalFrame>
  );
}

// ---------------------------------------------------------------------------
// /portal/referrals/r/:token — the referrer's private dashboard
// ---------------------------------------------------------------------------

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  pending: { label: "Waiting for first service", tone: "bg-amber-50 text-amber-800" },
  qualified: { label: "Reward on the way", tone: "bg-blue-50 text-blue-800" },
  rewarded: { label: "Reward issued", tone: "bg-emerald-50 text-emerald-800" },
  declined: { label: "Not eligible", tone: "bg-gray-100 text-gray-600" },
};

function CopyField({ label, value, testId, mono }: { label: string; value: string; testId: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the value stays selectable */ }
  };
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className={cn("min-w-0 flex-1 truncate rounded-lg border bg-gray-50 px-3 py-2.5 text-gray-900", mono ? "text-lg font-bold tracking-wider" : "text-sm")} data-testid={testId}>
          {value}
        </code>
        <Button type="button" variant="outline" className="h-auto shrink-0" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
          <span className="ml-1.5 hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}

export function PortalReferralDashboard() {
  const { token } = useParams<{ token: string }>();
  const { data, isLoading, error } = useQuery<Dashboard>({ queryKey: [`/api/portal/referrals/r/${token}`], retry: false });
  const back = { href: "/portal/referrals", label: "Refer a Friend" };

  if (isLoading) return <PortalFrame back={back}><p className="text-sm text-gray-500">Loading your referrals…</p></PortalFrame>;
  if (error || !data) {
    return (
      <PortalFrame back={back}>
        <div className="rounded-xl border bg-white p-6 text-center" data-testid="referral-dashboard-invalid">
          <h1 className="text-lg font-semibold text-gray-900">This link is no longer valid</h1>
          <p className="mt-1 text-sm text-gray-600">Links are replaced whenever a new one is requested. Enter your email to get a fresh link.</p>
          <Button asChild className="mt-4 bg-red-600 hover:bg-red-700"><Link href="/portal/referrals">Get a new link</Link></Button>
        </div>
      </PortalFrame>
    );
  }

  const { referrer, program, summary, referrals } = data;
  const message = `I use Computer Systems Depot for computer help — they're great. Get ${program.friendReward} with my link: ${referrer.shareUrl}`;
  const encoded = encodeURIComponent(message);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const shareTargets = [
    { id: "sms", label: "Text", icon: MessageSquare, href: `sms:?&body=${encoded}` },
    { id: "email", label: "Email", icon: Mail, href: `mailto:?subject=${encodeURIComponent("Computer help I recommend")}&body=${encoded}` },
    { id: "whatsapp", label: "WhatsApp", icon: Send, href: `https://wa.me/?text=${encoded}` },
    { id: "facebook", label: "Facebook", icon: Users, href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(referrer.shareUrl)}` },
  ];
  const stats = [
    { label: "Friends referred", value: summary.total },
    { label: "In progress", value: summary.pending + summary.qualified },
    { label: "Rewards earned", value: summary.rewarded },
  ];

  return (
    <PortalFrame back={back}>
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-600">Your referral dashboard</p>
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl" data-testid="referral-dashboard-title">Hi {referrer.firstName}!</h1>
        <p className="text-sm text-gray-600">Friends get {program.friendReward}. You get {program.referrerReward} after their first service is completed.</p>
      </header>

      {(referrer.status === "paused" || !program.active) && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          {program.active ? "Your referral code is paused. Call us if you think this is a mistake." : "The referral program is paused right now, so new referrals aren't being credited."}
        </p>
      )}

      <section className="grid gap-4 rounded-xl border bg-white p-5 sm:p-6 md:grid-cols-2">
        <CopyField label="Your code" value={referrer.code} testId="referral-code" mono />
        <CopyField label="Your share link" value={referrer.shareUrl} testId="referral-share-url" />
        <div className="space-y-2 md:col-span-2">
          <p className="text-xs font-medium text-gray-500">Share it</p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {canNativeShare && (
              <Button
                type="button"
                className="bg-red-600 hover:bg-red-700"
                onClick={() => { void navigator.share({ title: "Computer Systems Depot", text: message, url: referrer.shareUrl }).catch(() => {}); }}
              >
                <Share2 className="mr-2 h-4 w-4" />Share…
              </Button>
            )}
            {shareTargets.map((target) => {
              const Icon = target.icon;
              return (
                <Button key={target.id} asChild variant="outline">
                  <a href={target.href} target={target.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" data-testid={`share-${target.id}`}>
                    <Icon className="mr-2 h-4 w-4" />{target.label}
                  </a>
                </Button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-3 gap-2 sm:gap-3" aria-label="Referral summary">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border bg-white p-3 text-center sm:p-4">
            <p className="text-2xl font-bold tabular-nums text-gray-900">{stat.value}</p>
            <p className="text-xs text-gray-600">{stat.label}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border bg-white" data-testid="referral-list">
        <h2 className="border-b px-5 py-3 font-semibold text-gray-900">Your referrals</h2>
        {referrals.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <PartyPopper className="h-8 w-8 text-gray-300" />
            <p className="text-sm text-gray-600">No referrals yet — share your link to get started.</p>
          </div>
        ) : (
          <ul className="divide-y">
            {referrals.map((referral, i) => {
              const status = STATUS_COPY[referral.status] ?? STATUS_COPY.pending;
              return (
                <li key={`${referral.friendName}-${i}`} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{referral.friendName}</p>
                    <p className="text-xs text-gray-500">Referred {format(new Date(referral.createdAt), "MMM d, yyyy")}</p>
                  </div>
                  <span className={cn("inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium", status.tone)}>
                    {referral.status === "rewarded" && <CheckCircle2 className="h-3.5 w-3.5" />}
                    {status.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Terms terms={program.terms} />
    </PortalFrame>
  );
}
