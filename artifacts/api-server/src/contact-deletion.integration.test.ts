import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  appointments,
  bookingAppointments,
  bookingServices,
  bookingStaff,
  crmContacts,
  crmDeals,
  crmInteractions,
  crmJobs,
  crmLeads,
  invoices,
  serviceLog,
  services,
  serviceCategories,
  users,
} from "@workspace/db";
import { db, pool } from "./db.ts";
import { ContactDeletionConflictError, DatabaseStorage } from "./storage.ts";
import {
  DELETED_CONTACT_PLACEHOLDER_TAG,
  removeUnreferencedDeletedContactPlaceholders,
  reviewDeletedContactPlaceholders,
  reviewDeletedContactPlaceholdersWithRecords,
} from "./contact-placeholder-cleanup.ts";

const storage = new DatabaseStorage();
const marker = `contact-delete-${process.pid}-${Date.now()}`;
const contactIds: number[] = [];
const userIds: number[] = [];
const bookingStaffIds: string[] = [];
const bookingServiceIds: string[] = [];
const categoryIds: number[] = [];
const serviceIds: number[] = [];
const appointmentIds: number[] = [];

after(async () => {
  if (contactIds.length) {
    await db.delete(invoices).where(inArray(invoices.contactId, contactIds));
    await db.delete(bookingAppointments).where(inArray(bookingAppointments.clientId, contactIds));
    if (appointmentIds.length) await db.delete(appointments).where(inArray(appointments.id, appointmentIds));
    await db.delete(serviceLog).where(inArray(serviceLog.contactId, contactIds));
    await db.delete(crmInteractions).where(inArray(crmInteractions.contactId, contactIds));
    await db.delete(crmDeals).where(inArray(crmDeals.primaryContactId, contactIds));
    await db.delete(crmJobs).where(inArray(crmJobs.contactId, contactIds));
    await db.delete(crmLeads).where(inArray(crmLeads.contactId, contactIds));
    await db.delete(crmContacts).where(inArray(crmContacts.id, contactIds));
  }
  if (bookingStaffIds.length) await db.delete(bookingStaff).where(inArray(bookingStaff.id, bookingStaffIds));
  if (bookingServiceIds.length) await db.delete(bookingServices).where(inArray(bookingServices.id, bookingServiceIds));
  if (serviceIds.length) await db.delete(services).where(inArray(services.id, serviceIds));
  if (categoryIds.length) await db.delete(serviceCategories).where(inArray(serviceCategories.id, categoryIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await pool.end();
});

async function createContact(suffix: string) {
  const [contact] = await db.insert(crmContacts).values({ fullName: `${marker}-${suffix}` }).returning();
  contactIds.push(contact.id);
  return contact;
}

test("deleting a contact detaches optional links without erasing history", async () => {
  const contact = await createContact("optional");
  const [category] = await db.insert(serviceCategories).values({
    name: `${marker}-category`,
    slug: `${marker}-category`,
  }).returning();
  categoryIds.push(category.id);
  const [service] = await db.insert(services).values({
    categoryId: category.id,
    name: `${marker}-service`,
    slug: `${marker}-service`,
    durationMinutes: 30,
  }).returning();
  serviceIds.push(service.id);
  const [lead] = await db.insert(crmLeads).values({ contactId: contact.id, serviceType: "repair" }).returning();
  const [job] = await db.insert(crmJobs).values({ contactId: contact.id, jobNumber: marker }).returning();
  const [interaction] = await db.insert(crmInteractions).values({ contactId: contact.id, type: "note", summary: marker }).returning();
  const [deal] = await db.insert(crmDeals).values({ primaryContactId: contact.id, title: marker, companyName: marker }).returning();
  const [log] = await db.insert(serviceLog).values({ contactId: contact.id, clientName: marker, deviceModel: marker }).returning();
  const startsAt = new Date("2098-01-01T10:00:00Z");
  const [appointment] = await db.insert(appointments).values({
    reference: `${marker}-appointment`,
    serviceId: service.id,
    contactId: contact.id,
    customerName: marker,
    customerEmail: `${marker}@example.com`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
  }).returning();
  appointmentIds.push(appointment.id);

  assert.equal(await storage.deleteCrmContact(contact.id), true);
  assert.equal(await storage.getCrmContact(contact.id), undefined);
  assert.equal((await db.select().from(crmLeads).where(eq(crmLeads.id, lead.id)))[0].contactId, null);
  assert.equal((await db.select().from(crmJobs).where(eq(crmJobs.id, job.id)))[0].contactId, null);
  assert.equal((await db.select().from(crmInteractions).where(eq(crmInteractions.id, interaction.id)))[0].contactId, null);
  assert.equal((await db.select().from(crmDeals).where(eq(crmDeals.id, deal.id)))[0].primaryContactId, null);
  assert.equal((await db.select().from(serviceLog).where(eq(serviceLog.id, log.id)))[0].contactId, null);
  assert.equal((await db.select().from(appointments).where(eq(appointments.id, appointment.id)))[0].contactId, null);
});

test("an invoice blocks deletion and leaves every relationship unchanged", async () => {
  const contact = await createContact("invoice");
  const [lead] = await db.insert(crmLeads).values({ contactId: contact.id, serviceType: "repair" }).returning();
  const [invoice] = await db.insert(invoices).values({
    invoiceNumber: `${marker}-invoice`,
    contactId: contact.id,
    clientName: marker,
    subtotalCents: 100,
    taxCents: 0,
    totalCents: 100,
  }).returning();

  await assert.rejects(storage.deleteCrmContact(contact.id), ContactDeletionConflictError);
  assert.equal((await db.select().from(crmContacts).where(eq(crmContacts.id, contact.id))).length, 1);
  assert.equal((await db.select().from(crmLeads).where(eq(crmLeads.id, lead.id)))[0].contactId, contact.id);
  assert.equal((await db.select().from(invoices).where(eq(invoices.id, invoice.id)))[0].contactId, contact.id);
});

test("a required booking blocks deletion and leaves every relationship unchanged", async () => {
  const contact = await createContact("booking");
  const [lead] = await db.insert(crmLeads).values({ contactId: contact.id, serviceType: "repair" }).returning();
  const [user] = await db.insert(users).values({
    username: `${marker}-user`,
    password: "integration-test-only",
    email: `${marker}-user@example.com`,
  }).returning();
  userIds.push(user.id);
  const [staff] = await db.insert(bookingStaff).values({
    userId: user.id,
    displayName: marker,
    timezone: "UTC",
  }).returning();
  bookingStaffIds.push(staff.id);
  const [service] = await db.insert(bookingServices).values({ name: marker, durationMin: 30 }).returning();
  bookingServiceIds.push(service.id);
  const [booking] = await db.insert(bookingAppointments).values({
    staffId: staff.id,
    serviceId: service.id,
    clientId: contact.id,
    timeslot: "[\"2099-01-01 10:00:00+00\",\"2099-01-01 10:30:00+00\")",
    visibleStart: new Date("2099-01-01T10:00:00Z"),
    visibleEnd: new Date("2099-01-01T10:30:00Z"),
    status: "completed",
    clientTimezone: "UTC",
  }).returning();

  await assert.rejects(storage.deleteCrmContact(contact.id), ContactDeletionConflictError);
  assert.equal((await db.select().from(crmContacts).where(eq(crmContacts.id, contact.id))).length, 1);
  assert.equal((await db.select().from(crmLeads).where(eq(crmLeads.id, lead.id)))[0].contactId, contact.id);
  assert.equal((await db.select().from(bookingAppointments).where(and(
    eq(bookingAppointments.id, booking.id),
    eq(bookingAppointments.clientId, contact.id),
  ))).length, 1);
});

test("placeholder cleanup removes only rows with no relationships", async () => {
  const removable = await createContact("placeholder-unreferenced");
  const invoiceContact = await createContact("placeholder-invoice");
  const bookingContact = await createContact("placeholder-booking");
  await db.update(crmContacts)
    .set({ tags: DELETED_CONTACT_PLACEHOLDER_TAG })
    .where(inArray(crmContacts.id, [removable.id, invoiceContact.id, bookingContact.id]));

  const [invoice] = await db.insert(invoices).values({
    invoiceNumber: `${marker}-placeholder-invoice`,
    contactId: invoiceContact.id,
    clientName: marker,
    subtotalCents: 100,
    taxCents: 0,
    totalCents: 100,
  }).returning();
  const [user] = await db.insert(users).values({
    username: `${marker}-placeholder-user`,
    password: "integration-test-only",
    email: `${marker}-placeholder-user@example.com`,
  }).returning();
  userIds.push(user.id);
  const [staff] = await db.insert(bookingStaff).values({
    userId: user.id,
    displayName: `${marker}-placeholder`,
    timezone: "UTC",
  }).returning();
  bookingStaffIds.push(staff.id);
  const [service] = await db.insert(bookingServices).values({
    name: `${marker}-placeholder`,
    durationMin: 30,
  }).returning();
  bookingServiceIds.push(service.id);
  const [booking] = await db.insert(bookingAppointments).values({
    staffId: staff.id,
    serviceId: service.id,
    clientId: bookingContact.id,
    timeslot: "[\"2099-02-01 10:00:00+00\",\"2099-02-01 10:30:00+00\")",
    visibleStart: new Date("2099-02-01T10:00:00Z"),
    visibleEnd: new Date("2099-02-01T10:30:00Z"),
    status: "completed",
    clientTimezone: "UTC",
  }).returning();

  const client = await pool.connect();
  try {
    const before = await reviewDeletedContactPlaceholders(client);
    assert.equal(before.find((row) => row.id === removable.id)?.totalReferences, 0);
    assert.equal(
      before.find((row) => row.id === invoiceContact.id)?.references
        .find((reference) => reference.tableName === "invoices")?.count,
      1,
    );
    assert.equal(
      before.find((row) => row.id === bookingContact.id)?.references
        .find((reference) => reference.tableName === "booking_appointments")?.count,
      1,
    );

    const detailed = await reviewDeletedContactPlaceholdersWithRecords(client);
    const invoiceReview = detailed.find((row) => row.id === invoiceContact.id);
    const invoiceReference = invoiceReview?.references.find((reference) => reference.tableName === "invoices");
    assert.equal(invoiceReference?.records[0]?.label, invoice.invoiceNumber);
    assert.equal(invoiceReference?.records[0]?.href, `/invoices/${invoice.id}`);

    const bookingReview = detailed.find((row) => row.id === bookingContact.id);
    const bookingReference = bookingReview?.references.find(
      (reference) => reference.tableName === "booking_appointments",
    );
    assert.equal(bookingReference?.records[0]?.href, null);

    const result = await removeUnreferencedDeletedContactPlaceholders(client);
    assert.deepEqual(result.removedIds, [removable.id]);
  } finally {
    client.release();
  }

  assert.equal((await db.select().from(crmContacts).where(eq(crmContacts.id, removable.id))).length, 0);
  assert.equal((await db.select().from(invoices).where(eq(invoices.id, invoice.id)))[0].contactId, invoiceContact.id);
  assert.equal(
    (await db.select().from(bookingAppointments).where(eq(bookingAppointments.id, booking.id)))[0].clientId,
    bookingContact.id,
  );
});