import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { SharedInbox } from "../src/components/communications/shared-inbox";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

// Clerk is present only because the call button reads staff access; this
// fixture doesn't exercise sign-in.
function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  return <SharedInbox selected={selected} onSelect={setSelected} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
      <QueryClientProvider client={queryClient}>
        <Router hook={() => ["/comms", () => {}]}>
          <div className="p-4"><Harness /></div>
        </Router>
        <Toaster />
      </QueryClientProvider>
    </ClerkProvider>
  </React.StrictMode>,
);
