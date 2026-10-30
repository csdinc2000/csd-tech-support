import { useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Check,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Sparkles,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Price {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval?: string; interval_count?: number } | null;
}

interface Plan {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prices: Price[];
}

interface PlansResponse {
  configured: boolean;
  plans: Plan[];
}

interface SubscriptionResponse {
  configured: boolean;
  subscription: null | {
    id: string;
    status: string;
    currentPeriodEnd: number | null;
    cancelAtPeriodEnd: boolean;
    priceId: string;
    unitAmount: number | null;
    currency: string;
    recurring: { interval?: string } | null;
    product: { id: string; name: string; description: string | null } | null;
  };
}

interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amount: number | null;
  currency: string;
  created: number;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

interface InvoicesResponse {
  configured: boolean;
  invoices: Invoice[];
}

function formatMoney(amount: number | null | undefined, currency: string = "usd") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function formatDate(unixSeconds: number | null | undefined) {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function featuresFromMetadata(meta: Record<string, string>): string[] {
  if (!meta) return [];
  if (typeof meta.features === "string") {
    return meta.features
      .split("|")
      .map((f) => f.trim())
      .filter(Boolean);
  }
  return Object.keys(meta)
    .filter((k) => /^feature_?\d+$/i.test(k))
    .sort()
    .map((k) => meta[k])
    .filter(Boolean);
}

export default function BillingPage() {
  const { toast } = useToast();
  const [location, setLocation] = useLocation();

  const plansQuery = useQuery<PlansResponse>({
    queryKey: ["/api/billing/plans"],
  });
  const subscriptionQuery = useQuery<SubscriptionResponse>({
    queryKey: ["/api/billing/subscription"],
  });
  const invoicesQuery = useQuery<InvoicesResponse>({
    queryKey: ["/api/billing/invoices"],
  });

  const checkoutMutation = useMutation({
    mutationFn: async (priceId: string) => {
      const res = await apiRequest("POST", "/api/billing/checkout", { priceId });
      return (await res.json()) as { url: string };
    },
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (err: any) => {
      toast({
        title: "Could not start checkout",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/billing/portal", {});
      return (await res.json()) as { url: string };
    },
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (err: any) => {
      toast({
        title: "Could not open billing portal",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  // Handle return from checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("checkout");
    if (result === "success") {
      toast({ title: "Subscription updated", description: "Thanks! Your plan is being activated." });
      queryClient.invalidateQueries({ queryKey: ["/api/billing/subscription"] });
      queryClient.invalidateQueries({ queryKey: ["/api/billing/invoices"] });
      setLocation("/billing", { replace: true });
    } else if (result === "cancelled") {
      toast({ title: "Checkout cancelled", description: "No changes were made to your plan." });
      setLocation("/billing", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sub = subscriptionQuery.data?.subscription ?? null;
  const configured =
    plansQuery.data?.configured ?? subscriptionQuery.data?.configured ?? true;

  const plans = plansQuery.data?.plans ?? [];
  const currentPlanId = sub?.product?.id ?? null;

  const sortedPlans = useMemo(() => {
    return [...plans].sort((a, b) => {
      const aMin = Math.min(...(a.prices.map((p) => p.unit_amount ?? Infinity).concat(Infinity)));
      const bMin = Math.min(...(b.prices.map((p) => p.unit_amount ?? Infinity).concat(Infinity)));
      return aMin - bMin;
    });
  }, [plans]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-4">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center space-y-4 lg:space-y-0">
          <div>
            <h2
              className="text-xl md:text-2xl font-bold text-gray-900"
              data-testid="page-title"
            >
              Billing & Plans
            </h2>
            <p className="text-sm md:text-base text-gray-600">
              Manage your subscription, view invoices, and change plans.
            </p>
          </div>
          <Button
            variant="outline"
            data-testid="button-manage-payment"
            disabled={!configured || portalMutation.isPending}
            onClick={() => portalMutation.mutate()}
          >
            <CreditCard className="h-4 w-4 mr-2" />
            {portalMutation.isPending ? "Opening…" : "Manage Payment Method"}
          </Button>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-6">
        {!configured && (
          <Card data-testid="card-stripe-not-configured">
            <CardContent className="py-6">
              <p className="text-sm text-gray-700">
                Billing is not yet configured. Connect Stripe in your project
                integrations to enable plans, checkout, and invoices.
              </p>
            </CardContent>
          </Card>
        )}

        <Card data-testid="card-current-plan">
          <CardHeader>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
              <div>
                <CardTitle className="text-lg font-semibold flex items-center gap-2">
                  Current Plan
                  {subscriptionQuery.isLoading ? (
                    <Skeleton className="h-5 w-20" />
                  ) : (
                    <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">
                      {sub?.product?.name ?? "No active plan"}
                    </Badge>
                  )}
                  {sub?.status && sub.status !== "active" && (
                    <Badge variant="outline" className="capitalize">
                      {sub.status.replace("_", " ")}
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-sm text-gray-600 mt-1">
                  {sub?.product?.description ??
                    (configured
                      ? "You don't have an active subscription yet. Pick a plan below to get started."
                      : "Connect Stripe to start tracking subscriptions.")}
                </p>
              </div>
              <div className="text-right">
                {subscriptionQuery.isLoading ? (
                  <Skeleton className="h-8 w-24 ml-auto" />
                ) : sub ? (
                  <div className="text-2xl font-bold text-gray-900">
                    {formatMoney(sub.unitAmount, sub.currency)}
                    <span className="text-sm font-normal text-gray-500">
                      {sub.recurring?.interval ? `/${sub.recurring.interval}` : ""}
                    </span>
                  </div>
                ) : (
                  <div className="text-2xl font-bold text-gray-400">—</div>
                )}
                <div className="text-xs text-gray-500 mt-1">
                  {sub?.cancelAtPeriodEnd
                    ? `Cancels on ${formatDate(sub.currentPeriodEnd)}`
                    : `Next invoice: ${formatDate(sub?.currentPeriodEnd)}`}
                </div>
              </div>
            </div>
          </CardHeader>
        </Card>

        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Available Plans
            </h3>
          </div>

          {plansQuery.isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-72 w-full" />
              ))}
            </div>
          ) : sortedPlans.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-gray-500">
                <p className="font-medium">No plans available yet</p>
                <p className="text-sm">
                  {configured
                    ? "Create products and prices in your Stripe dashboard to make plans appear here."
                    : "Connect Stripe to load your plans."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {sortedPlans.map((plan, idx) => {
                const isCurrent = currentPlanId === plan.id;
                const highlighted =
                  plan.metadata?.highlighted === "true" ||
                  (sortedPlans.length >= 2 && idx === 1 && !sortedPlans.some((p) => p.metadata?.highlighted === "true"));
                const features = featuresFromMetadata(plan.metadata);
                const primaryPrice = plan.prices[0] ?? null;
                return (
                  <Card
                    key={plan.id}
                    className={
                      highlighted
                        ? "border-blue-500 shadow-md relative"
                        : "relative"
                    }
                    data-testid={`card-plan-${plan.name.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    {highlighted && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <Badge className="bg-blue-600 text-white hover:bg-blue-600">
                          <Sparkles className="h-3 w-3 mr-1" />
                          Most Popular
                        </Badge>
                      </div>
                    )}
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span>{plan.name}</span>
                        {isCurrent && <Badge variant="secondary">Current</Badge>}
                      </CardTitle>
                      <div className="mt-2">
                        <span className="text-3xl font-bold text-gray-900">
                          {formatMoney(primaryPrice?.unit_amount ?? null, primaryPrice?.currency ?? "usd")}
                        </span>
                        <span className="text-sm text-gray-500">
                          {primaryPrice?.recurring?.interval
                            ? `/${primaryPrice.recurring.interval}`
                            : ""}
                        </span>
                      </div>
                      {plan.description && (
                        <p className="text-sm text-gray-600 mt-2">
                          {plan.description}
                        </p>
                      )}
                    </CardHeader>
                    <CardContent>
                      {features.length > 0 && (
                        <ul className="space-y-2 mb-6">
                          {features.map((f) => (
                            <li
                              key={f}
                              className="flex items-start text-sm text-gray-700"
                            >
                              <Check className="h-4 w-4 text-green-500 mr-2 mt-0.5 shrink-0" />
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <Button
                        className="w-full"
                        variant={isCurrent ? "outline" : "default"}
                        disabled={
                          isCurrent ||
                          !primaryPrice ||
                          checkoutMutation.isPending
                        }
                        onClick={() => {
                          if (!primaryPrice) return;
                          if (isCurrent) {
                            portalMutation.mutate();
                          } else {
                            checkoutMutation.mutate(primaryPrice.id);
                          }
                        }}
                        data-testid={`button-select-${plan.name.toLowerCase().replace(/\s+/g, "-")}`}
                      >
                        {isCurrent
                          ? "Current Plan"
                          : checkoutMutation.isPending
                            ? "Redirecting…"
                            : `Switch to ${plan.name}`}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        <Card data-testid="card-invoices">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            {invoicesQuery.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : (invoicesQuery.data?.invoices?.length ?? 0) === 0 ? (
              <div className="text-center py-10 text-gray-500">
                <FileText className="h-12 w-12 mx-auto mb-2 opacity-40" />
                <p className="font-medium">No invoices yet</p>
                <p className="text-sm">
                  Your billing history will appear here once you have invoices.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {invoicesQuery.data!.invoices.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between py-3"
                    data-testid={`row-invoice-${inv.id}`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-sm text-gray-900 truncate">
                        {inv.number ?? inv.id}
                      </div>
                      <div className="text-xs text-gray-500">
                        {formatDate(inv.created)} ·{" "}
                        <span className="capitalize">{inv.status ?? "—"}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-sm font-medium text-gray-900">
                        {formatMoney(inv.amount, inv.currency)}
                      </div>
                      {inv.hostedUrl && (
                        <a
                          href={inv.hostedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-700"
                          data-testid={`link-invoice-view-${inv.id}`}
                          aria-label="View invoice"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                      {inv.pdfUrl && (
                        <a
                          href={inv.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-700"
                          data-testid={`link-invoice-pdf-${inv.id}`}
                          aria-label="Download invoice PDF"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
