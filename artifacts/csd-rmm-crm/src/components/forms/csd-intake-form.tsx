import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mic } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { formatInTimeZone } from "date-fns-tz";
import { SlotPicker } from "@/components/booking/slot-picker";
import { DevicePhotoField } from "@/components/forms/device-photo-field";
import { VoiceIntakePanel, type VoiceSubmitResult } from "@/components/forms/voice-intake-panel";
import type { PendingPhoto } from "@/lib/marketplace";
import type { Service } from "@shared/schema";
import {
  csdIntakeFormSchema,
  deviceTypeOptions,
  howDidYouHearOptions,
  operatingSystemOptions,
  type CsdIntakeFormData,
} from "@/components/forms/csd-intake-schema";

// Exact SMS opt-in consent language shown to the customer. This same string is
// sent to the server and stored verbatim as proof of consent (A2P 10DLC
// requires recording what the customer agreed to, and when).
export const SMS_CONSENT_TEXT =
  "I agree to receive text messages from Computer Systems Depot Inc. at the mobile number provided, regarding my service request — including repair and ticket status updates, appointment reminders, and service alerts. Message frequency varies. Message & data rates may apply. Consent is not a condition of purchase. Reply STOP to unsubscribe or HELP for help.";
export const SMS_BUSINESS_PHONE = "954-637-7300";

interface Slot {
  startsAt: string;
  endsAt: string;
  resourceIds: number[];
}

const TIMEZONE = "America/New_York";

interface CsdIntakeFormProps {
  embedded?: boolean;
  /** Offer the spoken intake assistant (customer-facing pages). */
  voiceIntake?: boolean;
  onSuccess?: (data: any) => void;
  className?: string;
}

interface SubmissionResult {
  contactId?: number;
  leadId?: number;
  appointmentReference?: string;
  appointmentStartsAt?: string;
  /** Helpdesk ticket number returned by the server; never generated here. */
  ticketNumber?: string;
}

