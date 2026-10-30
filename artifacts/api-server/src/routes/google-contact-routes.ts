import type { Express } from "express";
import { storage } from "../storage";
import { getStaffAssignmentScope, requireStaffAdministrator, type StaffAssignmentScope } from "../staff-access";

type GoogleContact = {
  fullName: string;
  email?: string | null;
  mobilePhone?: string | null;
  officePhone?: string | null;
  company?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  notes?: string | null;
  googleContactId?: string | null;
};

export type GoogleContactsRouteService = {
  getStatus(): { configured: boolean; [key: string]: unknown };
  getAuthUrl(): string | null;
  handleAuthCallback(code: string): Promise<unknown>;
  createContact(contact: GoogleContact): Promise<{ resourceName: string } | null>;
  listAllContacts(): Promise<GoogleContact[]>;
  getContactCount(): Promise<number>;
};

export type GoogleContactRouteOptions = {
  googleContactsService: GoogleContactsRouteService;
  canSeeContact: (scope: StaffAssignmentScope, contactId: number | null | undefined) => boolean;
  canEditContact: (scope: StaffAssignmentScope, contactId: number | null | undefined) => boolean;
};

export function registerGoogleContactRoutes(app: Express, options: GoogleContactRouteOptions): void {
  const { googleContactsService, canSeeContact, canEditContact } = options;

  // Google Contacts OAuth & Sync endpoints
  app.get("/api/google/status", async (req, res) => {
    try {
      const status = googleContactsService.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: "Failed to get Google Contacts status" });
    }
  });

  app.get("/api/google/auth-url", async (req, res): Promise<void> => {
    try {
      const authUrl = googleContactsService.getAuthUrl();
      if (!authUrl) {
        res.status(400).json({
          error: "Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets first."
        });
        return;
      }
      res.json({ authUrl });
    } catch (error) {
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  });

  app.get("/api/google/callback", async (req, res): Promise<void> => {
    try {
      const code = req.query.code as string;
      if (!code) {
        res.status(400).json({ error: "No authorization code provided" });
        return;
      }
      await googleContactsService.handleAuthCallback(code);
      console.log("Google OAuth completed successfully. Session is now active.");
      res.send(`
        <html>
          <head><title>Google Contacts Connected</title></head>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Google Contacts Connected Successfully!</h1>
            <p>Your Google account is now connected for this session.</p>
            <p style="color: #666; font-size: 14px;">
              For permanent access, check the server logs and add the tokens as secrets:
              <br>GOOGLE_ACCESS_TOKEN and GOOGLE_REFRESH_TOKEN
            </p>
            <p><a href="/crm/contacts" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #4285f4; color: white; text-decoration: none; border-radius: 4px;">Return to CRM Contacts</a></p>
          </body>
        </html>
      `);
    } catch (error: any) {
      res.status(500).send(`
        <html>
          <head><title>OAuth Error</title></head>
          <body style="font-family: sans-serif; padding: 40px;">
            <h1>OAuth Error</h1>
            <p>${error.message}</p>
            <a href="/crm/contacts">Return to CRM Contacts</a>
          </body>
        </html>
      `);
    }
  });

  app.post("/api/google/sync-contact/:contactId", async (req, res): Promise<void> => {
    try {
      const contactId = parseInt(req.params.contactId);
      const contact = await storage.getCrmContact(contactId);
      const scope = await getStaffAssignmentScope(req);
      if (!contact || !canSeeContact(scope, contactId)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!canEditContact(scope, contactId)) {
        res.status(403).json({ error: "Contact edit assignment required" });
        return;
      }
      const result = await googleContactsService.createContact({
        fullName: contact.fullName, email: contact.email, mobilePhone: contact.mobilePhone,
        officePhone: contact.officePhone, company: contact.company, address: contact.address,
        city: contact.city, state: contact.state, zipCode: contact.zipCode, notes: contact.notes,
      });
      if (result) {
        await storage.updateCrmContact(contactId, { googleContactId: result.resourceName });
        res.json({ success: true, resourceName: result.resourceName });
      } else {
        res.status(400).json({ error: "Google Contacts not configured. Complete OAuth setup first." });
      }
    } catch (error: any) {
      console.error("Google sync error:", error);
      res.status(500).json({ error: error.message || "Failed to sync contact" });
    }
  });

  app.post("/api/google/sync-all-contacts", requireStaffAdministrator, async (req, res) => {
    try {
      const contacts = await storage.getCrmContacts();
      const results = { synced: 0, failed: 0, skipped: 0 };
      for (const contact of contacts) {
        if (contact.googleContactId) {
          results.skipped++;
          continue;
        }
        try {
          const result = await googleContactsService.createContact({
            fullName: contact.fullName, email: contact.email, mobilePhone: contact.mobilePhone,
            officePhone: contact.officePhone, company: contact.company, address: contact.address,
            city: contact.city, state: contact.state, zipCode: contact.zipCode, notes: contact.notes,
          });
          if (result) {
            await storage.updateCrmContact(contact.id, { googleContactId: result.resourceName });
            results.synced++;
          } else {
            results.failed++;
          }
        } catch (err) {
          results.failed++;
        }
      }
      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to sync contacts" });
    }
  });

  app.post("/api/google/import-contacts", requireStaffAdministrator, async (req, res): Promise<void> => {
    try {
      const status = googleContactsService.getStatus();
      if (!status.configured) {
        res.status(400).json({ error: "Google Contacts not configured. Complete OAuth setup first." });
        return;
      }
      const googleContacts = await googleContactsService.listAllContacts();
      const results = { imported: 0, skipped: 0, failed: 0 };
      for (const gContact of googleContacts) {
        try {
          const googleContactId = gContact.googleContactId;
          if (googleContactId) {
            const existingContact = await storage.getCrmContactByGoogleId(googleContactId);
            if (existingContact) {
              results.skipped++;
              continue;
            }
          }
          const existingByPhoneOrEmail = await storage.getCrmContactByPhoneOrEmail(
            gContact.mobilePhone || null, gContact.email || null
          );
          if (existingByPhoneOrEmail) {
            await storage.updateCrmContact(existingByPhoneOrEmail.id, { googleContactId });
            results.skipped++;
            continue;
          }
          await storage.createCrmContact({
            fullName: gContact.fullName, email: gContact.email, mobilePhone: gContact.mobilePhone,
            officePhone: gContact.officePhone, company: gContact.company, address: gContact.address,
            city: gContact.city, state: gContact.state, zipCode: gContact.zipCode,
            notes: gContact.notes, googleContactId,
          });
          results.imported++;
        } catch (err) {
          console.error("Failed to import contact:", err);
          results.failed++;
        }
      }
      res.json({ success: true, totalFromGoogle: googleContacts.length, ...results });
    } catch (error: any) {
      console.error("Google import error:", error);
      res.status(500).json({ error: error.message || "Failed to import contacts" });
    }
  });

  app.get("/api/google/contact-count", async (req, res) => {
    try {
      const count = await googleContactsService.getContactCount();
      res.json({ count });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get contact count" });
    }
  });
}