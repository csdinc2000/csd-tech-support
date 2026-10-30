import { useState } from "react";
import { Users, Building2 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import CrmContacts from "@/pages/crm-contacts";
import Clients from "@/pages/clients";

/**
 * Unified Contacts hub — merges the former "Contacts" (CRM people, Google
 * People sync) and "Client Management" (service/billing companies) pages into a
 * single tabbed view so there's one place to find anyone. Each tab renders the
 * existing page component unchanged.
 */
export default function ContactsHub() {
  const [tab, setTab] = useState("contacts");

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
        <p className="text-sm text-muted-foreground">
          People and the companies they belong to — all in one place.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="contacts" data-testid="tab-contacts">
            <Users className="mr-2 h-4 w-4" />
            Contacts
          </TabsTrigger>
          <TabsTrigger value="clients" data-testid="tab-clients">
            <Building2 className="mr-2 h-4 w-4" />
            Clients
          </TabsTrigger>
        </TabsList>

        <TabsContent value="contacts" className="mt-4">
          <CrmContacts />
        </TabsContent>
        <TabsContent value="clients" className="mt-4">
          <Clients />
        </TabsContent>
      </Tabs>
    </div>
  );
}
