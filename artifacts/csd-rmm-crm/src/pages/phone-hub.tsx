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
  const activeTab = PATH_TO_TAB[location] ?? "messages";
  const canViewVoicemails = isAdmin || capabilities.viewVoicemails;
  const restrictedTab =
    activeTab !== "messages" && !(activeTab === "voicemails" && canViewVoicemails);

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
          <TabsTrigger value="messages" data-testid="tab-messages" className="shrink-0">
            <MessageCircle className="mr-2 h-4 w-4" />
            Inbox &amp; SMS
          </TabsTrigger>
          {isAdmin && (
            <>
              <TabsTrigger value="calls" data-testid="tab-call-tracking" className="shrink-0">
                <BarChart3 className="mr-2 h-4 w-4" />
                Calls &amp; Tracking
              </TabsTrigger>
              <TabsTrigger value="configuration" data-testid="tab-phone-settings" className="shrink-0">
                <Phone className="mr-2 h-4 w-4" />
                Main Line Setup
              </TabsTrigger>
            </>
          )}
          {canViewVoicemails && (
            <TabsTrigger value="voicemails" data-testid="tab-voicemails" className="shrink-0">
              <Voicemail className="mr-2 h-4 w-4" />
              Voicemails
            </TabsTrigger>
          )}
        </TabsList>

        {!isAdmin && restrictedTab && (
          <div className="mt-6 rounded-xl border bg-card p-8 text-center shadow-sm">
            <ShieldAlert className="mx-auto mb-3 h-9 w-9 text-csd-red" />
            <h2 className="text-lg font-semibold">Administrator access required</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              This feature is not enabled for your staff account.
            </p>
          </div>
        )}

        <TabsContent value="messages" className="mt-4">
          <MessagesPage />
        </TabsContent>
        {isAdmin && (
          <>
            <TabsContent value="calls" className="mt-4">
              <CallTrackingPage />
            </TabsContent>
            <TabsContent value="configuration" className="mt-4">
              <PhoneSettingsPage
                defaultTab="numbers"
                visibleTabs={["numbers", "callflow", "voicemail", "sms"]}
                embedded
              />
            </TabsContent>
          </>
        )}
        {canViewVoicemails && (
          <TabsContent value="voicemails" className="mt-4">
            <VoicemailsList />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