export default function CsdIntakeForm({ embedded = false, voiceIntake = true, onSuccess, className }: CsdIntakeFormProps) {
  const { toast } = useToast();
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submission, setSubmission] = useState<SubmissionResult>({});
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [devicePhoto, setDevicePhoto] = useState<PendingPhoto | null>(null);
  // Keep one key through retries of this submission, then rotate after success.
  const intakeSubmissionId = useRef(crypto.randomUUID());
  const [voiceOpen, setVoiceOpen] = useState(false);
  // Set once the voice assistant fills in any field; the request is then
  // tagged as voice intake for staff.
  const voiceUsed = useRef(false);
  const [speakConfirmation, setSpeakConfirmation] = useState(false);

  // Pull services from the booking platform — single source of truth.
  const { data: services = [], isLoading: servicesLoading } = useQuery<Service[]>({
    queryKey: ["/api/booking/services"],
  });

  const form = useForm<CsdIntakeFormData>({
    resolver: zodResolver(csdIntakeFormSchema),
    defaultValues: {
      customerName: "",
      companyName: "",
      phoneNumber: "",
      emailAddress: "",
      streetAddress: "",
      city: "",
      state: "FL",
      zip: "",
      contactPreference: "call",
      serviceId: undefined as unknown as number,
      deviceType: "",
      deviceBrandModel: "",
      operatingSystem: "",
      problemDescription: "",
      howDidYouHear: "",
      isFromActiveCall: false,
      callNotes: "",
      scheduleNow: false,
      smsConsent: false,
    },
  });

  const serviceId = form.watch("serviceId");
  const scheduleNow = form.watch("scheduleNow");
  const isFromActiveCall = form.watch("isFromActiveCall");

  const selectedService = services.find(s => s.id === Number(serviceId));

  // Drop slot if user changes service
  if (selectedSlot && selectedService && !selectedSlot.resourceIds) {
    setSelectedSlot(null);
  }

  // URL parameter parsing for tracking
  const urlParams = new URLSearchParams(window.location.search);
  const callId = urlParams.get('call_id') || undefined;
  if (callId && !form.getValues().isFromActiveCall) {
    form.setValue('isFromActiveCall', true);
  }

  const submitFlow = useMutation({
    mutationFn: async (data: CsdIntakeFormData): Promise<SubmissionResult> => {
      if (!selectedService) throw new Error("Please pick a service");

      // Step 1 — if scheduling, create slot lock first so we don't lose the slot
      // while contact/lead creation runs.
      let lockToken: string | undefined;
      if (data.scheduleNow) {
        if (!selectedSlot) throw new Error("Please pick an available time");
        const lockRes = await apiRequest("POST", "/api/booking/locks", {
          serviceId: selectedService.id,
          startsAt: selectedSlot.startsAt,
          timezone: TIMEZONE,
        });
        const lockData = await lockRes.json();
        lockToken = lockData.lockToken;
      }

      // Helper: best-effort release of the slot lock if subsequent steps fail
      const releaseLock = async () => {
        if (!lockToken) return;
        try {
          await apiRequest("DELETE", `/api/booking/locks/${encodeURIComponent(lockToken)}`);
        } catch { /* ignore — sweeper will clean up */ }
      };

      // Step 2 — submit intake (creates / merges CRM contact + lead)
      let intakeData: any;
      try {
        const intakeRes = await apiRequest("POST", "/api/intake", {
          full_name: data.customerName,
          company_name: data.companyName,
          intake_submission_id: intakeSubmissionId.current,
          mobile_phone: data.phoneNumber,
          email: data.emailAddress,
          preferred_contact_method: data.contactPreference,
          street_address: data.streetAddress,
          city: data.city,
          state: data.state,
          zip: data.zip,
          service_type: selectedService.name,
          // The server prices the lead and deal from this id — it never trusts
          // a price sent by the browser.
          service_id: selectedService.id,
          device_type: data.deviceType,
          device_brand: data.deviceBrandModel.split(' ')[0] || '',
          device_model: data.deviceBrandModel.split(' ').slice(1).join(' ') || '',
          operating_system: data.operatingSystem,
          device_photo: devicePhoto ? { dataBase64: devicePhoto.dataBase64 } : undefined,
          problem_description: data.problemDescription,
          how_did_you_hear_about_us: data.howDidYouHear,
          from_active_call: data.isFromActiveCall,
          call_notes: data.callNotes,
          sms_consent: data.smsConsent,
          sms_consent_text: data.smsConsent ? SMS_CONSENT_TEXT : null,
          intake_channel: voiceUsed.current ? "voice" : undefined,
        });
        intakeData = await intakeRes.json();
      } catch (err) {
        await releaseLock();
        throw err;
      }

      const result: SubmissionResult = {
        contactId: intakeData?.contact?.id,
        leadId: intakeData?.lead?.id,
        ticketNumber: intakeData?.ticket?.number || undefined,
      };

      // Step 3 — confirm appointment if a slot was locked
      if (lockToken) {
        try {
          const apptRes = await apiRequest("POST", "/api/booking/appointments", {
            lockToken,
            customerName: data.customerName,
            customerEmail: data.emailAddress,
            customerPhone: data.phoneNumber,
            customerTimezone: TIMEZONE,
            customerNotes: data.problemDescription,
            contactId: result.contactId,
            source: "web",
          });
          const apptData = await apptRes.json();
          result.appointmentReference = apptData?.appointment?.reference;
          result.appointmentStartsAt = apptData?.appointment?.startsAt;
        } catch (err) {
          await releaseLock();
          throw err;
        }
      }

      return result;
    },
    onSuccess: (result) => {
      intakeSubmissionId.current = crypto.randomUUID();
      setSubmission(result);
      setIsSubmitted(true);
      const appt = result.appointmentReference;
      toast({
        title: appt ? "Appointment Confirmed!" : "Request Submitted!",
        description: appt
          ? `Booking ${appt} on ${formatInTimeZone(new Date(result.appointmentStartsAt!), TIMEZONE, "EEE, MMM d 'at' h:mm a")}.`
          : "We'll contact you soon to schedule your service.",
      });
      onSuccess?.(result);
    },
    onError: (error: any) => {
      toast({
        title: "Submission Failed",
        description: error.message || "Please try again or call us directly.",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: CsdIntakeFormData) => submitFlow.mutate(data);

  // Voice intake submits through the same validation and mutation as the
  // Submit button, and only after the customer explicitly approved.
  const submitFromVoice = async (): Promise<VoiceSubmitResult> => {
    if (submitFlow.isPending) return { ok: false, message: "A submission is already in progress." };
    let outcome: VoiceSubmitResult = {
      ok: false,
      message: "Some required details are missing or invalid. Please check the highlighted fields on the form.",
    };
    await form.handleSubmit(async (data) => {
      if (data.scheduleNow && !selectedSlot) {
        outcome = { ok: false, message: "You chose to pick an appointment time. Please select a time on the form, or untick that option." };
        return;
      }
      try {
        await submitFlow.mutateAsync(data);
        outcome = { ok: true };
      } catch {
        outcome = { ok: false, message: "Our system couldn't accept the request just now." };
      }
    })();
    return outcome;
  };

  // Read the confirmed ticket number aloud when the customer used voice with
  // spoken replies on. Only runs after the server confirmed the submission.
  useEffect(() => {
    if (!isSubmitted || !speakConfirmation || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const ticket = submission.ticketNumber;
    const text = ticket
      ? `Your service request has been submitted successfully. Your ticket number is ${ticket.split("").join(" ")}. Thank you for choosing Computer Systems Depot.`
      : "Your service request has been submitted successfully. A technician has been notified and will contact you soon. Thank you for choosing Computer Systems Depot.";
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [isSubmitted, speakConfirmation, submission.ticketNumber]);

  if (isSubmitted) {
    return (
      <Card className={className}>
        <CardContent className="p-6 text-center">
          <div className="mb-4 text-6xl">✅</div>
          <h2 className="text-2xl font-bold text-green-600 mb-2">Thank You!</h2>
          {submission.appointmentReference ? (
            <>
              <p className="text-gray-600 mb-2">
                Your appointment is confirmed for{" "}
                <strong>
                  {formatInTimeZone(new Date(submission.appointmentStartsAt!), TIMEZONE, "EEEE, MMMM d 'at' h:mm a")}
                </strong>.
              </p>
              <p className="text-sm text-gray-500">
                Confirmation #: <span className="font-mono">{submission.appointmentReference}</span>
              </p>
              {submission.ticketNumber && (
                <p className="text-sm text-gray-500" data-testid="text-ticket-number">
                  Ticket #: <span className="font-mono">{submission.ticketNumber}</span>
                </p>
              )}
              <p className="text-xs text-gray-400 mt-2">
                We'll send a reminder before your appointment.
              </p>
            </>
          ) : (
            <>
              <p className="text-gray-600 mb-4">
                Your request has been submitted and a technician has been notified.
              </p>
              {submission.ticketNumber && (
                <p className="mb-4 text-gray-700" data-testid="text-ticket-number">
                  Your ticket number is{" "}
                  <span className="font-mono font-semibold text-gray-900">{submission.ticketNumber}</span>
                </p>
              )}
              <div className="text-left bg-gray-50 rounded-lg p-4 text-sm text-gray-600 space-y-2 max-w-sm mx-auto">
                <p className="font-semibold text-gray-800">What happens next</p>
                <p>1. A technician reviews your request right away.</p>
                <p>2. We reach out using your preferred contact method.</p>
                <p>3. We get your device fixed and back to you.</p>
              </div>
              <p className="text-sm text-gray-500 mt-4">
                Need help sooner? Call us at{" "}
                <a href="tel:9546377300" className="font-semibold text-red-600">954-637-7300</a>.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Computer Systems Depot - Service Request</CardTitle>
        <CardDescription>
          Tell us about your computer problem and we'll help you get back up and running quickly.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {voiceIntake && (
          <div className="mb-6">
            {voiceOpen ? (
              <VoiceIntakePanel
                form={form}
                services={services.map((s) => ({ id: s.id, name: s.name }))}
                onExit={() => setVoiceOpen(false)}
                onSubmitRequest={submitFromVoice}
                onVoiceUsed={(speak) => { voiceUsed.current = true; setSpeakConfirmation(speak); }}
              />
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-center space-y-2">
                <Button
                  type="button"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={() => setVoiceOpen(true)}
                  disabled={servicesLoading}
                  data-testid="button-start-voice-intake"
                >
                  <Mic className="h-5 w-5 mr-2" aria-hidden />
                  🎤 Start Voice Intake
                </Button>
                <p className="text-xs text-gray-500">
                  Prefer to talk? Our virtual assistant can fill in this form with you. Or just type below.
                </p>
              </div>
            )}
          </div>
        )}
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Customer Information */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold border-b pb-2">Contact Information</h3>

              <FormField
                control={form.control}
                name="customerName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full Name *</FormLabel>
                    <FormControl><Input placeholder="John Smith" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="companyName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Corp (leave blank if personal)" {...field} />
                    </FormControl>
                    <FormDescription>
                      Business customers: we'll file this request under your company account.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="phoneNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mobile Phone Number *</FormLabel>
                    <FormControl><Input placeholder="(555) 123-4567" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="emailAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email Address *</FormLabel>
                    <FormControl><Input type="email" placeholder="john@example.com" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="streetAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Address</FormLabel>
                    <FormControl><Input placeholder="123 Main Street" {...field} /></FormControl>
                    <FormDescription>
                      Optional — needed only for on-site visits and pickup/return.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>City</FormLabel>
                      <FormControl><Input placeholder="Lauderhill" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="state"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>State</FormLabel>
                      <FormControl><Input placeholder="FL" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="zip"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>ZIP</FormLabel>
                      <FormControl><Input placeholder="33313" {...field} /></FormControl>
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
                    <FormLabel>Preferred Contact Method *</FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        value={field.value}
                        className="flex space-x-6"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="call" id="call" />
                          <label htmlFor="call">Phone Call</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="text" id="text" />
                          <label htmlFor="text">Text Message</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="email" id="email" />
                          <label htmlFor="email">Email</label>
                        </div>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* SMS opt-in consent (A2P 10DLC). Unchecked by default; voluntary. */}
              <FormField
                control={form.control}
                name="smsConsent"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 bg-gray-50">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-sms-consent"
                      />
                    </FormControl>
                    <div className="space-y-1 leading-snug">
                      <FormLabel className="font-normal text-sm">
                        {/* Rendered from SMS_CONSENT_TEXT so the visible label always matches
                            the consent text stored server-side and quoted verbatim in the A2P
                            campaign registration. Do not paraphrase here. */}
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
                        Optional — consent is not required to use our service or submit
                        this form. You can also opt in by texting START to{" "}
                        <a href={`sms:+1${SMS_BUSINESS_PHONE.replace(/\D/g, "")}`} className="underline">
                          {SMS_BUSINESS_PHONE}
                        </a>
                        .
                      </FormDescription>
                      <FormMessage />
                    </div>
                  </FormItem>
                )}
              />
            </div>

            {/* Service Details */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold border-b pb-2">Service Details</h3>

              <FormField
                control={form.control}
                name="serviceId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>What service do you need? *</FormLabel>
                    <Select
                      onValueChange={(v) => { field.onChange(Number(v)); setSelectedSlot(null); }}
                      value={field.value ? String(field.value) : undefined}
                      disabled={servicesLoading}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-service">
                          <SelectValue placeholder={servicesLoading ? "Loading services…" : "Select a service"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {services.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            {s.name}
                            {s.basePriceCents > 0 && (
                              <span className="text-muted-foreground ml-2">
                                · ${(s.basePriceCents / 100).toFixed(0)} · {s.durationMinutes} min
                              </span>
                            )}
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
                name="deviceType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>What type of device? *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || undefined}>
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Select device type" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {deviceTypeOptions.map((option) => (
                          <SelectItem key={option} value={option}>{option}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="deviceBrandModel"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Device Brand & Model *</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Dell Inspiron 15, HP Pavilion, MacBook Pro" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DevicePhotoField value={devicePhoto} onChange={setDevicePhoto} disabled={submitFlow.isPending} />

              <FormField
                control={form.control}
                name="operatingSystem"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Operating System *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || undefined}>
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Select operating system" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {operatingSystemOptions.map((option) => (
                          <SelectItem key={option} value={option}>{option}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="problemDescription"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Describe the problem you're experiencing *</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Please describe what's happening with your computer. Include any error messages you see..."
                        className="h-32"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Scheduling — opt in to pick a specific time */}
            {selectedService && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold border-b pb-2">Schedule Your Appointment</h3>

                <FormField
                  control={form.control}
                  name="scheduleNow"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(checked) => {
                            field.onChange(checked);
                            if (!checked) setSelectedSlot(null);
                          }}
                          data-testid="checkbox-schedule-now"
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Pick an appointment time now</FormLabel>
                        <FormDescription>
                          Lock in a specific time slot, or leave unchecked and we'll call to schedule.
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />

                {scheduleNow && (
                  <div className="border rounded-lg p-4 bg-gray-50">
                    <SlotPicker
                      service={selectedService}
                      timezone={TIMEZONE}
                      selectedSlot={selectedSlot}
                      onSelectSlot={setSelectedSlot}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Marketing */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold border-b pb-2">How did you find us?</h3>
              <FormField
                control={form.control}
                name="howDidYouHear"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>How did you hear about Computer Systems Depot? *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || undefined}>
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Please select" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {howDidYouHearOptions.map((option) => (
                          <SelectItem key={option} value={option}>{option}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Call Information */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold border-b pb-2">Call Information</h3>
              <FormField
                control={form.control}
                name="isFromActiveCall"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Are you currently on the phone with us?</FormLabel>
                      <FormDescription>
                        Check if you were directed to this form during an active call.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />

              {isFromActiveCall && (
                <FormField
                  control={form.control}
                  name="callNotes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Call Notes (for staff use)</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Any additional notes about this call..." className="h-20" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={submitFlow.isPending || (scheduleNow && !selectedSlot)}
              data-testid="button-submit"
            >
              {submitFlow.isPending
                ? "Submitting…"
                : scheduleNow && selectedSlot
                  ? "Confirm Appointment"
                  : "Submit Service Request"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
