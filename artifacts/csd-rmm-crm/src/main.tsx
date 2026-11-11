import { createRoot } from "react-dom/client";
import App from "./App";
import { captureUtmCampaign } from "./lib/utm-capture";
import "./index.css";
import "./theme-dark.css";

captureUtmCampaign();

createRoot(document.getElementById("root")!).render(<App />);
