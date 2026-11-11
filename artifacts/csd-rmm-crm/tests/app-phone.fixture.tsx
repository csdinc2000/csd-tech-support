import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppPhoneView } from "../src/components/communications/app-phone";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/lib/queryClient";
import "../src/index.css";

// A stand-in for Twilio's Device: tests trigger calls with window.fakeRing().
type Listener = (...args: any[]) => void;
class Emitter {
  private listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this; }
  emit(event: string, ...args: any[]) { for (const l of this.listeners.get(event) ?? []) l(...args); }
  removeAllListeners() { this.listeners.clear(); return this; }
}

declare global {
  interface Window {
    fakeRing: (caller: string) => void;
    fakeCancel: () => void;
    phoneLog: string[];
    deviceToken: string | null;
  }
}
window.phoneLog = [];
window.deviceToken = null;

class FakeCall extends Emitter {
  customParameters: Map<string, string>;
  parameters = { From: "client:anonymous" };
  constructor(caller: string) { super(); this.customParameters = new Map([["caller", caller], ["line", "+19546377300"]]); }
  accept() { window.phoneLog.push("accept"); this.emit("accept"); }
  reject() { window.phoneLog.push("reject"); this.emit("reject"); }
  disconnect() { window.phoneLog.push("disconnect"); this.emit("disconnect"); }
  mute(value: boolean) { window.phoneLog.push(value ? "mute" : "unmute"); }
  sendDigits(digits: string) { window.phoneLog.push(`digits:${digits}`); }
}

class FakeDevice extends Emitter {
  static isSupported = true;
  constructor(token: string) { super(); window.deviceToken = token; }
  async register() {
    setTimeout(() => this.emit("registered"), 10);
    let current: FakeCall | null = null;
    window.fakeRing = (caller) => { current = new FakeCall(caller); this.emit("incoming", current); };
    window.fakeCancel = () => current?.emit("cancel");
  }
  updateToken() {}
  destroy() { window.phoneLog.push("destroy"); }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <main className="p-6"><h1>Staff page</h1></main>
      <AppPhoneView loadVoiceSdk={async () => ({ Device: FakeDevice as any })} />
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
