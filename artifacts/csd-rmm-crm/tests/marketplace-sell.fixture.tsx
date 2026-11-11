import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import MarketplaceSellPage from "../src/pages/marketplace-sell";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={() => ["/portal/marketplace/sell", () => {}]}>
        <MarketplaceSellPage />
      </Router>
    </QueryClientProvider>
  </React.StrictMode>,
);
