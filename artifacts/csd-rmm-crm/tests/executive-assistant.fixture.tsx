import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { ExecutiveAssistantView } from "../src/pages/executive-assistant";
import { AriaTodayStrip } from "../src/components/assistant/aria-today-strip";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

// `?view=strip` mounts only the compact Aria "Today" strip.
const params = new URLSearchParams(window.location.search);
const { hook, searchHook } = memoryLocation({ path: "/assistant" });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={hook} searchHook={searchHook}>
        {params.get("view") === "strip" ? <AriaTodayStrip /> : <ExecutiveAssistantView />}
      </Router>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
