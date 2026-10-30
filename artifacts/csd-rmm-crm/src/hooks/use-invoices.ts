import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";
export type InvoiceLineItem = { id?: number; description: string; quantity: number; unit_amount_cents?: number; unitAmountCents?: number; amount_cents?: number; amountCents?: number };
export type Invoice = {
  id: number; invoice_number: string; status: InvoiceStatus; contact_id: number; client_id?: number | null; job_id?: number | null;
  client_name: string; client_email?: string | null; client_address?: string | null; job_number?: string | null;
  due_date?: string | null; notes?: string | null; paypal_checkout_url?: string | null; subtotal_cents: number;
  tax_rate_bps: number; tax_cents: number; discount_cents: number; total_cents: number; publicUrl?: string;
  stripe_invoice_id?: string | null; stripe_hosted_invoice_url?: string | null; stripe_invoice_pdf_url?: string | null;
  external_payment_pending?: boolean; external_payment_provider?: "manual" | "paypal" | null; external_payment_reference?: string | null;
  sent_at?: string | null; paid_at?: string | null; created_at?: string; line_item_count?: number;
};
export type InvoiceEmailDelivery = {
  id: number; kind: "invoice" | "resend" | "reminder"; recipient_email: string;
  status: "pending" | "processing" | "accepted" | "failed" | "cancelled";
  scheduled_at: string; attempt_count: number; accepted_at?: string | null;
  last_error?: string | null; created_at: string;
};
export type StripeDocumentIncident = {
  id: number;
  documentKind: "hosted_invoice" | "invoice_pdf";
  failureCategory: "permanent" | "exhausted";
  attempts: number;
  resolutionStatus: "active" | "resolved";
  lastSeenAt: string;
  resolvedAt: string | null;
};
export type InvoiceDetail = Invoice & {
  lineItems: InvoiceLineItem[];
  payments: { provider: string; provider_payment_id?: string; amount_cents: number; verified: boolean; paid_at: string }[];
  audit: { id: number; action: string; actor: string; created_at: string; details?: Record<string, unknown> | null }[];
  stripeDocumentIncidents: StripeDocumentIncident[];
  emailDeliveries: InvoiceEmailDelivery[];
  emailAttempts: { id: number; outbox_id: number; attempt_number: number; status: string; error?: string | null; started_at: string; completed_at?: string | null }[];
};
export type InvoiceRecipient =
  | { kind: "contact"; contactId: number }
  | { kind: "client"; clientId: number }
  | { kind: "new"; name: string; email?: string | null; phone?: string | null; company?: string | null };
export type BillingPartyJob = { id: number; jobNumber: string; serviceType: string; description: string | null; estimatedAmountCents: number | null };
export type BillingParty = {
  key: string; kind: "contact" | "client"; contactId: number | null; clientId: number | null;
  name: string; org: string | null; email: string | null; phone: string | null;
  invoiceCount: number; lastInvoiceAt: string | null; openBalanceCents: number;
  openJobCount: number; openRequestCount: number; openJobs: BillingPartyJob[];
};
export type ServicePreset = { description: string; unitAmountCents: number; uses: number };
export type InvoiceInput = { originInquiryId?: string; correctionOfInvoiceId?: number; contactId?: number; recipient?: InvoiceRecipient; jobId?: number | null; dueDate?: string | null; notes?: string | null; paypalCheckoutUrl?: string | null; taxRateBps: number; discountCents: number; lineItems: { description: string; quantity: number; unitAmountCents: number }[] };
export type InvoiceTemplateInput = {
  label: string;
  lineItems: { description: string; quantity: number; unitAmountCents: number }[];
  dueDays: number;
  terms: string;
  taxRateBps: number;
  discountCents: number;
  notes: string | null;
};
export type InvoiceTemplate = InvoiceTemplateInput & { id: number; createdAt: string };
export type InvoiceSettings = { businessName: string; accentColor: "red" | "navy"; contactEmail: string; contactPhone: string; footer: string; defaultDueDays: number; defaultTaxRateBps: number; defaultNotes: string };
export type PublicInvoice = { invoiceNumber: string; status: InvoiceStatus; currency: string; branding?: InvoiceSettings | null; client: { name: string }; jobNumber?: string | null; dueDate?: string | null; notes?: string | null; lineItems: { description: string; quantity: number; unitAmountCents: number; amountCents: number }[]; subtotalCents: number; taxRateBps: number; taxCents: number; discountCents: number; totalCents: number; paypalCheckoutUrl?: string | null; stripeHostedInvoiceUrl?: string | null; stripeInvoicePdfUrl?: string | null; sentAt?: string; paidAt?: string; payments: { provider: string; amountCents: number; verified: boolean; paidAt: string }[] };

