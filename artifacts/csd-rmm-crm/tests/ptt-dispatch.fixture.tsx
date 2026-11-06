import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PttDispatch from "../src/pages/ptt-dispatch";
import "../src/index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <PttDispatch />
  </QueryClientProvider>,
);
