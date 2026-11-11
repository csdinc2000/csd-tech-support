import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type CatalogItem = {
  id: string;
  name: string;
  description: string;
  kind: "product" | "service";
  unitAmountCents: number;
  priceId: string | null;
  published: boolean;
  active: boolean;
};
export type CatalogInput = Pick<CatalogItem, "name" | "description" | "kind" | "unitAmountCents" | "published">;
const staffKey = ["/api/catalog/items"];
const publicKey = ["/api/portal/catalog/items"];
const json = async <T,>(response: Response): Promise<T> => response.json();
export const catalogMoney = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export const catalogError = (error: unknown) => error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Something went wrong. Please try again.";

export function useStaffCatalog() {
  return useQuery<{ items: CatalogItem[] }>({ queryKey: staffKey, staleTime: 30_000, queryFn: async () => json(await apiRequest("GET", "/api/catalog/items")) });
}
export type CatalogOrder = { id?: number | string; productId?: string; amountTotalCents?: number; status?: string; createdAt?: string; customerEmail?: string | null; crmContactId?: number | null; crmAccountId?: number | null };
export type CatalogInquiry = {
  id: string; offerName: string; unitAmountCents: number; name: string; email: string;
  phone: string; message: string; contactId: number | null; contactName: string | null;
  accountId: number | null; createdAt: string;
  invoiceId: number | null; invoiceNumber: string | null; invoiceStatus: string | null;
};
export function useCatalogInquiries() {
  return useQuery<{ inquiries: CatalogInquiry[] }>({
    queryKey: ["/api/catalog/inquiries"], staleTime: 15_000, refetchOnMount: "always", refetchInterval: 15_000,
    queryFn: async () => json(await apiRequest("GET", "/api/catalog/inquiries")),
  });
}
export function useResolveCatalogInquiry() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: ({ id, contactId, clientId }: { id: string; contactId?: number; clientId?: number }) =>
      apiRequest("POST", `/api/catalog/inquiries/${encodeURIComponent(id)}/resolve`, contactId ? { contactId } : clientId ? { clientId } : {}).then(json<{ contactId: number }>),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["/api/catalog/inquiries"] });
      void cache.invalidateQueries({ queryKey: ["/api/invoices/billing-parties"] });
    },
  });
}
export function useCatalogOrders() {
  return useQuery<{ orders: CatalogOrder[] }>({ queryKey: ["/api/catalog/orders"], staleTime: 30_000, queryFn: async () => json(await apiRequest("GET", "/api/catalog/orders")) });
}
export function usePublicCatalog() {
  return useQuery<{ items: CatalogItem[] }>({ queryKey: publicKey, staleTime: 30_000, queryFn: async () => json(await apiRequest("GET", "/api/portal/catalog/items")) });
}
export function usePublicCatalogItem(id: string | undefined) {
  return useQuery<CatalogItem>({ queryKey: [...publicKey, id], enabled: !!id, staleTime: 30_000, queryFn: async () => json(await apiRequest("GET", `/api/portal/catalog/items/${encodeURIComponent(id!)}`)) });
}
export function useCatalogActions() {
  const cache = useQueryClient();
  const refresh = () => { void cache.invalidateQueries({ queryKey: staffKey }); void cache.invalidateQueries({ queryKey: publicKey }); };
  const create = useMutation({ mutationFn: (input: CatalogInput) => apiRequest("POST", "/api/catalog/items", input).then(json<CatalogItem>), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, input }: { id: string; input: Partial<CatalogInput> }) => apiRequest("PATCH", `/api/catalog/items/${encodeURIComponent(id)}`, input).then(json<CatalogItem>), onSuccess: refresh });
  const archive = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/catalog/items/${encodeURIComponent(id)}`), onSuccess: refresh });
  return { create, update, archive };
}
export function useCatalogCheckout() {
  return useMutation({ mutationFn: (id: string) => apiRequest("POST", `/api/portal/catalog/items/${encodeURIComponent(id)}/checkout`).then(json<{ url: string }>) });
}
export function useCatalogInquiry() {
  return useMutation({ mutationFn: ({ id, ...input }: { id: string; requestId: string; name: string; email: string; message: string; phone?: string }) => apiRequest("POST", `/api/portal/catalog/items/${encodeURIComponent(id)}/inquire`, input) });
}