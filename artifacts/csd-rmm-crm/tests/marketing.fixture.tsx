import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { MarketingHubView } from "../src/pages/marketing";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

const params = new URLSearchParams(window.location.search);
// `?path=/marketing/tools?tool=utm` picks the starting tab; `?features=crm` limits access.
const { hook, searchHook } = memoryLocation({ path: params.get("path") ?? "/marketing" });
const granted = params.get("features");
const can = (feature: string) => granted == null || granted.split(",").includes(feature);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={hook} searchHook={searchHook}>
        <MarketingHubView can={can} isAdmin={params.get("admin") !== "0"} storagePrefix="csd:marketing-playbook:test" />
      </Router>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
