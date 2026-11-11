import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "../src/components/theme/theme-provider";
import ThemeToggle from "../src/components/theme/theme-toggle";
import "../src/index.css";
import "../src/theme-dark.css";

// The staff header's theme control next to a sample of the literal light
// colours the app is written in, plus a marketplace `.cyber` frame that must
// keep its own palette whatever the theme.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <div className="p-6 space-y-4 bg-gray-50 min-h-screen" data-testid="page">
        <ThemeToggle />
        <div className="rounded border border-gray-200 bg-white p-4 text-gray-900" data-testid="card">
          <p className="text-gray-500" data-testid="muted">Muted copy</p>
          <span className="rounded border border-red-200 bg-red-50 px-2 text-red-700" data-testid="badge">Critical</span>
        </div>
        <div className="cyber p-4">
          <div className="bg-white text-gray-900 p-2" data-testid="cyber-white">Marketplace keeps its own colours</div>
        </div>
      </div>
    </ThemeProvider>
  </React.StrictMode>,
);
