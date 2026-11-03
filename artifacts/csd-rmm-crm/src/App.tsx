import { useEffect, useState } from "react";
import { Switch, Route, Redirect, useLocation, useSearch, Router as WouterRouter } from "wouter";
import { queryClient, synchronizeQueryCacheUser } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider, Show, SignIn, SignUp, useAuth, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { useAdminAccess, type StaffFeature } from "@/hooks/use-admin-access";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "@/components/error-boundary";
import { ThemeProvider } from "@/components/theme/theme-provider";
import Sidebar from "@/components/layout/sidebar";
import Header from "@/components/layout/header";
import Dashboard from "@/pages/dashboard";
import RmmDashboard from "@/pages/rmm-dashboard";
import Devices from "@/pages/devices";
import Tickets from "@/pages/tickets";
import RemoteAccess from "@/pages/remote-access";
import AutomationWorkspace from "@/pages/automation-workspace";
import Monitoring from "@/pages/monitoring";
import Patches from "@/pages/patches";
import Reports from "@/pages/reports";
import NetworkDiscovery from "@/pages/network-discovery";
import WebsiteDiscovery from "@/pages/website-discovery";
import CsdIntakePage from "@/pages/csd-intake";
import WebAppIntakePage from "@/pages/web-app-intake";
import EmbedPage from "@/pages/embed";
import PrivacyPage from "@/pages/privacy";
import CustomersHub from "@/pages/customers-hub";
import CustomerDetail from "@/pages/customer-detail";
import PhoneHub from "@/pages/phone-hub";
import EmailComposePage from "@/pages/email-compose";
import SchedulingPage from "@/pages/scheduling";
import StaffMeetingsPage from "@/pages/staff-meetings";
import StaffCalendarPage from "@/pages/staff-calendar";
import CrmJobs from "@/pages/crm-jobs";
import ServiceLogs from "@/pages/service-logs";
import TechTools from "@/pages/tech-tools";
import TrainingPortal from "@/pages/training";
import CompliancePage from "@/pages/compliance";
import AriaPage from "@/pages/aria";
import AriaMultiCam from "@/pages/aria-multicam";
import BillingPage from "@/pages/billing";
import Invoices from "@/pages/invoices";
import InvoiceSettingsPage from "@/pages/invoice-settings";
import ImportPaypal from "@/pages/import-paypal";
import ImportContacts from "@/pages/import-contacts";
import InvoiceDetail from "@/pages/invoice-detail";
import CatalogManager from "@/pages/catalog-manager";
import CatalogOffer from "@/pages/catalog-offer";
import RetainedDeletedContacts from "@/pages/retained-deleted-contacts";
import PublicInvoice from "@/pages/public-invoice";
import PublicContract from "@/pages/public-contract";
import HelpdeskAdmin from "@/pages/helpdesk-admin";
import StaffAdminPage from "@/pages/staff-admin";
import StaffInviteLanding from "@/pages/staff-invite-landing";
import { apiRequest } from "@/lib/queryClient";
import ProviderHealthPage from "@/pages/provider-health";
import PttDispatch from "@/pages/ptt-dispatch";
import PttAccessoryProbe from "@/pages/ptt-accessory-probe";
import CustomerPortal from "@/pages/customer-portal";
import PortalContract from "@/pages/portal-contract";
import PortalHome from "@/pages/portal-home";
import DownloadAgentPage from "@/pages/download-agent";
import LandingPage from "@/pages/landing";
import LocalServicePage from "@/pages/local-service";
import ScamCheckGuidePage from "@/pages/scam-check-guide";
import LocalSeoServicesPage from "@/pages/local-seo-services";
import MarketplaceBrowse from "@/pages/marketplace-browse";
import MarketplaceListingPage from "@/pages/marketplace-listing";
import MarketplaceSellPage from "@/pages/marketplace-sell";
import MarketplaceManagePage from "@/pages/marketplace-manage";
import MarketplaceAdminPage from "@/pages/marketplace-admin";
import StaffAria from "@/components/aria/staff-aria";
import SupportChatWidget from "@/components/aria/support-chat-widget";
import NewLeadNotifier from "@/components/notifications/new-lead-notifier";
import IncomingCallAlerts from "@/components/notifications/incoming-call-alerts";
import NotFound from "@/pages/not-found";
import { ShieldAlert } from "lucide-react";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/CSD_ICON_Favicon_Logo_1765066839385.png`,
  },
  variables: {
    colorPrimary: "hsl(0, 100%, 45%)",
    colorForeground: "hsl(0, 0%, 15%)",
    colorMutedForeground: "hsl(240, 3.8%, 46.1%)",
    colorDanger: "hsl(0, 84.2%, 60.2%)",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "hsl(0, 0%, 15%)",
    colorNeutral: "hsl(240, 5.9%, 90%)",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-gray-950",
    headerSubtitle: "text-gray-600",
    socialButtonsBlockButtonText: "text-gray-800",
    formFieldLabel: "text-gray-800",
    footerActionLink: "text-csd-red",
    footerActionText: "text-gray-600",
    dividerText: "text-gray-500",
    identityPreviewEditButton: "text-csd-red",
    formFieldSuccessText: "text-green-700",
    alertText: "text-gray-800",
    logoBox: "mb-4 flex justify-center",
    logoImage: "h-24 w-24 rounded-2xl object-contain",
    socialButtonsBlockButton: "border-gray-200 hover:bg-gray-50",
    formButtonPrimary: "bg-csd-red hover:bg-red-700",
    formFieldInput: "border-gray-300 text-gray-950",
    footerAction: "border-gray-100",
    dividerLine: "bg-gray-200",
    alert: "border-red-200 bg-red-50",
    otpCodeFieldInput: "border-gray-300 text-gray-950",
    formFieldRow: "gap-2",
    main: "gap-5",
  },
};

export function QueryCacheUserSynchronizer({
  subscribe,
}: {
  subscribe: (listener: (userId: string | null) => void) => () => void;
}) {
  useEffect(() => subscribe(synchronizeQueryCacheUser), [subscribe]);
  return null;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  return (
    <QueryCacheUserSynchronizer
      subscribe={(listener) => addListener(({ user }) => listener(user?.id ?? null))}
    />
  );
}

function safeStaffRedirect(search = window.location.search): string {
  const requested = new URLSearchParams(search).get("redirect");
  if (
    !requested ||
    !requested.startsWith("/") ||
    requested.startsWith("//") ||
    requested.startsWith("/sign-in") ||
    requested.startsWith("/sign-up")
  ) {
    return "/dashboard";
  }
  return requested;
}

function LegacyDispatchSettingsRedirect() {
  const params = new URLSearchParams(useSearch());
  params.set("tab", "dispatch");
  return <Redirect to={`/staff?${params.toString()}`} />;
}

function SignInPage() {
  const redirectTarget = safeStaffRedirect();
  const signUpUrl = `${basePath}/staff-invite`;
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
    <SignIn
      routing="path"
      path={`${basePath}/sign-in`}
      signUpUrl={signUpUrl}
      forceRedirectUrl={`${basePath}${redirectTarget}`}
    />
  </div>;
}

function SignUpPage() {
  const [validInvite, setValidInvite] = useState<"checking" | "valid" | "invalid">("checking");
  useEffect(() => {
    let active = true;
    let token: string | null = null;
    try { token = sessionStorage.getItem("csd_staff_invite_token"); } catch { /* Sign-up stays closed. */ }
    if (!token) {
      setValidInvite("invalid");
      return;
    }
    void apiRequest("POST", "/api/public/staff-invites/validate", { token })
      .then(() => { if (active) setValidInvite("valid"); })
      .catch(() => { if (active) setValidInvite("invalid"); });
    return () => { active = false; };
  }, []);
  if (validInvite === "checking") return <div className="flex min-h-[100dvh] items-center justify-center text-muted-foreground">Checking invitation…</div>;
  if (validInvite === "invalid") return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><div className="max-w-md rounded-xl border p-8 text-center"><h1 className="text-xl font-semibold">An invitation is required</h1><p className="mt-2 text-sm text-muted-foreground">Staff accounts can only be created with a private link issued by the account owner.</p><a className="mt-4 inline-block text-csd-red underline" href={`${basePath}/staff-invite`}>Open your invitation</a></div></div>;
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
    <SignUp
      routing="path"
      path={`${basePath}/sign-up`}
      signInUrl={`${basePath}/sign-in?redirect=/staff-invite`}
      forceRedirectUrl={`${basePath}/staff-invite`}
    />
  </div>;
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <IncomingCallAlerts />
          <StaffAria />
          {children}
        </main>
      </div>
      <NewLeadNotifier />
    </div>
  );
}

type OwnerAccessOverride = { isOwner: boolean; isLoading: boolean };
export function AdminRouter({ ownerAccessOverride }: { ownerAccessOverride?: OwnerAccessOverride } = {}) {
  return (
    <Switch>
      <Route path="/dashboard"><RequireFeature feature="dashboard"><Dashboard /></RequireFeature></Route>
      <Route path="/dashboard/rmm"><RequireFeature feature="dashboard"><RmmDashboard /></RequireFeature></Route>
      <Route path="/devices"><RequireFeature feature="operations"><Devices /></RequireFeature></Route>
      <Route path="/tickets"><RequireFeature feature="helpdesk"><Tickets /></RequireFeature></Route>
      <Route path="/remote-access"><RequireFeature feature="operations"><RemoteAccess /></RequireFeature></Route>
      <Route path="/automation"><RequireFeature feature="automation"><AutomationWorkspace /></RequireFeature></Route>
      <Route path="/monitoring"><RequireFeature feature="operations"><Monitoring /></RequireFeature></Route>
      <Route path="/patches"><RequireFeature feature="operations"><Patches /></RequireFeature></Route>
      <Route path="/automation-hub"><RequireFeature feature="automation"><AutomationWorkspace /></RequireFeature></Route>
      <Route path="/reports"><RequireFeature feature="reports"><Reports /></RequireFeature></Route>
      <Route path="/network-discovery"><RequireFeature feature="operations"><NetworkDiscovery /></RequireFeature></Route>
      <Route path="/website-discovery"><RequireFeature feature="crm"><WebsiteDiscovery /></RequireFeature></Route>

      {/* Customers hub — Overview / Leads & Pipeline (Leads + Deals + Intakes) / Contacts / Clients */}
      <Route path="/crm"><RequireFeature feature="crm"><CustomersHub /></RequireFeature></Route>
      <Route path="/crm/customers"><RequireFeature feature="crm"><CustomersHub /></RequireFeature></Route>
      <Route path="/crm/customers/:id"><RequireFeature feature="crm"><CustomerDetail /></RequireFeature></Route>
      <Route path="/crm/leads"><RequireFeature feature="crm"><CustomersHub /></RequireFeature></Route>
      <Route path="/crm/pipeline"><RequireFeature feature="crm"><CustomersHub /></RequireFeature></Route>
      <Route path="/crm/contacts"><RequireFeature feature="crm"><CustomersHub /></RequireFeature></Route>
      <Route path="/crm/contacts/import"><RequireFeature feature="crm"><ImportContacts /></RequireFeature></Route>
      <Route path="/clients"><RequireFeature feature="crm"><CustomersHub /></RequireFeature></Route>
      <Route path="/admin/intakes"><RequireFeature feature="crm"><CustomersHub /></RequireFeature></Route>
      <Route path="/client-portal">
        <Redirect to="/portal" />
      </Route>
      <Route path="/customer-portal">
        <Redirect to="/portal" />
      </Route>
      <Route path="/crm/jobs"><RequireFeature feature="crm"><CrmJobs /></RequireFeature></Route>
      <Route path="/crm/retained-contacts">
        <RequireFeature feature="crm"><RetainedDeletedContacts /></RequireFeature>
      </Route>

      {/* Phone & Text hub — Messages / Call Tracking / Phone Settings */}
      <Route path="/comms"><RequireFeature feature="communications"><PhoneHub /></RequireFeature></Route>
      <Route path="/comms/email"><RequireFeature feature="communications"><EmailComposePage /></RequireFeature></Route>
      <Route path="/messages"><RequireFeature feature="communications"><PhoneHub /></RequireFeature></Route>
      <Route path="/admin/call-tracking"><RequireFeature feature="communications"><PhoneHub /></RequireFeature></Route>
      <Route path="/admin/phone"><RequireFeature feature="communications"><PhoneHub /></RequireFeature></Route>
      <Route path="/comms/voicemails"><RequireFeature feature="communications"><PhoneHub /></RequireFeature></Route>
      <Route path="/comms/config"><RequireFeature feature="communications"><PhoneHub /></RequireFeature></Route>
      <Route path="/ptt/accessory-probe"><RequireFeature feature="communications"><PttAccessoryProbe /></RequireFeature></Route>
      <Route path="/ptt"><RequireFeature feature="communications"><PttDispatch /></RequireFeature></Route>
      <Route path="/scheduling">
        <RequireFeature feature="scheduling"><SchedulingPage /></RequireFeature>
      </Route>
      <Route path="/meetings">
        <RequireFeature feature="scheduling"><StaffMeetingsPage /></RequireFeature>
      </Route>
      <Route path="/staff-calendar">
        <RequireFeature feature="operations"><StaffCalendarPage /></RequireFeature>
      </Route>
      <Route path="/calendar-view">
        <RequireFeature feature="scheduling"><StaffCalendarPage showSettingsLink /></RequireFeature>
      </Route>
      <Route path="/calendar">
        <RequireFeature feature="scheduling"><SchedulingPage /></RequireFeature>
      </Route>

      <Route path="/service-logs"><RequireFeature feature="operations"><ServiceLogs /></RequireFeature></Route>
      <Route path="/tech-tools"><RequireFeature feature="operations"><TechTools /></RequireFeature></Route>
      <Route path="/training" component={TrainingPortal} />
      <Route path="/compliance">
        <RequireFeature feature="compliance"><CompliancePage /></RequireFeature>
      </Route>
      <Route path="/aria" component={AriaPage} />
      <Route path="/aria-command" component={AriaMultiCam} />
      <Route path="/billing">
        <RequireFeature feature="billing"><BillingPage /></RequireFeature>
      </Route>
      <Route path="/invoices">
        <RequireFeature feature="invoices"><Invoices /></RequireFeature>
      </Route>
      <Route path="/invoices/catalog">
        <RequireFeature feature="invoices">
          {ownerAccessOverride
            ? <OwnerRouteGuard {...ownerAccessOverride}><CatalogManager /></OwnerRouteGuard>
            : <RequireOwner><CatalogManager /></RequireOwner>}
        </RequireFeature>
      </Route>
      <Route path="/invoices/settings">
        <RequireFeature feature="invoices">
          {ownerAccessOverride
            ? <OwnerRouteGuard {...ownerAccessOverride}><InvoiceSettingsPage /></OwnerRouteGuard>
            : <RequireOwner><InvoiceSettingsPage /></RequireOwner>}
        </RequireFeature>
      </Route>
      <Route path="/invoices/import-paypal">
        <RequireFeature feature="invoices"><ImportPaypal /></RequireFeature>
      </Route>
      <Route path="/invoices/new">
        <RequireFeature feature="invoices"><InvoiceDetail /></RequireFeature>
      </Route>
      <Route path="/invoices/:id">
        <RequireFeature feature="invoices"><InvoiceDetail /></RequireFeature>
      </Route>
      <Route path="/helpdesk/admin">
        <RequireFeature feature="helpdeskAdmin"><HelpdeskAdmin /></RequireFeature>
      </Route>
      <Route path="/staff">
        <StaffAdminPage />
      </Route>
      <Route path="/dispatch-settings">
        <LegacyDispatchSettingsRedirect />
      </Route>
      <Route path="/staff-access">
        <Redirect to="/staff?tab=access" />
      </Route>
      <Route path="/marketplace">
        <RequireFeature feature="marketplace"><MarketplaceAdminPage /></RequireFeature>
      </Route>
      <Route path="/provider-health">
        {ownerAccessOverride
          ? <OwnerRouteGuard {...ownerAccessOverride}><ProviderHealthPage /></OwnerRouteGuard>
          : <RequireOwner><ProviderHealthPage /></RequireOwner>}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

export function OwnerRouteGuard({
  children,
  isOwner,
  isLoading,
}: {
  children: React.ReactNode;
  isOwner: boolean;
  isLoading: boolean;
}) {
  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Checking access…</div>;
  if (isOwner) return <>{children}</>;

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border bg-white p-8 text-center shadow-sm">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-csd-red" />
        <h1 className="text-xl font-semibold">Owner access required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Provider health settings are available only to account owners.
        </p>
      </div>
    </div>
  );
}
function RequireOwner({ children }: { children: React.ReactNode }) {
  const { isAdmin, isLoading } = useAdminAccess();
  return <OwnerRouteGuard isOwner={isAdmin} isLoading={isLoading}>{children}</OwnerRouteGuard>;
}

function RequireFeature({ feature, children }: { feature: StaffFeature; children: React.ReactNode }) {
  const { can, isLoading } = useAdminAccess();

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Checking access…</div>;
  if (can(feature)) return <>{children}</>;

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border bg-white p-8 text-center shadow-sm">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-csd-red" />
        <h1 className="text-xl font-semibold">Feature approval required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your role does not currently include this feature. Ask the account owner
          to approve access in Staff Roles &amp; Access.
        </p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [location] = useLocation();
  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center text-gray-500">
        Loading…
      </div>
    );
  }

  return isSignedIn
    ? <>{children}</>
    : <Redirect to={`/sign-in?redirect=${encodeURIComponent(location)}`} />;
}

function RequireApproved({ children }: { children: React.ReactNode }) {
  const { approvalStatus, isLoading } = useAdminAccess();
  if (isLoading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">Checking account approval…</div>;
  }
  if (approvalStatus === "approved") return <>{children}</>;
  const suspended = approvalStatus === "suspended";
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-lg rounded-xl border bg-white p-8 text-center shadow-sm">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-csd-red" />
        <h1 className="text-xl font-semibold">{suspended ? "Account access suspended" : "Account approval pending"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {suspended
            ? "The account owner has suspended this staff account. Contact the owner if access should be restored."
            : "An account owner must approve your staff account and assigned features before you can use the platform."}
        </p>
      </div>
    </div>
  );
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
  "/portal/marketplace",
  "/download",
  "/computer-repair-lauderhill",
  "/gaming-computers-lauderhill",
  "/virus-removal-lauderhill",
];

function Router() {
  const [location] = useLocation();
  const [formFieldFocused, setFormFieldFocused] = useState(false);
  const [supportChatOpen, setSupportChatOpen] = useState(false);
  const showSupportChat = SUPPORT_CHAT_PATHS.includes(location);
  // Keep the final controls on every chat-enabled page scrollable above the mobile launcher.
  const chatFormPage = ["/intake", "/web-app-intake", "/portal/ticket"].includes(location);

  useEffect(() => {
    setFormFieldFocused(false);
    if (!showSupportChat) setSupportChatOpen(false);
  }, [location, showSupportChat]);

  return (
    <>
      <div
        className={showSupportChat
          ? `${supportChatOpen ? "pb-[75dvh]" : "pb-24"} sm:pb-0 ${
              location === "/portal/marketplace" ? "bg-zinc-950"
                : chatFormPage ? (location === "/web-app-intake" ? "bg-white" : "bg-gray-50")
                : ""
            }`
          : "contents"}
        onFocusCapture={(event) => {
          const target = event.target;
          setFormFieldFocused(
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement,
          );
        }}
        onBlurCapture={() => setFormFieldFocused(false)}
      >
      <Switch>
        {/* Public routes - no layout */}
        <Route path="/">
          <Show when="signed-in"><Redirect to="/dashboard" /></Show>
          <Show when="signed-out"><LandingPage /></Show>
        </Route>
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/staff-invite" component={StaffInviteLanding} />
        <Route path="/intake" component={CsdIntakePage} />
        <Route path="/web-app-intake" component={WebAppIntakePage} />
        <Route path="/embed" component={EmbedPage} />
        <Route path="/privacy" component={PrivacyPage} />
        <Route path="/scam-check-guide" component={ScamCheckGuidePage} />
        <Route path="/portal" component={PortalHome} />
        <Route path="/portal/ticket" component={CustomerPortal} />
        <Route path="/portal/contract" component={PortalContract} />
        <Route path="/portal/marketplace" component={MarketplaceBrowse} />
        <Route path="/portal/marketplace/offers/:id" component={CatalogOffer} />
        <Route path="/portal/marketplace/sell" component={MarketplaceSellPage} />
        <Route path="/portal/marketplace/manage/:token" component={MarketplaceManagePage} />
        <Route path="/portal/marketplace/:id" component={MarketplaceListingPage} />
        <Route path="/download" component={DownloadAgentPage} />
        <Route path="/computer-repair-lauderhill"><LocalServicePage service="computer-repair" /></Route>
        <Route path="/gaming-computers-lauderhill"><LocalServicePage service="gaming-computers" /></Route>
        <Route path="/virus-removal-lauderhill"><LocalServicePage service="virus-removal" /></Route>
        <Route path="/local-seo-services" component={LocalSeoServicesPage} />
        <Route path="/pay/invoice/:token" component={PublicInvoice} />
        <Route path="/invoice/:token" component={PublicInvoice} />
        <Route path="/sign/contract/:token" component={PublicContract} />

        {/* Admin routes - with layout, gated behind login */}
        <Route>
          <RequireAuth>
            <Layout>
              <RequireApproved><AdminRouter /></RequireApproved>
            </Layout>
          </RequireAuth>
        </Route>
      </Switch>
      </div>
      {showSupportChat && <SupportChatWidget hideLauncherOnMobile={chatFormPage && formFieldFocused} onOpenChange={setSupportChatOpen} />}
    </>
  );
}

function App() {
  const [, setLocation] = useLocation();
  return (
    <ErrorBoundary>
      <ThemeProvider>
      <ClerkProvider
        publishableKey={clerkPubKey}
        proxyUrl={clerkProxyUrl}
        appearance={clerkAppearance}
        signInUrl={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/staff-invite`}
        localization={{
          signIn: { start: { title: "Welcome back", subtitle: "Sign in to access the CSD Platform" } },
          signUp: { start: { title: "Create your account", subtitle: "Get started with CSD Platform" } },
        }}
        routerPush={(to) => setLocation(stripBase(to))}
        routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
      >
        <QueryClientProvider client={queryClient}>
          <ClerkQueryClientCacheInvalidator />
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </QueryClientProvider>
      </ClerkProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default function RootApp() {
  return <WouterRouter base={basePath}><App /></WouterRouter>;
}
