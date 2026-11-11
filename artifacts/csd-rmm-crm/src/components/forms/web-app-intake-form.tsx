import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { z } from "zod";
import { CheckCircle2 } from "lucide-react";
import { SMS_CONSENT_TEXT, SMS_BUSINESS_PHONE } from "@/components/forms/csd-intake-form";
import { clearStoredReferralCode, storedReferralCode, storedUtmCampaign } from "@/lib/utm-capture";

// Website & App project intake. Posts to the same public POST /api/intake
// endpoint as the repair intake form, so a submission lands in the CRM as a
// Contact + Lead + Interaction and is auto-dispatched to a Job and a Ticket.
// The endpoint has no columns for project-specific answers (budget, timeline,
// feature list) — db:push is unavailable in this repl — so those are composed
// into the free-text `problem_description` brief instead of new schema fields.

const projectTypeOptions = [
  "New website",
  "Website redesign",
  "E-commerce store",
  "Mobile app (iOS / Android)",
  "Web app / customer portal",
  "Hosting, maintenance & security",
  "SEO & performance tuning",
  "Business email / domain setup",
];

const platformOptions = [
  "Website (responsive)",
  "Mobile app — iOS",
  "Mobile app — Android",
  "Mobile app — iOS & Android",
  "Web application / SaaS",
  "Website + companion app",
  "Not sure yet — need a recommendation",
];

const featureOptions = [
  "Online payments / checkout",
  "Booking & scheduling",
  "Customer accounts & logins",
  "Blog / CMS you can edit",
  "Contact & lead forms",
  "Live chat",
  "Analytics & SEO",
  "Third-party integrations (API)",
  "Admin dashboard / reporting",
  "Push or email notifications",
];

const budgetOptions = [
  "Under $2,500",
  "$2,500 – $5,000",
  "$5,000 – $10,000",
  "$10,000 – $25,000",
  "$25,000+",
  "Not sure — help me scope it",
];

const timelineOptions = [
  "ASAP / urgent",
  "Within 1 month",
  "1 – 3 months",
  "3 – 6 months",
  "Just exploring options",
];

const assetsOptions = [
  "Yes — logo, branding and copy are ready",
  "Partially — some assets ready",
  "No — I need design and content help",
];

const howDidYouHearOptions = [
  "Google Search",
  "Existing Customer",
  "Referral from Friend/Family",
  "Flyer/Advertisement",
  "Social Media",
  "Yellow Pages",
  "Other",
];

const webAppIntakeSchema = z
  .object({
    customerName: z.string().trim().min(2, "Name must be at least 2 characters"),
    companyName: z.string().trim().optional(),
    emailAddress: z.string().trim().email("Please enter a valid email address"),
    phoneNumber: z.string().trim().optional(),
    contactPreference: z.enum(["email", "call", "text"], {
      required_error: "Please select your preferred contact method",
    }),
    projectTypes: z.array(z.string()).min(1, "Please select at least one project type"),
    platform: z.string().min(1, "Please select what you want built"),
    currentWebsite: z.string().trim().optional(),
    projectDescription: z
      .string()
      .trim()
      .min(20, "Please give us at least a sentence or two about the project"),
    features: z.array(z.string()).default([]),
    budgetRange: z.string().min(1, "Please select a budget range"),
    timeline: z.string().min(1, "Please select a timeline"),
    assetsReady: z.string().min(1, "Please let us know what you already have"),
    howDidYouHear: z.string().min(1, "Please tell us how you heard about us"),
    smsConsent: z.boolean().default(false),
  })
  // A phone number is optional overall, but required when the customer asks to
  // be reached by phone or text.
  .refine((d) => d.contactPreference === "email" || !!d.phoneNumber?.length, {
    message: "Please add a phone number, or choose email as your contact method",
    path: ["phoneNumber"],
  })
  // Consent to texts is meaningless without a number to text.
  .refine((d) => !d.smsConsent || !!d.phoneNumber?.length, {
    message: "Enter a mobile number to opt in to text updates",
    path: ["smsConsent"],
  });

type WebAppIntakeFormData = z.infer<typeof webAppIntakeSchema>;

/**
 * Flattens the project answers into the free-text brief the intake endpoint
 * stores on the lead, the job and the helpdesk ticket. Keep it readable — a
 * technician reads this verbatim before the first call.
 */
function buildProjectBrief(data: WebAppIntakeFormData): string {
  const lines: string[] = [
    `Project goals:\n${data.projectDescription}`,
    "",
    `Build type: ${data.projectTypes.join(", ")}`,
    `Platform: ${data.platform}`,
    `Budget: ${data.budgetRange}`,
    `Timeline: ${data.timeline}`,
    `Branding & content: ${data.assetsReady}`,
    `Features requested: ${data.features.length ? data.features.join(", ") : "None specified"}`,
  ];
  if (data.companyName) lines.push(`Company: ${data.companyName}`);
  if (data.currentWebsite) lines.push(`Current site: ${data.currentWebsite}`);
  return lines.join("\n");
}

