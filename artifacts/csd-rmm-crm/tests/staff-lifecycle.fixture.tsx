import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, useLocation, useRouter } from "wouter";
import { useUnsavedChangesGuard } from "../src/hooks/use-unsaved-changes-guard";
import { subscribeA2PLive } from "../src/lib/a2p-live";
import {
  Carousel, CarouselContent, CarouselItem, type CarouselApi,
} from "../src/components/ui/carousel";
import { IncomingCallAlertsSession } from "../src/components/notifications/incoming-call-alerts";
import PttAccessoryProbe from "../src/pages/ptt-accessory-probe";
import "../src/index.css";

let subscriptions = 0;
let carouselHandlers = 0;
let statusEvents = 0;
let connectedEvents = 0;
let lateCallbacks: Array<() => void> = [];
const streams = new Set<TestEventSource>();
class TestEventSource extends EventTarget {
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { super(); streams.add(this); }
  override addEventListener(type: string, handler: EventListener) {
    subscriptions++;
    super.addEventListener(type, handler);
    lateCallbacks.push(handler as () => void);
  }
  override removeEventListener(type: string, handler: EventListener) {
    subscriptions--;
    super.removeEventListener(type, handler);
  }
  close() { streams.delete(this); this.readyState = 2; }
}

function LiveBanner() {
  useEffect(() => subscribeA2PLive({
    createEventSource: () => new TestEventSource(),
    onStatus: () => { statusEvents++; },
    onConnectedChange: () => { connectedEvents++; },
  }), []);
  return <div>A2P live subscription</div>;
}
function Form({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty, "Leave the lifecycle draft?");
  return <input aria-label="Draft" defaultValue="Keep this draft" />;
}
const instrumentCarousel = (api: CarouselApi) => {
  if (!api) return;
  const on = api.on.bind(api);
  const off = api.off.bind(api);
  // setApi runs before the component's subscription effect. Count that effect's
  // two handlers independently of Embla's own destroy/reInit machinery.
  api.on = (type, handler) => { carouselHandlers++; return on(type, handler); };
  api.off = (type, handler) => { carouselHandlers--; return off(type, handler); };
};
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } },
});

function Session() {
  const [location, navigate] = useLocation();
  const router = useRouter();
  const initialAroundNav = React.useRef(router.aroundNav);
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    Object.assign(window, { __lifecycle: {
      navigate: (route: string) => flushSync(() => navigate(route)),
      dirty: (value: boolean) => flushSync(() => setDirty(value)),
      replaceCarousel: () => flushSync(() => setVersion(v => v + 1)),
      snapshot: () => ({
        streams: streams.size, subscriptions, carouselHandlers,
        statusEvents, connectedEvents,
        navigationRestored: router.aroundNav === initialAroundNav.current,
      }),
      emit: () => {
        for (const stream of streams) {
          stream.dispatchEvent(new Event("hello"));
          stream.dispatchEvent(new Event("status"));
        }
      },
      late: () => {
        const callbacks = lateCallbacks;
        lateCallbacks = [];
        callbacks.forEach(callback => callback());
      },
    } });
  }, [navigate, router]);
  return <>
    {/* This deliberately lives outside the changing route, just like the staff shell. */}
    <IncomingCallAlertsSession userId="lifecycle-staff" allowed />
    <nav>{["idle", "form", "carousel", "messages", "probe"].map(route =>
      <button key={route} onClick={() => navigate(`/session/${route}`)}>{route}</button>)}</nav>
    <output data-testid="route">{location}</output>
    {location === "/session/form" && <Form dirty={dirty} />}
    {location === "/session/messages" && <LiveBanner />}
    {location === "/session/carousel" && <Carousel key={version} setApi={instrumentCarousel}>
      <CarouselContent>{[1, 2, 3].map(n => <CarouselItem key={n}>Slide {n}</CarouselItem>)}</CarouselContent>
    </Carousel>}
    {location === "/session/probe" && <PttAccessoryProbe />}
  </>;
}
history.replaceState(null, "", "/tests/staff-lifecycle.fixture.html");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><Router><Session /></Router></QueryClientProvider>,
);
