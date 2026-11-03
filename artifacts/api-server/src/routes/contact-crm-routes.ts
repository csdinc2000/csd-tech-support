import type { Express, Request } from "express";
import { ContactDeletionConflictError, storage } from "../storage";
import {
  getStaffAssignmentScope,
  type StaffAssignmentScope,
} from "../staff-access";
import { isAdminUser } from "../security";
import { normalizeOptionalClientId } from "../customer-link-core";
import { insertCrmContactSchema, insertCrmInteractionSchema } from "@workspace/db";
import { z } from "zod/v4";
import { invalidContactPhone } from "../phone-validation";

export type ContactCrmRouteContext = {
  canSeeClient: (scope: StaffAssignmentScope, clientId: number | null | undefined) => boolean;
  canSeeContact: (scope: StaffAssignmentScope, contactId: number | null | undefined) => boolean;
  canEditContact: (scope: StaffAssignmentScope, contactId: number | null | undefined) => boolean;
};

export function registerContactCrmRoutes(app: Express, context: ContactCrmRouteContext): void {
  const { canSeeClient, canSeeContact, canEditContact } = context;

  app.get("/api/crm/contacts", async (req, res): Promise<any> => {
    try {
      const { search } = req.query;
      let contacts;
      if (search && typeof search === 'string') {
        contacts = await storage.searchCrmContacts(search);
      } else {
        contacts = await storage.getCrmContacts();
      }
      const scope = await getStaffAssignmentScope(req);
      contacts = contacts.filter((contact) => canSeeContact(scope, contact.id));
      res.json(contacts.map((contact) => ({
        ...contact,
        canEdit: canEditContact(scope, contact.id),
      })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.get("/api/crm/contacts/:id", async (req, res): Promise<any> => {
    try {
      const contact = await storage.getCrmContact(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      if (!contact || !canSeeContact(scope, contact.id)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      res.json({ ...contact, canEdit: canEditContact(scope, contact.id) });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch contact" });
    }
  });

  app.post("/api/crm/contacts", async (req, res): Promise<any> => {
    try {
      const phoneError = invalidContactPhone(req.body);
      if (phoneError) {
        res.status(400).json({ error: phoneError });
        return;
      }
      const normalized = normalizeOptionalClientId(req.body?.clientId, Object.prototype.hasOwnProperty.call(req.body ?? {}, "clientId"));
      if (normalized.kind === "invalid") {
        res.status(400).json({ error: normalized.message });
        return;
      }
      const contactData = insertCrmContactSchema.parse({ ...req.body, clientId: normalized.kind === "id" ? normalized.clientId : null });
      if (contactData.clientId != null && !(await storage.getClient(contactData.clientId))) {
        res.status(400).json({ error: "Client account not found" });
        return;
      }
      const scope = await getStaffAssignmentScope(req);
      if (!scope.unrestricted) {
        res.status(403).json({ error: "Administrator access required to create contacts" });
        return;
      }
      const contact = await storage.createCrmContact(contactData);
      res.status(201).json({ ...contact, canEdit: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid contact data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  const updateContact = async (req: Request, res: any) => {
    try {
      const id = parseInt(String(req.params.id));
      const existing = await storage.getCrmContact(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !canSeeContact(scope, existing.id)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!canEditContact(scope, existing.id)) {
        res.status(403).json({ error: "Contact edit assignment required" });
        return;
      }
      const phoneError = invalidContactPhone(req.body);
      if (phoneError) {
        res.status(400).json({ error: phoneError });
        return;
      }
      const update = { ...req.body };
      const normalized = normalizeOptionalClientId(update.clientId, Object.prototype.hasOwnProperty.call(update, "clientId"));
      if (normalized.kind === "invalid") {
        res.status(400).json({ error: normalized.message });
        return;
      }
      if (normalized.kind === "unlink") update.clientId = null;
      if (normalized.kind === "id") update.clientId = normalized.clientId;
      if (update.clientId != null && !(await storage.getClient(update.clientId))) {
        res.status(400).json({ error: "Client account not found" });
        return;
      }
      if (!canSeeClient(scope, update.clientId ?? existing.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      const contact = await storage.updateCrmContact(id, update);
      if (!contact) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      res.json(contact);
    } catch (error) {
      res.status(500).json({ error: "Failed to update contact" });
    }
  };
  app.put("/api/crm/contacts/:id", updateContact);
  app.patch("/api/crm/contacts/:id", updateContact);

  app.delete("/api/crm/contacts/:id", async (req, res): Promise<any> => {
    try {
      if (!isAdminUser(req)) {
        res.status(403).json({ error: "Administrator access required" });
        return;
      }
      const id = parseInt(req.params.id);
      const ok = await storage.deleteCrmContact(id);
      if (!ok) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      if (error instanceof ContactDeletionConflictError) {
        res.status(409).json({ error: "Cannot delete contact: invoice or booking history requires this contact." });
        return;
      }
      req.log.error({ err: error }, "Delete contact failed");
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  app.post("/api/crm/contacts/find-or-create", async (req, res): Promise<any> => {
    try {
      const phoneError = invalidContactPhone(req.body);
      if (phoneError) {
        res.status(400).json({ error: phoneError });
        return;
      }
      const { fullName, mobilePhone, email, ...rest } = req.body;
      const normalized = normalizeOptionalClientId(rest.clientId, Object.prototype.hasOwnProperty.call(req.body ?? {}, "clientId"));
      if (normalized.kind === "invalid") {
        res.status(400).json({ error: normalized.message });
        return;
      }
      rest.clientId = normalized.kind === "id" ? normalized.clientId : null;
      if (rest.clientId != null && !(await storage.getClient(rest.clientId))) {
        res.status(400).json({ error: "Client account not found" });
        return;
      }
      const scope = await getStaffAssignmentScope(req);
      if (!canSeeClient(scope, rest.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      let contact = await storage.getCrmContactByPhoneOrEmail(mobilePhone, email);
      if (contact && !canSeeClient(scope, contact.clientId)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!contact) contact = await storage.createCrmContact(insertCrmContactSchema.parse({ fullName, mobilePhone, email, ...rest }));
      res.json(contact);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid contact data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to find or create contact" });
    }
  });

  const interactionContactId = async (interaction: any): Promise<number | null> => {
    if (interaction?.contactId != null) return Number(interaction.contactId);
    if (interaction?.leadId != null) return (await storage.getCrmLead(Number(interaction.leadId)))?.contactId ?? null;
    if (interaction?.jobId != null) return (await storage.getCrmJob(Number(interaction.jobId)))?.contactId ?? null;
    return null;
  };

  app.get("/api/crm/interactions", async (req, res): Promise<any> => {
    try {
      const { contactId, leadId, jobId } = req.query;
      let interactions;
      if (contactId) interactions = await storage.getCrmInteractionsByContact(parseInt(contactId as string));
      else if (leadId) interactions = await storage.getCrmInteractionsByLead(parseInt(leadId as string));
      else if (jobId) interactions = await storage.getCrmInteractionsByJob(parseInt(jobId as string));
      else interactions = await storage.getCrmInteractions();
      const scope = await getStaffAssignmentScope(req);
      const visible = (await Promise.all(interactions.map(async (interaction) =>
        canSeeContact(scope, await interactionContactId(interaction)) ? interaction : null
      ))).filter(Boolean);
      res.json(visible);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch interactions" });
    }
  });

  app.get("/api/crm/interactions/:id", async (req, res): Promise<any> => {
    try {
      const interaction = await storage.getCrmInteraction(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      if (!interaction || !canSeeContact(scope, await interactionContactId(interaction))) {
        res.status(404).json({ error: "Interaction not found" });
        return;
      }
      res.json(interaction);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch interaction" });
    }
  });

  app.post("/api/crm/interactions", async (req, res): Promise<any> => {
    try {
      const interactionData = insertCrmInteractionSchema.parse(req.body);
      const scope = await getStaffAssignmentScope(req);
      const contactId = await interactionContactId(interactionData);
      if (!canSeeContact(scope, contactId)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!canEditContact(scope, contactId)) {
        res.status(403).json({ error: "Contact edit assignment required" });
        return;
      }
      const interaction = await storage.createCrmInteraction(interactionData);
      res.status(201).json(interaction);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid interaction data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create interaction" });
    }
  });
}