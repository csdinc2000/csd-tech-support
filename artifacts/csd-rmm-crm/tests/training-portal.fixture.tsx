import React from "react";
import ReactDOM from "react-dom/client";
import { Router } from "wouter";
import { TrainingPortalView } from "../src/pages/training";
import type { StaffFeature } from "../src/hooks/use-admin-access";
import "../src/index.css";

// `?features=crm,helpdesk` limits access; omitted means every feature is granted.
const granted = new URLSearchParams(window.location.search).get("features");
const can = (feature: StaffFeature) => granted == null || granted.split(",").includes(feature);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router hook={() => ["/training", () => {}]}>
      <TrainingPortalView can={can} storageKey="csd:training-progress:test" />
    </Router>
  </React.StrictMode>,
);
