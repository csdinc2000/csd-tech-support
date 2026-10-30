import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import CsdIntakeForm from "../src/components/forms/csd-intake-form";
import { CustomerAvatar } from "../src/components/customers/customer-avatar";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

// `#intake` renders the public intake form; `#avatar` renders the customer
// page avatar fed from the overview endpoint.
function AvatarView() {
  const { data } = useQuery<any>({ queryKey: ["/api/clients/42/overview"] });
  if (!data) return null;
  return <CustomerAvatar clientId={data.client.id} name={data.client.name} avatar={data.client.avatar} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="p-6">{window.location.hash === "#avatar" ? <AvatarView /> : <CsdIntakeForm />}</div>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
