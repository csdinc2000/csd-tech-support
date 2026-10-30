import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import CsdIntakeForm from "../src/components/forms/csd-intake-form";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

// The public repair intake form, as rendered on /intake.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="p-6"><CsdIntakeForm /></div>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