interface WebAppIntakeFormProps {
  className?: string;
  onSuccess?: (data: any) => void;
}

export default function WebAppIntakeForm({ className, onSuccess }: WebAppIntakeFormProps) {
  const { toast } = useToast();
  const [isSubmitted, setIsSubmitted] = useState(false);
  // Retained for transport retries; replaced once this logical submission succeeds.
  const intakeSubmissionId = useRef(crypto.randomUUID());

  const form = useForm<WebAppIntakeFormData>({
    resolver: zodResolver(webAppIntakeSchema),
    defaultValues: {
      customerName: "",
      companyName: "",
      emailAddress: "",
      phoneNumber: "",
      contactPreference: "email",
      projectTypes: [],
      platform: "",
      currentWebsite: "",
      projectDescription: "",
      features: [],
      budgetRange: "",
      timeline: "",
      assetsReady: "",
      howDidYouHear: "",
      smsConsent: false,
    },
  });

  const submitProject = useMutation({
    mutationFn: async (data: WebAppIntakeFormData) => {
      const res = await apiRequest("POST", "/api/intake", {
        full_name: data.customerName,
        intake_submission_id: intakeSubmissionId.current,
        company_name: data.companyName || "",
        mobile_phone: data.phoneNumber || "",
        email: data.emailAddress,
        preferred_contact_method: data.contactPreference,
        // Prefixed so these leads are instantly distinguishable from repair
        // intakes on the CRM pipeline and job boards.
        service_type: `Website & App — ${data.projectTypes.join(", ")}`,
        device_type: data.platform,
        problem_description: buildProjectBrief(data),
        how_did_you_hear_about_us: data.howDidYouHear,
        utm_campaign: storedUtmCampaign(),
        referral_code: storedReferralCode(),
        sms_consent: data.smsConsent,
        sms_consent_text: data.smsConsent ? SMS_CONSENT_TEXT : null,
      });
      return res.json();
    },
    onSuccess: (result) => {
      intakeSubmissionId.current = crypto.randomUUID();
      clearStoredReferralCode();
      setIsSubmitted(true);
      toast({
        title: "Project request received",
        description: "A CSD specialist will reach out within one business day.",
      });
      onSuccess?.(result);
    },
    onError: (error: any) => {
      toast({
        title: "Submission failed",
        description: error?.message || "Please try again, or call us at 954-637-7300.",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: WebAppIntakeFormData) => submitProject.mutate(data);

  if (isSubmitted) {
    return (
      <Card className={className} data-testid="card-webapp-intake-success">
        <CardContent className="p-6 text-center sm:p-10">
          <CheckCircle2 className="mx-auto h-14 w-14 text-green-600" />
          <h2 className="mt-4 text-2xl font-bold text-gray-900">Thanks — we've got your project.</h2>
          <p className="mt-2 text-gray-600">
            Your request is in front of our team and a specialist will contact you within one
            business day.
          </p>
          <div className="mx-auto mt-6 max-w-sm space-y-2 rounded-lg bg-gray-50 p-4 text-left text-sm text-gray-600">
            <p className="font-semibold text-gray-900">What happens next</p>
            <p>1. We review your goals, budget and timeline.</p>
            <p>2. We schedule a free 30-minute discovery call.</p>
            <p>3. You get a written scope, fixed quote and delivery plan.</p>
          </div>
          <p className="mt-6 text-sm text-gray-500">
            Want to talk sooner? Call{" "}
            <a href="tel:9546377300" className="font-semibold text-csd-red">
              954-637-7300
            </a>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-2xl">Tell us about your project</CardTitle>
        <CardDescription>
          A few details is all we need to prepare a realistic scope and quote. Fields marked * are
          required.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-10">
            {/* ---- Contact ---------------------------------------------- */}
            <section className="space-y-4">
              <h3 className="border-b pb-2 text-lg font-semibold text-gray-900">Your details</h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="customerName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full name *</FormLabel>
                      <FormControl>
                        <Input placeholder="John Smith" data-testid="input-name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="companyName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company / organization</FormLabel>
                      <FormControl>
                        <Input placeholder="Acme LLC" data-testid="input-company" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="emailAddress"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email address *</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          placeholder="john@example.com"
                          data-testid="input-email"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="phoneNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone number</FormLabel>
                      <FormControl>
                        <Input
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          placeholder="(954) 555-0123"
                          data-testid="input-phone"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="contactPreference"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Preferred contact method *</FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        value={field.value}
                        className="flex flex-wrap gap-x-6 gap-y-2"
                      >
                        {[
                          { value: "email", label: "Email" },
                          { value: "call", label: "Phone call" },
                          { value: "text", label: "Text message" },
                        ].map((opt) => (
                          <div key={opt.value} className="flex items-center space-x-2">
                            <RadioGroupItem value={opt.value} id={`contact-${opt.value}`} />
                            <label htmlFor={`contact-${opt.value}`} className="text-sm">
                              {opt.label}
                            </label>
                          </div>
                        ))}
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>

            {/* ---- Project -------------------------------------------- */}
            <section className="space-y-4">
              <h3 className="border-b pb-2 text-lg font-semibold text-gray-900">Your project</h3>

              <FormField
                control={form.control}
                name="projectTypes"
                render={() => (
                  <FormItem>
                    <FormLabel>What do you need? * (select all that apply)</FormLabel>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {projectTypeOptions.map((option) => (
                        <FormField
                          key={option}
                          control={form.control}
                          name="projectTypes"
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-3 hover:bg-gray-50">
                              <FormControl>
                                <Checkbox
                                  checked={field.value?.includes(option)}
                                  onCheckedChange={(checked) =>
                                    field.onChange(
                                      checked
                                        ? [...(field.value ?? []), option]
                                        : (field.value ?? []).filter((v) => v !== option),
                                    )
                                  }
                                />
                              </FormControl>
                              <FormLabel className="text-sm font-normal leading-snug">
                                {option}
                              </FormLabel>
                            </FormItem>
                          )}
                        />
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="platform"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>What are we building for? *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-platform">
                            <SelectValue placeholder="Select a platform" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {platformOptions.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="currentWebsite"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Current website or app</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="url"
                          placeholder="example.com (leave blank if none)"
                          data-testid="input-current-site"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="projectDescription"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>What should it do for your business? *</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Tell us who your customers are, what you want the site or app to accomplish, and anything you like or dislike about what you have today."
                        className="h-32"
                        data-testid="textarea-description"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      The more context you give us, the more accurate your quote will be.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="features"
                render={() => (
                  <FormItem>
                    <FormLabel>Features you're interested in (optional)</FormLabel>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {featureOptions.map((option) => (
                        <FormField
                          key={option}
                          control={form.control}
                          name="features"
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-3 hover:bg-gray-50">
                              <FormControl>
                                <Checkbox
                                  checked={field.value?.includes(option)}
                                  onCheckedChange={(checked) =>
                                    field.onChange(
                                      checked
                                        ? [...(field.value ?? []), option]
                                        : (field.value ?? []).filter((v) => v !== option),
                                    )
                                  }
                                />
                              </FormControl>
                              <FormLabel className="text-sm font-normal leading-snug">
                                {option}
                              </FormLabel>
                            </FormItem>
                          )}
                        />
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>

            {/* ---- Budget & timeline ----------------------------------- */}
            <section className="space-y-4">
              <h3 className="border-b pb-2 text-lg font-semibold text-gray-900">
                Budget &amp; timeline
              </h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="budgetRange"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Estimated budget *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-budget">
                            <SelectValue placeholder="Select a range" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {budgetOptions.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>Ballpark is fine — it helps us scope realistically.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="timeline"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ideal timeline *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-timeline">
                            <SelectValue placeholder="Select a timeline" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {timelineOptions.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="assetsReady"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Do you have branding and content ready? *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-assets">
                          <SelectValue placeholder="Select an option" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {assetsOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="howDidYouHear"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>How did you hear about Computer Systems Depot? *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-source">
                          <SelectValue placeholder="Please select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {howDidYouHearOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>

            {/* SMS opt-in consent (A2P 10DLC). Unchecked by default; voluntary.
                The label renders SMS_CONSENT_TEXT verbatim so it always matches
                the consent text stored server-side. Do not paraphrase. */}
            <FormField
              control={form.control}
              name="smsConsent"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border bg-gray-50 p-4">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      data-testid="checkbox-sms-consent"
                    />
                  </FormControl>
                  <div className="space-y-1 leading-snug">
                    <FormLabel className="text-sm font-normal">
                      {SMS_CONSENT_TEXT}{" "}
                      <a
                        href="https://www.computersystemsdepot.com/privacy-policy/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline"
                      >
                        View our Privacy Policy
                      </a>
                      {" "}and our{" "}
                      <a
                        href="https://www.computersystemsdepot.com/terms-and-conditions/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline"
                      >
                        Terms and Conditions
                      </a>
                      .
                    </FormLabel>
                    <FormDescription className="text-xs">
                      Optional — consent is not required to use our service or submit this form. You
                      can also opt in by texting START to{" "}
                      <a
                        href={`sms:+1${SMS_BUSINESS_PHONE.replace(/\D/g, "")}`}
                        className="underline"
                      >
                        {SMS_BUSINESS_PHONE}
                      </a>
                      .
                    </FormDescription>
                    <FormMessage />
                  </div>
                </FormItem>
              )}
            />

            <div className="space-y-3">
              <Button
                type="submit"
                size="lg"
                className="w-full bg-csd-red text-white hover:bg-red-700"
                disabled={submitProject.isPending}
                data-testid="button-submit-project"
              >
                {submitProject.isPending ? "Sending…" : "Request My Free Consultation"}
              </Button>
              <p className="text-center text-xs text-gray-500">
                No obligation. We reply within one business day.
              </p>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
