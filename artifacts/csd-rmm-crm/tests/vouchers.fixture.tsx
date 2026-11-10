import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MarketingVouchers } from "../src/components/marketing/marketing-vouchers";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="p-4"><MarketingVouchers /></div>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
