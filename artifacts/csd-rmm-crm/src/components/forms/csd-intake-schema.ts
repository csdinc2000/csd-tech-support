import { z } from "zod";

// Field definitions for the public repair intake form, shared by the manual
// form and the voice intake assistant so both use one set of rules.

// CSD Intake form validation schema
export const csdIntakeFormSchema = z.object({
  customerName: z.string().min(2, "Name must be at least 2 characters"),
  companyName: z.string().optional(),
  phoneNumber: z.string().min(10, "Please enter a valid phone number"),
  emailAddress: z.string().email("Please enter a valid email address"),
  streetAddress: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  contactPreference: z.enum(["call", "text", "email"], {
    required_error: "Please select your preferred contact method"
  }),
  serviceId: z.coerce.number().int().positive({ message: "Please select a service" }),
  deviceType: z.string().min(1, "Please select your device type"),
  deviceBrandModel: z.string().min(1, "Please enter your device brand and model"),
  operatingSystem: z.string().min(1, "Please select your operating system"),
  problemDescription: z.string().min(10, "Please describe your problem (minimum 10 characters)"),
  howDidYouHear: z.string().min(1, "Please tell us how you heard about us"),
  isFromActiveCall: z.boolean(),
  callNotes: z.string().optional(),
  scheduleNow: z.boolean(),
  // SMS consent is optional (must be voluntary) and defaults to unchecked.
  smsConsent: z.boolean().default(false),
});

export type CsdIntakeFormData = z.infer<typeof csdIntakeFormSchema>;

export const deviceTypeOptions = ["Laptop", "Desktop", "All-in-One", "Other"];
export const operatingSystemOptions = [
  "Windows 11", "Windows 10", "Windows 8/8.1", "Windows 7",
  "macOS (Mac)", "Chrome OS", "Linux", "Other",
];
export const howDidYouHearOptions = [
  "Google Search", "Existing Customer", "Referral from Friend/Family",
  "Flyer/Advertisement", "Social Media", "Yellow Pages", "Other",
];
