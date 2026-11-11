import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import ClientContractsCard from "../src/components/contracts/client-contracts-card";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ClientContractsCard client={{ id: 42, name: "Isolated test client" }} />
    <Toaster />
  </QueryClientProvider>,
);