import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import MarketplaceAdminPage from "../src/pages/marketplace-admin";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={() => ["/marketplace", () => {}]}>
        <MarketplaceAdminPage />
      </Router>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
