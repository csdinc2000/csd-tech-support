import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { SalesAgentsView } from "../src/pages/sales-agents";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

const params = new URLSearchParams(window.location.search);
// `?path=/sales/copilot?leadId=7` picks the starting tab; `?owner=0` renders as non-owner staff.
const { hook, searchHook } = memoryLocation({ path: params.get("path") ?? "/sales" });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={hook} searchHook={searchHook}>
        <SalesAgentsView isOwner={params.get("owner") !== "0"} />
      </Router>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
