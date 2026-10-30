// Seed default services, resources, and business hours so the booking flow
// works out of the box. Idempotent — re-running will not duplicate rows.

import { storage } from "../storage";

const TIMEZONE = "America/New_York";

// Mirrors the existing CSD intake-form serviceTypeOptions, plus pricing/duration
// estimates appropriate for an MSP repair shop.
const DEFAULT_SERVICES = [
  {
    slug: "desktop-laptop-repair",
    name: "Desktop / Laptop Repair",
    description: "Diagnose and repair hardware or software issues on a desktop or laptop.",
    durationMinutes: 60,
    bufferAfterMinutes: 15,
    basePriceCents: 9900,
    depositType: "flat" as const,
    depositAmountCents: 2500,
  },
  {
    slug: "virus-spyware-removal",
    name: "Virus / Spyware Removal",
    description: "Full malware scan, removal, and post-clean hardening.",
    durationMinutes: 90,
    bufferAfterMinutes: 15,
    basePriceCents: 12900,
    depositType: "flat" as const,
    depositAmountCents: 2500,
  },
  {
    slug: "data-backup-recovery",
    name: "Data Backup / Recovery",
    description: "Recover or back up data from a working or failing drive.",
    durationMinutes: 60,
    bufferAfterMinutes: 15,
    basePriceCents: 14900,
    depositType: "percent" as const,
    depositPercent: 50,
  },
  {
    slug: "network-wifi-issue",
    name: "Network / Wi-Fi Issue",
    description: "Troubleshoot home or office network and Wi-Fi connectivity.",
    durationMinutes: 60,
    basePriceCents: 8900,
    depositType: "flat" as const,
    depositAmountCents: 2500,
  },
  {
    slug: "printer-peripheral-issue",
    name: "Printer / Peripheral Issue",
    description: "Diagnose printers, scanners, and other peripherals.",
    durationMinutes: 45,
    basePriceCents: 7900,
    depositType: "none" as const,
  },
  {
    slug: "new-pc-setup-tuneup",
    name: "New PC Setup / Tune-Up",
    description: "Configure a new computer or optimize an existing one.",
    durationMinutes: 90,
    bufferAfterMinutes: 15,
    basePriceCents: 11900,
    depositType: "flat" as const,
    depositAmountCents: 2500,
  },
  {
    slug: "consultation",
    name: "Consultation",
    description: "30-minute consultation to discuss your IT needs.",
    durationMinutes: 30,
    basePriceCents: 0,
    depositType: "none" as const,
  },
];

// Default working window for the depot: Mon–Fri 5 PM – 11 PM (matches the
// existing intake page's footer text).
const DEFAULT_BUSINESS_HOURS = [1, 2, 3, 4, 5].map(dow => ({
  dayOfWeek: dow,
  startTime: "17:00",
  endTime: "23:00",
  isClosed: false,
}));

export async function seedBookingDefaults(): Promise<{
  resourceId: number;
  technicianTagId: number;
  serviceCount: number;
}> {
  // Tag for the staff pool that can take repair appointments
  let tag = await storage.getResourceTagBySlug("technician");
  if (!tag) {
    tag = await storage.createResourceTag({
      slug: "technician",
      label: "Technician",
      description: "Staff who can perform repair, recovery, and consultation work.",
    });
  }

  // Default resource — a single bench that satisfies all bookings until the
  // user adds individual technicians.
  const resources = await storage.getBookingResources();
  let resource = resources.find(r => r.name === "Main Bench");
  if (!resource) {
    resource = await storage.createBookingResource({
      type: "staff",
      name: "Main Bench",
      description: "Default resource — represents the depot's available service capacity.",
      timezone: TIMEZONE,
      isActive: true,
      capacity: 1,
      colorHex: "#dc2626",
    });
    await storage.assignResourceTag(resource.id, tag.id);
  }

  // Business hours — only insert if none exist for this resource
  const existingHours = await storage.getBusinessHoursForResource(resource.id);
  if (existingHours.length === 0) {
    for (const h of DEFAULT_BUSINESS_HOURS) {
      await storage.createBusinessHours({
        resourceId: resource.id,
        dayOfWeek: h.dayOfWeek,
        startTime: h.startTime,
        endTime: h.endTime,
        isClosed: h.isClosed,
      });
    }
  }

  // Services — insert any missing slugs and wire each to a "needs 1 technician" requirement
  let created = 0;
  for (const svc of DEFAULT_SERVICES) {
    const existing = await storage.getServiceBySlug(svc.slug);
    if (existing) continue;

    const inserted = await storage.createService({
      categoryId: undefined as any,
      name: svc.name,
      slug: svc.slug,
      description: svc.description,
      durationMinutes: svc.durationMinutes,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: svc.bufferAfterMinutes ?? 0,
      basePriceCents: svc.basePriceCents,
      depositType: svc.depositType,
      depositAmountCents: (svc as any).depositAmountCents ?? 0,
      depositPercent: (svc as any).depositPercent ?? 0,
      enforceHighRiskPrepay: true,
      minLeadTimeMinutes: 60,
      maxAdvanceDays: 60,
      isActive: true,
      isPubliclyBookable: true,
    });

    await storage.createServiceRequirement({
      serviceId: inserted.id,
      tagId: tag.id,
      quantity: 1,
      customerSelectable: false,
    });
    created += 1;
  }

  return { resourceId: resource.id, technicianTagId: tag.id, serviceCount: created };
}
