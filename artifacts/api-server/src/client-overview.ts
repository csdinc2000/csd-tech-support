/** Compact, intentionally allow-listed records for the account overview. */
export function overviewContact(contact: any) {
  return { id: contact.id, fullName: contact.fullName, email: contact.email, mobilePhone: contact.mobilePhone, officePhone: contact.officePhone, clientId: contact.clientId };
}
export function overviewJob(job: any, clientId: number) {
  return { id: job.id, jobNumber: job.jobNumber, contactId: job.contactId, clientId, serviceType: job.serviceType, status: job.status, scheduledDateTime: job.scheduledDateTime, createdAt: job.createdAt };
}
export function overviewInvoice(invoice: any) {
  return { id: invoice.id, invoiceNumber: invoice.invoice_number, contactId: invoice.contact_id, clientId: invoice.client_id, jobId: invoice.job_id, status: invoice.status, currency: invoice.currency, totalCents: invoice.total_cents, dueDate: invoice.due_date, sentAt: invoice.sent_at, paidAt: invoice.paid_at, createdAt: invoice.created_at };
}
export function overviewAppointment(appointment: any, clientId: number | null) {
  return { id: appointment.id, reference: appointment.reference, contactId: appointment.contactId, clientId, status: appointment.status, startsAt: appointment.startsAt, endsAt: appointment.endsAt, serviceId: appointment.serviceId, createdAt: appointment.createdAt };
}