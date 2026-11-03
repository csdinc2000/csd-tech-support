import { z } from "zod";

// Field definitions for the public repair intake form, shared by the manual
// form and the voice intake assistant so both use one set of rules.

// CSD Intake form validation schema
const phoneNumberSchema = z.string().trim().default("").refine((value) => {
  if (!value) return true;
  if (!/^\+?[0-9().\-\s]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}, "Please enter a valid phone number");

const emailAddressSchema = z.string().trim().default("").refine((value) => {
  return !value || z.string().email().safeParse(value).success;
}, "Please enter a valid email address");

export const csdIntakeFieldSchema = z.object({
  customerName: z.string().trim().min(1, "Please enter your name"),
  companyName: z.string().trim().default(""),
  phoneNumber: phoneNumberSchema,
  emailAddress: emailAddressSchema,
  streetAddress: z.string().trim().default(""),
  city: z.string().trim().default(""),
  state: z.string().trim().default(""),
  zip: z.string().trim().default(""),
  contactPreference: z.enum(["call", "text", "email"]).default("call"),
  serviceId: z.coerce.number().int().positive({ message: "Please select a service" }),
  deviceType: z.string().trim().min(1, "Please select your device type"),
  deviceBrandModel: z.string().trim().default(""),
  operatingSystem: z.string().trim().default(""),
  problemDescription: z.string().trim().min(1, "Please briefly describe the problem"),
  howDidYouHear: z.string().trim().default(""),
  isFromActiveCall: z.boolean().default(false),
  callNotes: z.string().trim().default(""),
  scheduleNow: z.boolean().default(false),
  // SMS consent is optional (must be voluntary) and defaults to unchecked.
  smsConsent: z.boolean().default(false),
});

export const csdIntakeFormSchema = csdIntakeFieldSchema.superRefine((data, context) => {
  if (!data.phoneNumber && !data.emailAddress) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["phoneNumber"],
      message: "Enter a phone number or email address.",
    });
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["emailAddress"],
      message: "Enter a phone number or email address.",
    });
    return;
  }

  if (data.contactPreference === "email" && !data.emailAddress) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["emailAddress"],
      message: "Add an email address for email contact.",
    });
  } else if (data.contactPreference !== "email" && !data.phoneNumber) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["phoneNumber"],
      message: "Add a phone number for calls or text messages.",
    });
  }
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
