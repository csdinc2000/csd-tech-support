import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { getQueryFn } from "../src/lib/queryClient";
import CatalogInquiryQueue from "../src/components/invoices/catalog-inquiry-queue";
import "../src/index.css";

const client = new QueryClient({
  defaultOptions: { queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false, refetchOnWindowFocus: false } },
});
(window as any).__invoiceTestQueryClient = client;
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><Router><main className="mx-auto max-w-5xl p-6"><CatalogInquiryQueue /></main></Router></QueryClientProvider>,
);