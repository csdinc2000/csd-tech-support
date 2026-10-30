import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";
export type InvoiceLineItem = { id?: number; description: string; quantity: number; unit_amount_cents?: number; unitAmountCents?: number; amount_cents?: number; amountCents?: number };
export type Invoice = {
  id: number; invoice_number: string; status: InvoiceStatus; contact_id: number; job_id?: number | null;
  client_name: string; client_email?: string | null; client_address?: string | null; job_number?: string | null;
  due_date?: string | null; notes?: string | null; paypal_checkout_url?: string | null; subtotal_cents: number;
  tax_rate_bps: number; tax_cents: number; discount_cents: number; total_cents: number; publicUrl?: string;
  sent_at?: string | null; paid_at?: string | null; created_at?: string; line_item_count?: number;
};
export type InvoiceDetail = Invoice & { lineItems: InvoiceLineItem[]; payments: { provider: string; provider_payment_id?: string; amount_cents: number; verified: boolean; paid_at: string }[]; audit: { id: number; action: string; actor: string; created_at: string }[] };
export type InvoiceInput = { contactId: number; jobId?: number | null; dueDate?: string | null; notes?: string | null; paypalCheckoutUrl?: string | null; taxRateBps: number; discountCents: number; lineItems: { description: string; quantity: number; unitAmountCents: number }[] };
export type PublicInvoice = { invoiceNumber: string; status: InvoiceStatus; currency: string; client: { name: string }; jobNumber?: string | null; dueDate?: string | null; notes?: string | null; lineItems: { description: string; quantity: number; unitAmountCents: number; amountCents: number }[]; subtotalCents: number; taxRateBps: number; taxCents: number; discountCents: number; totalCents: number; paypalCheckoutUrl?: string | null; sentAt?: string; paidAt?: string; payments: { provider: string; amountCents: number; verified: boolean; paidAt: string }[] };

const json = async <T>(method: string, url: string, body?: unknown) => (await apiRequest(method, url, body)).json() as Promise<T>;
export const useInvoices = () => useQuery<Invoice[]>({ queryKey: ["/api/invoices"] });
export const useInvoice = (id?: string) => useQuery<InvoiceDetail>({ queryKey: ["/api/invoices", id], enabled: !!id });
export const usePublicInvoice = (token?: string) => useQuery<PublicInvoice>({ queryKey: ["/api/public/invoices", token], enabled: !!token, refetchOnMount: "always" });

function useInvoiceMutation<T>(action: (variables: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: action, onSuccess: () => client.invalidateQueries({ queryKey: ["/api/invoices"] }) });
}
export const useCreateInvoice = () => useInvoiceMutation<InvoiceInput>((input) => json("POST", "/api/invoices", input));
export const useUpdateInvoice = () => useInvoiceMutation<{ id: number; input: InvoiceInput }>(({ id, input }) => json("PUT", `/api/invoices/${id}`, input));
export const useDeleteInvoice = () => useInvoiceMutation<number>(async (id) => { await apiRequest("DELETE", `/api/invoices/${id}`); });
export const useSendInvoice = () => useInvoiceMutation<number>((id) => json("POST", `/api/invoices/${id}/send`));
export const useVoidInvoice = () => useInvoiceMutation<number>((id) => json("POST", `/api/invoices/${id}/void`));
export const useManualMarkPaid = () => useInvoiceMutation<{ id: number; provider: "manual" | "paypal"; reference: string }>(({ id, ...body }) => json("POST", `/api/invoices/${id}/manual-mark-paid`, body));
export const useStripeCheckout = () => useInvoiceMutation<number>((id) => json<{ url: string }>("POST", `/api/invoices/${id}/create-stripe-checkout`).then((r) => r.url));
export const usePublicStripeCheckout = () => useMutation({ mutationFn: (token: string) => json<{ url: string }>("POST", `/api/public/invoices/${token}/create-stripe-checkout`).then((r) => r.url) });