const json = async <T>(method: string, url: string, body?: unknown) => (await apiRequest(method, url, body)).json() as Promise<T>;
export const useInvoices = () => useQuery<Invoice[]>({ queryKey: ["/api/invoices"] });
/** Everyone billable — client accounts, CRM contacts, and whoever has work open. */
export const useBillingParties = () => useQuery<BillingParty[]>({
  queryKey: ["/api/invoices/billing-parties"],
  staleTime: 30_000,
  refetchOnMount: "always",
});
export const useServicePresets = () => useQuery<ServicePreset[]>({ queryKey: ["/api/invoices/service-presets"] });
export const useInvoiceTemplates = () => useQuery<InvoiceTemplate[]>({ queryKey: ["/api/invoices/templates"] });
export const useInvoiceSettings = () => useQuery<InvoiceSettings>({ queryKey: ["/api/invoices/settings"] });
export const useUpdateInvoiceSettings = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: InvoiceSettings) => json<InvoiceSettings>("PUT", "/api/invoices/settings", input),
    onSuccess: (settings) => {
      client.setQueryData(["/api/invoices/settings"], settings);
      client.invalidateQueries({ queryKey: ["/api/public/invoices"] });
    },
  });
};
export const useInvoice = (id?: string) => useQuery<InvoiceDetail>({ queryKey: ["/api/invoices", id], enabled: !!id });
export const usePublicInvoice = (token?: string) => useQuery<PublicInvoice>({ queryKey: ["/api/public/invoices", token], enabled: !!token, refetchOnMount: "always" });

function useInvoiceMutation<T>(action: (variables: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: action,
    // A failed response can still follow a committed invoice. Reconcile the
    // queue on both outcomes rather than leaving a stale "Create" action.
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["/api/catalog/inquiries"] });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["/api/invoices"] });
      // An invoice can mint a contact or an account, so the picker and the
      // service presets both go stale the moment one is saved.
      client.invalidateQueries({ queryKey: ["/api/invoices/billing-parties"] });
      client.invalidateQueries({ queryKey: ["/api/invoices/service-presets"] });
      client.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      client.invalidateQueries({ queryKey: ["/api/clients"] });
    },
  });
}
export const useCreateInvoice = () => useInvoiceMutation<InvoiceInput>((input) => json("POST", "/api/invoices", input));
export const useCreateInvoiceTemplate = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: InvoiceTemplateInput) => json<InvoiceTemplate>("POST", "/api/invoices/templates", input),
    onSuccess: () => client.invalidateQueries({ queryKey: ["/api/invoices/templates"] }),
  });
};
export const useDeleteInvoiceTemplate = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/invoices/templates/${id}`); },
    onSuccess: () => client.invalidateQueries({ queryKey: ["/api/invoices/templates"] }),
  });
};
export const useUpdateInvoice = () => useInvoiceMutation<{ id: number; input: InvoiceInput }>(({ id, input }) => json("PUT", `/api/invoices/${id}`, input));
export const useDeleteInvoice = () => useInvoiceMutation<number>(async (id) => { await apiRequest("DELETE", `/api/invoices/${id}`); });
export const useSendInvoice = () => useInvoiceMutation<number>((id) => json("POST", `/api/invoices/${id}/send`));
export const useResendInvoiceEmail = () => useInvoiceMutation<{ id: number; requestKey: string }>(({ id, requestKey }) => json("POST", `/api/invoices/${id}/resend-email`, { requestKey }));
export const useScheduleInvoiceReminders = () => useInvoiceMutation<{ id: number; daysAfterDue: number[] }>(({ id, daysAfterDue }) => json("POST", `/api/invoices/${id}/reminders`, { daysAfterDue }));
export const useRetryInvoiceEmail = () => useInvoiceMutation<{ id: number; deliveryId: number }>(({ id, deliveryId }) => json("POST", `/api/invoices/${id}/email-deliveries/${deliveryId}/retry`));
export const useVoidInvoice = () => useInvoiceMutation<number>((id) => json("POST", `/api/invoices/${id}/void`));
export const useManualMarkPaid = () => useInvoiceMutation<{ id: number; provider: "manual" | "paypal"; reference: string }>(({ id, ...body }) => json("POST", `/api/invoices/${id}/manual-mark-paid`, body));
export const useStripeCheckout = () => useInvoiceMutation<number>((id) => json<{ url: string }>("POST", `/api/invoices/${id}/create-stripe-checkout`).then((r) => r.url));
export const usePublicStripeCheckout = () => useMutation({ mutationFn: (token: string) => json<{ url: string }>("POST", `/api/public/invoices/${token}/create-stripe-checkout`).then((r) => r.url) });