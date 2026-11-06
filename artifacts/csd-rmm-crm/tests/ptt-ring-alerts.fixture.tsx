import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PttRingAlertsSession } from "../src/components/ptt/ptt-ring-alerts";
import { PTT_JOIN_EVENT, type PttJoinDetail } from "../src/lib/ptt-ring";
import "../src/index.css";

const params = new URLSearchParams(window.location.search);
const allowed = params.get("allowed") !== "false";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function Fixture() {
  useEffect(() => {
    const win = window as any;
    win.__joinEvents = [] as PttJoinDetail[];
    const onJoin = (event: Event) => win.__joinEvents.push((event as CustomEvent<PttJoinDetail>).detail);
    window.addEventListener(PTT_JOIN_EVENT, onJoin);
    return () => window.removeEventListener(PTT_JOIN_EVENT, onJoin);
  }, []);
  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <p>Any page in the app</p>
      <PttRingAlertsSession userId="staff-b" allowed={allowed} />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
);
