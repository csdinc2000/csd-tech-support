import { useEffect, useRef } from "react";
import { useParams } from "wouter";
import { Check, ChevronRight, CreditCard, Download, ExternalLink, LockKeyhole, ShieldCheck } from "lucide-react";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";
import { usePublicInvoice, usePublicStripeCheckout } from "@/hooks/use-invoices";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

const dateLabel = (date?: string | null) =>
  date
    ? new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "Upon receipt";

export default function PublicInvoice() {
  const { token } = useParams<{ token: string }>();
  const invoice = usePublicInvoice(token);
  const stripe = usePublicStripeCheckout();
  const recordedView = useRef<string | null>(null);

  useEffect(() => {
    if (!token || !invoice.data || invoice.error || recordedView.current === token) return;
    // A rendered customer page, not a prefetch GET, is evidence of a view.
    recordedView.current = token;
    void fetch(`/api/public/invoices/${encodeURIComponent(token)}/view`, {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => {
      // View tracking is best-effort and must never block payment.
    });
  }, [token, invoice.data, invoice.error]);

  if (invoice.isLoading) {
    return (
      <main className="min-h-[100dvh] bg-[#f3f5f7] px-4 py-10" aria-busy="true">
        <div className="mx-auto max-w-[1080px] animate-pulse">
          <div className="mb-12 h-12 w-48 rounded bg-[#dce2e8]" />
          <div className="grid gap-6 md:grid-cols-[1fr_320px]">
            <div className="h-[620px] rounded-2xl bg-[#e2e7eb]" />
            <div className="h-[360px] rounded-2xl bg-[#e2e7eb]" />
          </div>
        </div>
      </main>
    );
  }

  if (invoice.error || !invoice.data) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-[#f3f5f7] p-5">
        <div className="w-full max-w-md rounded-2xl border border-[#dce2e8] bg-[#fffefd] p-8 shadow-sm">
          <img src={csdLogo} alt="Computer Systems Depot" className="h-12 w-auto object-contain object-left" />
          <div className="mt-10 h-1 w-12 bg-[#b51f32]" />
          <h1 className="mt-5 text-3xl font-semibold tracking-tight text-[#14253a]">Invoice unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-[#59697a]">
            This link may be incomplete or no longer active. Please check the link in your email or contact your CSD representative.
          </p>
          <button
            type="button"
            onClick={() => invoice.refetch()}
            className="mt-7 rounded-lg bg-[#14253a] px-5 py-3 text-sm font-semibold text-white hover:bg-[#243d5b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b51f32]"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  const inv = invoice.data;
  const brand = inv.branding;
  const businessName = brand?.businessName || "Computer Systems Depot";
  const accent = brand?.accentColor === "navy" ? "#14253a" : "#b51f32";
  const paid = inv.status === "paid";
  const payable = inv.status === "sent";

  return (
    <main className="min-h-[100dvh] bg-[#f3f5f7] text-[#14253a]" style={{ "--invoice-accent": accent } as React.CSSProperties}>
      <div className="h-1 bg-[var(--invoice-accent)]" />
      <div className="mx-auto max-w-[1120px] px-4 pb-14 pt-7 sm:px-8 sm:pt-10">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#dce2e8] pb-7">
          <img src={csdLogo} alt="Computer Systems Depot" className="h-12 w-auto max-w-[230px] object-contain object-left" />
          <div className="flex items-center gap-2 text-xs font-medium text-[#59697a]">
            <ShieldCheck className="h-4 w-4 text-[var(--invoice-accent)]" aria-hidden="true" />
            A secure CSD invoice
          </div>
        </header>

        <div className="mb-8 mt-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p data-testid="text-invoice-business-name" className="text-[11px] font-bold uppercase tracking-[.18em] text-[var(--invoice-accent)]">{businessName} / Billing</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Invoice {inv.invoiceNumber}</h1>
            <p className="mt-2 text-sm text-[#59697a]">Prepared for {inv.client.name}</p>
          </div>
          <span className={`inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${
            paid ? "bg-[#e8f3ef] text-[#206855]" : payable ? "bg-[#fff1e7] text-[#95502c]" : "bg-[#e9edf1] text-[#526276]"
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${paid ? "bg-[#206855]" : payable ? "bg-[#d37b3c]" : "bg-[#526276]"}`} />
            {paid ? "Paid" : payable ? "Awaiting payment" : inv.status}
          </span>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <article className="overflow-hidden rounded-2xl border border-[#dce2e8] bg-[#fffefd] shadow-[0_8px_32px_rgba(20,37,58,.04)]">
            <div className="grid gap-6 border-b border-[#e4e8ec] px-5 py-7 sm:grid-cols-2 sm:px-8">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#738092]">Bill to</p>
                <p className="mt-2 text-base font-semibold">{inv.client.name}</p>
                {inv.jobNumber && <p className="mt-1 text-sm text-[#59697a]">Service order {inv.jobNumber}</p>}
              </div>
              <div className="grid grid-cols-2 gap-4 sm:justify-self-end sm:text-right">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#738092]">Invoice</p>
                  <p className="mt-2 text-sm font-semibold">{inv.invoiceNumber}</p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#738092]">Due date</p>
                  <p className="mt-2 text-sm font-semibold">{dateLabel(inv.dueDate)}</p>
                </div>
              </div>
            </div>

            <div className="px-5 py-7 sm:px-8">
              <h2 className="text-lg font-semibold tracking-tight">Services &amp; charges</h2>
              <div className="mt-5 border-t border-[#e4e8ec]">
                {inv.lineItems.map((line, index) => (
                  <div key={index} className="flex items-start justify-between gap-4 border-b border-[#edf0f2] py-4">
                    <div>
                      <p className="text-sm font-medium leading-6">{line.description}</p>
                      <p className="mt-0.5 text-xs text-[#738092]">
                        {line.quantity} × {money(line.unitAmountCents)}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{money(line.amountCents)}</span>
                  </div>
                ))}
              </div>
              <div className="ml-auto mt-6 max-w-xs space-y-3 text-sm">
                <div className="flex justify-between text-[#59697a]">
                  <span>Subtotal</span><span className="tabular-nums">{money(inv.subtotalCents)}</span>
                </div>
                <div className="flex justify-between text-[#59697a]">
                  <span>Tax {inv.taxRateBps ? `(${(inv.taxRateBps / 100).toFixed(2)}%)` : ""}</span>
                  <span className="tabular-nums">{money(inv.taxCents)}</span>
                </div>
                {inv.discountCents > 0 && (
                  <div className="flex justify-between text-[#59697a]">
                    <span>Discount</span><span className="tabular-nums">−{money(inv.discountCents)}</span>
                  </div>
                )}
                <div className="flex items-baseline justify-between border-t border-[#dce2e8] pt-5 text-[#14253a]">
                  <span className="font-semibold">Total</span>
                  <span className="text-2xl font-bold tracking-tight tabular-nums">{money(inv.totalCents)}</span>
                </div>
              </div>
              {inv.notes && (
                 <div className="mt-8 border-l-2 border-[var(--invoice-accent)] bg-[#f6f7f8] px-5 py-4">
                  <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#738092]">A note from CSD</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#46576a]">{inv.notes}</p>
                </div>
              )}
            </div>
          </article>

          <aside className="lg:sticky lg:top-8">
            <div className="overflow-hidden rounded-2xl border border-[#dce2e8] bg-[#fffefd] shadow-[0_8px_32px_rgba(20,37,58,.05)]">
              <div className="border-b border-[#e4e8ec] px-6 py-6">
                <p className="text-[11px] font-bold uppercase tracking-[.17em] text-[#738092]">
                  {paid ? "Amount paid" : "Amount due"}
                </p>
                <p className="mt-2 text-[2.6rem] font-bold leading-none tracking-tight tabular-nums">{money(inv.totalCents)}</p>
                <p className="mt-3 text-xs text-[#59697a]">Due {dateLabel(inv.dueDate)}</p>
              </div>
              <div className="p-6">
                {paid ? (
                  <div className="flex gap-3 rounded-xl bg-[#e8f3ef] p-4 text-[#206855]">
                    <Check className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-semibold">Payment received</p>
                      <p className="mt-1 text-xs leading-5">This invoice has been marked paid. Thank you.</p>
                    </div>
                  </div>
                ) : payable ? (
                  <div className="space-y-3">
                    <p className="mb-4 text-sm leading-6 text-[#59697a]">
                      Review the charges, then continue to Stripe to pay securely.
                    </p>
                    <button
                      type="button"
                      disabled={stripe.isPending}
                      onClick={() => stripe.mutate(token, { onSuccess: (url) => window.location.assign(url) })}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--invoice-accent)] px-4 py-3.5 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invoice-accent)] disabled:opacity-60"
                      data-testid="button-pay-stripe"
                    >
                      <CreditCard className="h-4 w-4" aria-hidden="true" />
                      {stripe.isPending ? "Opening secure checkout…" : "Pay securely with Stripe"}
                      {!stripe.isPending && <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                    </button>
                    {stripe.error && (
                      <p role="alert" className="text-xs font-medium text-[#a31e31]">
                        We couldn't open Stripe checkout. Please try again.
                      </p>
                    )}
                    {inv.stripeInvoicePdfUrl && (
                      <a
                        href={inv.stripeInvoicePdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#cbd4dc] px-4 py-3 text-sm font-semibold text-[#14253a] hover:bg-[#f3f5f7]"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" /> View invoice PDF
                      </a>
                    )}
                    {inv.paypalCheckoutUrl && (
                      <div className="mt-5 border-t border-[#e4e8ec] pt-5">
                        <p className="text-xs font-semibold text-[#46576a]">Other payment option</p>
                        <a
                          href={inv.paypalCheckoutUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-[#cbd4dc] px-4 py-3 text-sm font-semibold text-[#14253a] hover:bg-[#f3f5f7]"
                        >
                          Open external PayPal link <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        </a>
                        <p className="mt-2 text-xs leading-5 text-[#738092]">
                          PayPal payments are external and manually reconciled by CSD. This page may not update automatically.
                        </p>
                      </div>
                    )}
                    <p className="flex items-start gap-2 pt-3 text-xs leading-5 text-[#738092]">
                      <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      Stripe processes secure payments. CSD does not collect card details on this page.
                    </p>
                  </div>
                ) : (
                  <p className="rounded-lg bg-[#f4e9eb] p-4 text-sm text-[#8f2638]">
                    This invoice is not currently available for payment. Please contact CSD with questions.
                  </p>
                )}
              </div>
            </div>
            <div className="mt-5 px-2 text-center text-xs leading-5 text-[#738092]">
              <p>Questions about this invoice? Contact {businessName}.</p>
              {brand?.contactEmail && <a data-testid="link-invoice-contact-email" className="mt-2 block break-all font-medium text-[#14253a] underline underline-offset-2" href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a>}
              {brand?.contactPhone && <a data-testid="link-invoice-contact-phone" className="mt-1 block font-medium text-[#14253a] underline underline-offset-2" href={`tel:${brand.contactPhone.replace(/[^\d+]/g, "")}`}>{brand.contactPhone}</a>}
            </div>
          </aside>
        </div>
        {brand?.footer && <footer data-testid="text-invoice-footer" className="mt-9 whitespace-pre-wrap border-t border-[#dce2e8] pt-6 text-center text-sm leading-6 text-[#59697a]">{brand.footer}</footer>}
      </div>
    </main>
  );
}