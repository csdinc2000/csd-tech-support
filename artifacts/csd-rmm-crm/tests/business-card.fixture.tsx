import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Router } from "wouter";
import BusinessCardPage from "../src/pages/business-card";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

// `?token=<t>` picks the card; the spec stubs the API with page.route().
const token = new URLSearchParams(window.location.search).get("token") ?? "tok_test_1234567890";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={() => [`/card/${token}`, () => {}]}>
        <Route path="/card/:token" component={BusinessCardPage} />
      </Router>
    </QueryClientProvider>
  </React.StrictMode>,
);
