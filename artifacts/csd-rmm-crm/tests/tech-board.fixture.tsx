import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { TechBoard } from "../src/components/dashboard/tech-board/tech-board";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

const params = new URLSearchParams(window.location.search);
const canViewCalls = params.get("calls") !== "0";
// `?features=crm` limits which quick links show; omitted means every feature is granted.
const granted = params.get("features");
const can = (feature: string) => granted == null || granted.split(",").includes(feature);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={() => ["/dashboard", () => {}]}>
        <TechBoard canViewCalls={canViewCalls} can={can} />
      </Router>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
