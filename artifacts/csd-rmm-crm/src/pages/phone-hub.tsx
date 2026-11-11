import { useLocation } from "wouter";
import { MessageCircle, BarChart3, Phone, Voicemail, ShieldAlert } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAdminAccess } from "@/hooks/use-admin-access";
import MessagesPage from "@/pages/messages";
import CallTrackingPage from "@/pages/call-tracking";
import PhoneSettingsPage, { VoicemailsList } from "@/pages/phone-settings";

/**
 * Communications hub — one home for every customer communication surface. Merges the
 * former Messages inbox, Call Tracking console and Phone & SMS Settings into a
 * single tabbed view so there's one obvious place for anything telephony.
 *
 * Each tab renders the existing page component unchanged. The active tab is
 * derived from the URL so existing deep-links keep working:
 *   /messages            -> Messages
 *   /comms               -> Messages
 *   /admin/call-tracking -> Call Tracking
 *   /admin/phone         -> Phone Configuration
 */

const PATH_TO_TAB: Record<string, string> = {
  "/comms": "messages",
  "/messages": "messages",
  "/admin/call-tracking": "calls",
  "/admin/phone": "configuration",
  "/comms/voicemails": "voicemails",
  "/comms/config": "configuration",
};

const TAB_TO_PATH: Record<string, string> = {
  messages: "/messages",
  calls: "/admin/call-tracking",
  voicemails: "/comms/voicemails",
  configuration: "/admin/phone",
};

export default function PhoneHub() {
  const [location, setLocation] = useLocation();
  const { isAdmin, capabilities } = useAdminAccess();
  // Each tab follows its switch in Staff Access (owners have them all).
  const allowed: Record<string, boolean> = {
    messages: isAdmin || capabilities.smsInbox,
    calls: isAdmin || capabilities.callTracking,
    configuration: isAdmin || capabilities.mainLineSetup,
    voicemails: isAdmin || capabilities.viewVoicemails,
  };
  const requestedTab = PATH_TO_TAB[location] ?? "messages";
  // /comms opens the first tool this person can use.
  const activeTab = location === "/comms" && !allowed.messages
    ? (["calls", "configuration", "voicemails"].find((tab) => allowed[tab]) ?? "messages")
    : requestedTab;
  const restrictedTab = !allowed[activeTab];

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-csd-red">Service desk workspace</p>
        <h1 className="text-2xl font-bold tracking-tight">Communications</h1>
        <p className="text-sm text-muted-foreground">
          Messages, calls, voicemail, and line configuration in one operational workspace.
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(tab) => setLocation(TAB_TO_PATH[tab] ?? "/messages")}
        className="w-full"
      >
        <TabsList
          className="flex h-auto w-full justify-start gap-1 overflow-x-auto whitespace-nowrap rounded-lg p-1"
          aria-label="Communication tools"
        >
          {allowed.messages && (
            <TabsTrigger value="messages" data-testid="tab-messages" className="shrink-0">
              <MessageCircle className="mr-2 h-4 w-4" />
              Inbox &amp; SMS
            </TabsTrigger>
          )}
          {allowed.calls && (
            <TabsTrigger value="calls" data-testid="tab-call-tracking" className="shrink-0">
              <BarChart3 className="mr-2 h-4 w-4" />
              Calls &amp; Tracking
            </TabsTrigger>
          )}
          {allowed.configuration && (
            <TabsTrigger value="configuration" data-testid="tab-phone-settings" className="shrink-0">
              <Phone className="mr-2 h-4 w-4" />
              Main Line Setup
            </TabsTrigger>
          )}
          {allowed.voicemails && (
            <TabsTrigger value="voicemails" data-testid="tab-voicemails" className="shrink-0">
              <Voicemail className="mr-2 h-4 w-4" />
              Voicemails
            </TabsTrigger>
          )}
        </TabsList>

        {restrictedTab && (
          <div className="mt-6 rounded-xl border bg-card p-8 text-center shadow-sm" data-testid="comms-tool-locked">
            <ShieldAlert className="mx-auto mb-3 h-9 w-9 text-csd-red" />
            <h2 className="text-lg font-semibold">This tool isn't switched on for you</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Ask the account owner or a staff administrator to turn it on in Staff Administration → Roles &amp; Access.
            </p>
          </div>
        )}

        {allowed.messages && (
          <TabsContent value="messages" className="mt-4">
            <MessagesPage />
          </TabsContent>
        )}
        {allowed.calls && (
          <TabsContent value="calls" className="mt-4">
            <CallTrackingPage />
          </TabsContent>
        )}
        {allowed.configuration && (
          <TabsContent value="configuration" className="mt-4">
            <PhoneSettingsPage
              defaultTab="numbers"
              visibleTabs={["numbers", "callflow", "voicemail", "sms"]}
              embedded
            />
          </TabsContent>
        )}
        {allowed.voicemails && (
          <TabsContent value="voicemails" className="mt-4">
            <VoicemailsList />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
