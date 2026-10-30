import { useEffect } from "react";
import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "@/components/error-boundary";
import Sidebar from "@/components/layout/sidebar";
import Header from "@/components/layout/header";
import Dashboard from "@/pages/dashboard";
import Devices from "@/pages/devices";
import Tickets from "@/pages/tickets";
import RemoteAccess from "@/pages/remote-access";
import Automation from "@/pages/automation";
import Monitoring from "@/pages/monitoring";
import Patches from "@/pages/patches";
import AutomationHub from "@/pages/automation-hub";
import Reports from "@/pages/reports";
import NetworkDiscovery from "@/pages/network-discovery";
import CsdIntakePage from "@/pages/csd-intake";
import WebAppIntakePage from "@/pages/web-app-intake";
import EmbedPage from "@/pages/embed";
import PrivacyPage from "@/pages/privacy";
import CustomersHub from "@/pages/customers-hub";
import PhoneHub from "@/pages/phone-hub";
import SchedulingPage from "@/pages/scheduling";
import CrmJobs from "@/pages/crm-jobs";
import ServiceLogs from "@/pages/service-logs";
import TechTools from "@/pages/tech-tools";
import CompliancePage from "@/pages/compliance";
import AriaPage from "@/pages/aria";
import AriaMultiCam from "@/pages/aria-multicam";
import BillingPage from "@/pages/billing";
import Invoices from "@/pages/invoices";
import InvoiceDetail from "@/pages/invoice-detail";
import PublicInvoice from "@/pages/public-invoice";
import HelpdeskAdmin from "@/pages/helpdesk-admin";
import DispatchSettingsPage from "@/pages/dispatch-settings";
import PttDispatch from "@/pages/ptt-dispatch";
import CustomerPortal from "@/pages/customer-portal";
import PortalHome from "@/pages/portal-home";
import DownloadAgentPage from "@/pages/download-agent";
import LandingPage from "@/pages/landing";
import AriaWidget from "@/components/aria/aria-widget";
import SupportChatWidget from "@/components/aria/support-chat-widget";
import NewLeadNotifier from "@/components/notifications/new-lead-notifier";
import NotFound from "@/pages/not-found";
import { ShieldAlert } from "lucide-react";

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          {children}
        </main>
      </div>
      <AriaWidget />
      <NewLeadNotifier />
    </div>
  );
}

function AdminRouter() {
  return (
    <Switch>
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/devices" component={Devices} />
      <Route path="/tickets" component={Tickets} />
      <Route path="/remote-access" component={RemoteAccess} />
      <Route path="/automation" component={Automation} />
      <Route path="/monitoring" component={Monitoring} />
      <Route path="/patches" component={Patches} />
      <Route path="/automation-hub" component={AutomationHub} />
      <Route path="/reports" component={Reports} />
      <Route path="/network-discovery" component={NetworkDiscovery} />

      {/* Customers hub — Overview / Leads & Pipeline (Leads + Deals + Intakes) / Contacts / Clients */}
      <Route path="/crm" component={CustomersHub} />
      <Route path="/crm/leads" component={CustomersHub} />
      <Route path="/crm/pipeline" component={CustomersHub} />
      <Route path="/crm/contacts" component={CustomersHub} />
      <Route path="/clients" component={CustomersHub} />
      <Route path="/admin/intakes" component={CustomersHub} />
      <Route path="/client-portal">
        <Redirect to="/crm" />
      </Route>
      <Route path="/crm/jobs" component={CrmJobs} />

      {/* Phone & Text hub — Messages / Call Tracking / Phone Settings */}
      <Route path="/comms" component={PhoneHub} />
      <Route path="/messages" component={PhoneHub} />
      <Route path="/admin/call-tracking" component={PhoneHub} />
      <Route path="/admin/phone" component={PhoneHub} />
      <Route path="/comms/voicemails" component={PhoneHub} />
      <Route path="/comms/config" component={PhoneHub} />
      <Route path="/ptt" component={PttDispatch} />
      <Route path="/scheduling">
        <RequireAdmin><SchedulingPage /></RequireAdmin>
      </Route>
      <Route path="/calendar">
        <RequireAdmin><SchedulingPage /></RequireAdmin>
      </Route>

      <Route path="/service-logs" component={ServiceLogs} />
      <Route path="/tech-tools" component={TechTools} />
      <Route path="/compliance">
        <RequireAdmin><CompliancePage /></RequireAdmin>
      </Route>
      <Route path="/aria" component={AriaPage} />
      <Route path="/aria-command" component={AriaMultiCam} />
      <Route path="/billing">
        <RequireAdmin><BillingPage /></RequireAdmin>
      </Route>
      <Route path="/invoices">
        <RequireAdmin><Invoices /></RequireAdmin>
      </Route>
      <Route path="/invoices/new">
        <RequireAdmin><InvoiceDetail /></RequireAdmin>
      </Route>
      <Route path="/invoices/:id">
        <RequireAdmin><InvoiceDetail /></RequireAdmin>
      </Route>
      <Route path="/helpdesk/admin">
        <RequireAdmin><HelpdeskAdmin /></RequireAdmin>
      </Route>
      <Route path="/dispatch-settings">
        <RequireAdmin><DispatchSettingsPage /></RequireAdmin>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();

  if (isAdmin) return <>{children}</>;

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border bg-white p-8 text-center shadow-sm">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-csd-red" />
        <h1 className="text-xl font-semibold">Administrator access required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This area contains account-wide configuration. Ask an administrator to
          grant access if you need to manage it.
        </p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      window.location.href = "/api/login";
    }
  }, [isLoading, isAuthenticated]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-gray-500">
        Loading…
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return <>{children}</>;
}

// Public pages where the customer-facing support chatbot should appear.
// (The /embed page is excluded so the widget isn't nested inside embeds.)
const SUPPORT_CHAT_PATHS = [
  "/",
  "/intake",
  "/web-app-intake",
  "/privacy",
  "/portal",
  "/portal/ticket",
  "/download",
];

function Router() {
  const [location] = useLocation();
  const showSupportChat = SUPPORT_CHAT_PATHS.includes(location);

  return (
    <>
      <Switch>
        {/* Public routes - no layout */}
        <Route path="/" component={LandingPage} />
        <Route path="/intake" component={CsdIntakePage} />
        <Route path="/web-app-intake" component={WebAppIntakePage} />
        <Route path="/embed" component={EmbedPage} />
        <Route path="/privacy" component={PrivacyPage} />
        <Route path="/portal" component={PortalHome} />
        <Route path="/portal/ticket" component={CustomerPortal} />
        <Route path="/download" component={DownloadAgentPage} />
        <Route path="/pay/invoice/:token" component={PublicInvoice} />
        <Route path="/invoice/:token" component={PublicInvoice} />

        {/* Admin routes - with layout, gated behind login */}
        <Route>
          <RequireAuth>
            <Layout>
              <AdminRouter />
            </Layout>
          </RequireAuth>
        </Route>
      </Switch>
      {showSupportChat && <SupportChatWidget />}
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
