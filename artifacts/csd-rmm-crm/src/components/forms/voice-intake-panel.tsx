import { useCallback, useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2, Circle, Keyboard, Loader2, LogOut, Mic, MicOff, Pause, Play, RotateCcw,
  SkipForward, Volume2, VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { apiRequest } from "@/lib/queryClient";
import { useIntakeSpeech, type ListenError } from "@/hooks/use-intake-speech";
import {
  csdIntakeFieldSchema,
  csdIntakeFormSchema,
  deviceTypeOptions,
  howDidYouHearOptions,
  operatingSystemOptions,
  type CsdIntakeFormData,
} from "@/components/forms/csd-intake-schema";
import {
  FIELD_LABELS,
  GREETING,
  REVIEW_PROMPT,
  SENSITIVE_WARNING,
  SMS_NOTE,
  VOICE_STEPS,
  confirmQuestion,
  firstName,
  formWrites,
  localInterpret,
  nextStep,
  questionFor,
  type Interpretation,
  type VoiceField,
  type VoiceOptions,
} from "@/lib/voice-intake";

export type VoiceSubmitResult = { ok: true } | { ok: false; message: string };

interface VoiceIntakePanelProps {
  form: UseFormReturn<CsdIntakeFormData>;
  services: { id: number; name: string }[];
  onExit: () => void;
  /** Runs the form's normal submission. Only called after explicit approval. */
  onSubmitRequest: () => Promise<VoiceSubmitResult>;
  /** Marks the request as voice-completed; `speakReplies` = read the ticket aloud. */
  onVoiceUsed: (speakReplies: boolean) => void;
}

type Phase = "consent" | "active" | "submitting";
interface Message { role: "assistant" | "customer"; text: string }

const MAX_FOLLOW_UPS = 2;
const REQUIRED_FIELDS = VOICE_STEPS.filter((s) => s.required).map((s) => s.field);

export function VoiceIntakePanel({ form, services, onExit, onSubmitRequest, onVoiceUsed }: VoiceIntakePanelProps) {
  const speech = useIntakeSpeech();
  const { data: status } = useQuery<{ aiEnabled: boolean; provider: string | null }>({
    queryKey: ["/api/portal/voice-intake/status"],
    retry: false,
  });

  const [phase, setPhase] = useState<Phase>("consent");
  const [messages, setMessages] = useState<Message[]>([]);
  const [interim, setInterim] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(!speech.support.synthesis);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [inputMode, setInputMode] = useState<"voice" | "text">(speech.support.recognition ? "voice" : "text");
  const [notice, setNotice] = useState<string | null>(
    speech.support.recognition ? null : "Your browser doesn't support speech recognition, so please type your answers below. The assistant can still read its questions aloud.",
  );
  const [step, setStepState] = useState<string>("ready");
  const [, forceRender] = useState(0);

  // Refs mirror state for the async conversation loop.
  const stepRef = useRef("ready");
  const questionRef = useRef(GREETING);
  const aiRef = useRef(false);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  const mutedRef = useRef(muted);
  const inputModeRef = useRef(inputMode);
  const audioRef = useRef({ volume, rate });
  const turnRef = useRef(0);
  const skipped = useRef(new Set<VoiceField>());
  const touched = useRef(new Set<string>());
  const followUps = useRef(0);
  const noSpeechCount = useRef(0);
  const smsNoteGiven = useRef(false);
  const aiFailureNoted = useRef(false);
  const usedRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  mutedRef.current = muted;
  inputModeRef.current = inputMode;
  audioRef.current = { volume, rate };

  const options: VoiceOptions = {
    deviceType: deviceTypeOptions,
    operatingSystem: operatingSystemOptions,
    howDidYouHear: howDidYouHearOptions,
    services,
  };

  const setStep = (next: string) => { stepRef.current = next; setStepState(next); };

  // Remember fields the customer edits by hand, so switching between typing
  // and speaking never re-asks (or overwrites) what they already entered.
  useEffect(() => {
    const sub = form.watch((_values, { name, type }) => {
      if (name && type === "change") touched.current.add(name);
      forceRender((n) => n + 1);
    });
    return () => sub.unsubscribe();
  }, [form]);

  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [messages, interim]);

  const answered = useCallback((field: VoiceField): boolean => {
    const values = form.getValues();
    switch (field) {
      case "companyName": return Boolean(values.companyName?.trim());
      case "streetAddress": return Boolean(values.streetAddress?.trim());
      case "phoneNumber":
      case "emailAddress":
        return Boolean(values.phoneNumber?.trim() || values.emailAddress?.trim());
      // Preselected by default, so only count it once someone actually chose.
      case "contactPreference": return touched.current.has("contactPreference");
      default: {
        const shape = csdIntakeFieldSchema.shape[field as keyof typeof csdIntakeFieldSchema.shape];
        return shape ? shape.safeParse(values[field as keyof CsdIntakeFormData]).success : false;
      }
    }
  }, [form]);

  const addMessage = (role: Message["role"], text: string) => setMessages((m) => [...m, { role, text }]);

  // ---------- listening ----------

  const handleListenError = (error: ListenError) => {
    if (error === "no-speech") {
      noSpeechCount.current++;
      if (noSpeechCount.current < 2 && !pausedRef.current) { startListening(); return; }
      setNotice("I didn't hear anything. Select “Speak” to try again, or type your answer below.");
      return;
    }
    const messagesByError: Record<Exclude<ListenError, "no-speech">, string> = {
      "not-allowed": "Microphone access was blocked. You can keep going by typing your answers below, or allow the microphone in your browser settings and select “Use microphone”.",
      "audio-capture": "No microphone was found. You can keep going by typing your answers below.",
      network: "Speech recognition lost its connection. You can keep going by typing your answers below.",
      unsupported: "Speech recognition isn't available in this browser. Please type your answers below.",
      other: "Speech recognition stopped unexpectedly. Select “Speak” to try again, or type your answer below.",
    };
    setNotice(messagesByError[error]);
    if (error !== "other") setInputMode("text");
  };

  const startListening = () => {
    if (inputModeRef.current !== "voice" || pausedRef.current || !speech.support.recognition) return;
    speech.listen({
      onInterim: setInterim,
      onFinal: (text) => { setInterim(""); noSpeechCount.current = 0; void handleReply(text); },
      onError: (e) => { setInterim(""); handleListenError(e); },
    });
  };

  // ---------- speaking ----------

  /** Shows (and unless muted, speaks) the assistant's line, then listens. */
  const say = async (text: string, question?: string) => {
    const turn = ++turnRef.current;
    speech.stopListening();
    questionRef.current = question ?? text;
    addMessage("assistant", text);
    if (!mutedRef.current) await speech.speak(text, audioRef.current);
    if (turn !== turnRef.current || pausedRef.current) return;
    startListening();
  };

  // ---------- conversation ----------

  const ask = (field: VoiceField, prefix = "") => {
    setStep(field);
    const q = questionFor(field, options, firstName(form.getValues().customerName));
    return say(`${prefix}${prefix ? " " : ""}${q}`, q);
  };

  const advance = async (prefix = "") => {
    const next = nextStep(answered, skipped.current);
    if (next) return ask(next.field, prefix);

    // Every step done: run the form's own validation before reviewing.
    const valid = await form.trigger();
    if (!valid) {
      const errors = form.formState.errors;
      const bad = VOICE_STEPS.find((s) => errors[s.field as keyof CsdIntakeFormData]);
      if (bad) return ask(bad.field, `${prefix} I still need a valid answer for your ${FIELD_LABELS[bad.field].toLowerCase()}.`.trim());
      setStep("review");
      return say(`${prefix} Some details on the form still need attention. Please check the highlighted fields.`.trim());
    }
    setStep("review");
    const sms = !smsNoteGiven.current && !form.getValues().smsConsent ? `${SMS_NOTE} ` : "";
    smsNoteGiven.current = true;
    return say(`${prefix ? `${prefix} ` : ""}${sms}${REVIEW_PROMPT}`, REVIEW_PROMPT);
  };

  const goTo = (field: VoiceField) => {
    skipped.current.delete(field);
    if (field === "contactPreference") touched.current.delete("contactPreference");
    return ask(field, `Okay, let's update your ${FIELD_LABELS[field].toLowerCase()}.`);
  };

  const interpret = async (currentStep: string, utterance: string): Promise<Interpretation> => {
    const stepForModel = currentStep === "followup" ? "problemDescription" : currentStep;
    if (aiRef.current) {
      try {
        const values = form.getValues();
        const res = await apiRequest("POST", "/api/portal/voice-intake/interpret", {
          step: stepForModel,
          question: questionRef.current,
          utterance,
          values: {
            customerName: values.customerName, companyName: values.companyName ?? "",
            phoneNumber: values.phoneNumber, emailAddress: values.emailAddress,
            streetAddress: values.streetAddress ?? "", city: values.city ?? "", state: values.state ?? "", zip: values.zip ?? "",
            contactPreference: touched.current.has("contactPreference") ? values.contactPreference : "",
            serviceId: values.serviceId ? Number(values.serviceId) : null,
            deviceType: values.deviceType, deviceBrandModel: values.deviceBrandModel,
            operatingSystem: values.operatingSystem, problemDescription: values.problemDescription,
            howDidYouHear: values.howDidYouHear,
          },
          options,
          followUpsRemaining: Math.max(0, MAX_FOLLOW_UPS - followUps.current),
        });
        return (await res.json()) as Interpretation;
      } catch {
        if (!aiFailureNoted.current) {
          aiFailureNoted.current = true;
          setNotice("The assistant's language service isn't responding, so I've switched to basic mode. Short, simple answers work best.");
        }
      }
    }
    return localInterpret(stepForModel, utterance, options);
  };

  const applyUpdates = (result: Interpretation, replaceProblem: boolean): string[] => {
    const current = form.getValues();
    const writes = formWrites(result.updates, current, replaceProblem);
    for (const [key, value] of Object.entries(writes)) {
      // Unchanged values aren't rewritten (and so aren't confirmed again), but
      // still count as answered: "call" matches the preselected default.
      touched.current.add(key);
      if (String(current[key as keyof CsdIntakeFormData] ?? "") === String(value)) { delete writes[key]; continue; }
      form.setValue(key as keyof CsdIntakeFormData, value as never, { shouldDirty: true, shouldValidate: true });
      touched.current.add(key);
    }
    const keys = Object.keys(writes);
    if (keys.length && !usedRef.current) {
      usedRef.current = true;
      onVoiceUsed(!mutedRef.current);
    }
    return keys;
  };

  const submit = async () => {
    setPhase("submitting");
    turnRef.current++;
    speech.stopListening();
    addMessage("assistant", "Submitting your service request now…");
    onVoiceUsed(!mutedRef.current);
    const result = await onSubmitRequest();
    // On success the form replaces this panel with the confirmation screen,
    // which shows (and reads) the real ticket number from the server.
    if (!result.ok) {
      setPhase("active");
      setStep("review");
      await say(`I'm sorry, the request couldn't be submitted. ${result.message} Your answers are still on the form. You can try again, or call us at 9 5 4, 6 3 7, 7 3 0 0.`, REVIEW_PROMPT);
    }
  };

  const act = async (current: string, r: Interpretation) => {
    const ack = r.acknowledgement ? r.acknowledgement.trim() : "";
    if (r.intent === "repeat") return say(questionRef.current);
    if (r.intent === "sensitive") return say(`${SENSITIVE_WARNING} ${questionRef.current}`, questionRef.current);

    if (current === "ready") {
      if (r.intent === "yes" || r.intent === "answer") {
        applyUpdates(r, false);
        return advance("Great, let's get started.");
      }
      if (r.intent === "no") return say("No problem. Just say “ready” whenever you'd like to begin, or select Exit to fill in the form yourself.", "Are you ready to get started?");
      return say("Sorry, I didn't catch that. Are you ready to get started?");
    }

    if (current === "confirm:phoneNumber" || current === "confirm:emailAddress") {
      const field = current.slice("confirm:".length) as "phoneNumber" | "emailAddress";
      if (r.intent === "yes") return advance("Thank you.");
      if (r.updates[field]) {
        applyUpdates(r, false);
        setStep(current);
        const q = confirmQuestion(field, form.getValues()[field]);
        return say(q);
      }
      if (r.intent === "no" || r.intent === "change") {
        form.setValue(field, "", { shouldDirty: true });
        return ask(field, "Sorry about that, let's try again.");
      }
      return say(`Sorry, I didn't catch that. ${confirmQuestion(field, form.getValues()[field])}`, questionRef.current);
    }

    if (current === "confirm:submit") {
      if (r.intent === "yes" || r.intent === "submit") return submit();
      setStep("review");
      return say("Okay, I won't submit yet. What would you like to change?", REVIEW_PROMPT);
    }

    if (current === "review") {
      if (r.intent === "submit") return submit();
      if (r.intent === "change" && r.changeField && VOICE_STEPS.some((s) => s.field === r.changeField)) {
        // "My email is actually…" may carry the new value already.
        if (Object.keys(r.updates).length) {
          const keys = applyUpdates(r, r.changeField === "problemDescription");
          if (keys.includes("phoneNumber") || keys.includes("emailAddress")) {
            const f = keys.includes("phoneNumber") ? "phoneNumber" : "emailAddress";
            setStep(`confirm:${f}`);
            return say(`${ack} ${confirmQuestion(f, form.getValues()[f])}`.trim(), confirmQuestion(f, form.getValues()[f]));
          }
          return advance(ack || "Updated.");
        }
        return goTo(r.changeField as VoiceField);
      }
      if (Object.keys(r.updates).length) {
        applyUpdates(r, false);
        return advance(ack || "Updated.");
      }
      if (r.intent === "no") {
        setStep("confirm:submit");
        return say("Shall I submit your service request now?");
      }
      if (r.intent === "yes") return say("Sure. What would you like to change?", REVIEW_PROMPT);
      return say("Sorry, I didn't catch that. Would you like to change anything, or shall I submit your request?", REVIEW_PROMPT);
    }

    // A form field (or a problem follow-up).
    const field = (current === "followup" ? "problemDescription" : current) as VoiceField;
    const stepDef = VOICE_STEPS.find((s) => s.field === field);

    if (r.intent === "change" && r.changeField && !Object.keys(r.updates).length && VOICE_STEPS.some((s) => s.field === r.changeField)) {
      return goTo(r.changeField as VoiceField);
    }
    if (r.intent === "skip") {
      if (current === "followup") return advance("No problem.");
      if (stepDef && !stepDef.required) { skipped.current.add(field); return advance("No problem."); }
      return say(`This one is needed to complete your request. ${questionRef.current}`, questionRef.current);
    }

    const replaceProblem = r.intent === "change" && r.changeField === "problemDescription";
    const keys = applyUpdates(r, replaceProblem);

    // Read back anything easy to mishear.
    for (const f of ["phoneNumber", "emailAddress"] as const) {
      if (keys.includes(f)) {
        setStep(`confirm:${f}`);
        const q = confirmQuestion(f, form.getValues()[f]);
        return say(`${ack} ${q}`.trim(), q);
      }
    }

    if (field === "problemDescription" && answered("problemDescription")) {
      if (r.followUpQuestion && followUps.current < MAX_FOLLOW_UPS) {
        followUps.current++;
        setStep("followup");
        return say(`${ack} ${r.followUpQuestion}`.trim(), r.followUpQuestion);
      }
      return advance(ack || "Thank you, that's helpful.");
    }
    const understood = Object.keys(r.updates).length > 0;
    if (field === "problemDescription" && r.updates.problemDetail) {
      return say(`${ack} Could you tell me a little more about what's happening?`.trim(), "Could you tell me a little more about what's happening?");
    }
    if (understood && answered(field)) return advance(ack || "Got it.");
    if (understood) return advance(ack);
    return say(`Sorry, I didn't quite catch that. ${questionRef.current}`, questionRef.current);
  };

  async function handleReply(text: string) {
    const reply = text.trim();
    if (!reply || busyRef.current || pausedRef.current) return;
    setNotice((n) => (n?.startsWith("I didn't hear") ? null : n));
    addMessage("customer", reply);
    busyRef.current = true;
    setBusy(true);
    speech.stopListening();
    try {
      const current = stepRef.current;
      const result = await interpret(current, reply);
      await act(current, result);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // ---------- controls ----------

  const start = (useAi: boolean) => {
    aiRef.current = useAi;
    setPhase("active");
    setStep("ready");
    void say(GREETING);
  };

  const pause = () => {
    pausedRef.current = true;
    setPaused(true);
    turnRef.current++;
    speech.cancelSpeech();
    speech.stopListening();
    setInterim("");
  };

  const resume = () => {
    pausedRef.current = false;
    setPaused(false);
    void say(`Welcome back. ${questionRef.current}`, questionRef.current);
  };

  const repeat = () => {
    if (pausedRef.current) return resume();
    void say(questionRef.current);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    if (next) speech.cancelSpeech();
  };

  const next = () => {
    if (busyRef.current) return;
    const current = stepRef.current;
    const def = VOICE_STEPS.find((s) => s.field === current);
    if (def && !def.required && !answered(def.field)) skipped.current.add(def.field);
    void advance();
  };

  const exit = () => {
    turnRef.current++;
    speech.cancelSpeech();
    speech.stopListening();
    onExit();
  };

  const useMicrophone = () => {
    setNotice(null);
    setInputMode("voice");
    inputModeRef.current = "voice";
    noSpeechCount.current = 0;
    if (!busyRef.current && !pausedRef.current) startListening();
  };

  // Phones kill recognition when the page is hidden; pause instead of failing.
  useEffect(() => {
    if (phase !== "active") return;
    const onHidden = () => { if (document.hidden && !pausedRef.current) pause(); };
    const onOffline = () => setNotice("You appear to be offline. Your answers are safe on the form; resume when you're reconnected, or keep typing.");
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("offline", onOffline);
    };
  });

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    const text = typed;
    setTyped("");
    void handleReply(text);
  };

  // ---------- render ----------

  const values = form.getValues();
  const done = REQUIRED_FIELDS.filter((f) => answered(f)).length;
  const progress = Math.round((done / REQUIRED_FIELDS.length) * 100);
  const serviceName = services.find((s) => s.id === Number(values.serviceId))?.name;
  const display = (field: VoiceField): string => {
    switch (field) {
      case "serviceId": return serviceName ?? "";
      case "streetAddress": return [values.streetAddress, values.city, values.state, values.zip].filter((v) => v?.trim()).join(", ");
      case "contactPreference": return touched.current.has("contactPreference")
        ? ({ call: "Phone call", text: "Text message", email: "Email" } as const)[values.contactPreference] : "";
      default: return String(values[field as keyof CsdIntakeFormData] ?? "");
    }
  };
  const statusText = phase === "submitting" ? "Submitting…"
    : paused ? "Paused"
    : busy ? "Thinking…"
    : speech.speaking ? "Speaking…"
    : speech.listening ? "Listening — go ahead"
    : inputMode === "text" ? "Type your answer below"
    : "Ready";

  if (phase === "consent") {
    return (
      <section aria-labelledby="voice-intake-title" className="rounded-lg border-2 border-red-200 bg-red-50/50 p-4 space-y-3" data-testid="voice-intake-consent">
        <h3 id="voice-intake-title" ref={headingRef} tabIndex={-1} className="text-lg font-semibold flex items-center gap-2 outline-none">
          <Mic className="h-5 w-5 text-red-600" aria-hidden /> Voice Intake
        </h3>
        <p className="text-sm text-gray-700">
          Talk with our virtual service assistant and it will fill in this form for you. You'll review
          everything, and nothing is sent until you approve it.
        </p>
        <ul className="text-sm text-gray-700 list-disc pl-5 space-y-1">
          <li>
            <strong>Speech recognition</strong> is provided by your web browser. In Chrome and Edge your voice
            is processed by Google or Microsoft; in Safari, by Apple. Your browser will ask to use your microphone.
          </li>
          {status?.aiEnabled && (
            <li>
              <strong>With the AI assistant</strong>, the text of each answer is sent securely to our server and
              processed by Anthropic's Claude AI service so the assistant can understand natural replies.
            </li>
          )}
          <li>We don't save recordings or transcripts. Only the form you choose to submit is kept.</li>
          <li>Never say passwords, PINs, or payment card numbers.</li>
          <li>You can switch to typing, or close the assistant and fill in the form by hand, at any time.</li>
        </ul>
        <div className="flex flex-wrap gap-2">
          {status?.aiEnabled ? (
            <>
              <Button type="button" onClick={() => start(true)} data-testid="button-voice-start-ai">
                <Mic className="h-4 w-4 mr-2" aria-hidden /> I agree, start with AI assistant
              </Button>
              <Button type="button" variant="outline" onClick={() => start(false)} data-testid="button-voice-start-basic">
                Start in basic mode (no AI processing)
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => start(false)} data-testid="button-voice-start-basic">
              <Mic className="h-4 w-4 mr-2" aria-hidden /> Start voice intake
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={exit} data-testid="button-voice-cancel">Cancel</Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="voice-intake-title" className="rounded-lg border-2 border-red-200 bg-white p-4 space-y-4" data-testid="voice-intake-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="voice-intake-title" ref={headingRef} tabIndex={-1} className="text-lg font-semibold flex items-center gap-2 outline-none">
          <Mic className="h-5 w-5 text-red-600" aria-hidden /> Voice Intake
        </h3>
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm font-medium" data-testid="voice-status">
          <span
            aria-hidden
            className={`inline-block h-3 w-3 rounded-full ${speech.listening && !paused ? "bg-red-600 animate-pulse" : busy || speech.speaking ? "bg-amber-500" : "bg-gray-300"}`}
          />
          {statusText}
        </div>
      </div>

      <div>
        <div className="flex justify-between text-xs text-gray-600 mb-1">
          <span>Required details</span>
          <span data-testid="voice-progress">{done} of {REQUIRED_FIELDS.length}</span>
        </div>
        <Progress value={progress} aria-label={`Required details completed: ${done} of ${REQUIRED_FIELDS.length}`} />
      </div>

      {notice && (
        <p role="alert" className="text-sm rounded-md bg-amber-50 border border-amber-200 p-2 text-amber-900" data-testid="voice-notice">{notice}</p>
      )}

      <div ref={logRef} role="log" aria-live="polite" aria-label="Conversation" className="max-h-64 overflow-y-auto space-y-2 rounded-md bg-gray-50 p-3" data-testid="voice-log">
        {messages.map((m, i) => (
          <p key={i} className={`text-sm rounded-md px-3 py-2 ${m.role === "assistant" ? "bg-white border" : "bg-red-600 text-white ml-8"}`}>
            <span className="sr-only">{m.role === "assistant" ? "Assistant: " : "You: "}</span>{m.text}
          </p>
        ))}
        {interim && <p className="text-sm italic text-gray-500 ml-8" aria-hidden data-testid="voice-interim">{interim}…</p>}
      </div>

      <form onSubmit={submitTyped} className="flex gap-2" aria-label="Type an answer">
        <label htmlFor="voice-typed-answer" className="sr-only">Type your answer</label>
        <Input
          id="voice-typed-answer"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onFocus={() => { if (speech.listening) speech.stopListening(); }}
          placeholder={inputMode === "voice" ? "Or type your answer here" : "Type your answer"}
          autoComplete="off"
          disabled={phase === "submitting"}
          data-testid="input-voice-typed"
        />
        <Button type="submit" disabled={!typed.trim() || busy || phase === "submitting"} data-testid="button-voice-send">Send</Button>
      </form>

      <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Voice intake controls">
        {speech.support.recognition && (inputMode === "voice" ? (
          <Button type="button" variant="outline" size="sm" onClick={startListening} disabled={paused || busy || speech.listening || phase === "submitting"} data-testid="button-voice-speak">
            <Mic className="h-4 w-4 mr-1" aria-hidden /> Speak
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={useMicrophone} data-testid="button-voice-use-mic">
            <Mic className="h-4 w-4 mr-1" aria-hidden /> Use microphone
          </Button>
        ))}
        {inputMode === "voice" && speech.support.recognition && (
          <Button type="button" variant="outline" size="sm" onClick={() => { speech.stopListening(); setInputMode("text"); }} data-testid="button-voice-type">
            <Keyboard className="h-4 w-4 mr-1" aria-hidden /> Type instead
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={repeat} disabled={phase === "submitting"} data-testid="button-voice-repeat">
          <RotateCcw className="h-4 w-4 mr-1" aria-hidden /> Repeat question
        </Button>
        {paused ? (
          <Button type="button" variant="outline" size="sm" onClick={resume} data-testid="button-voice-resume">
            <Play className="h-4 w-4 mr-1" aria-hidden /> Resume
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={pause} disabled={phase === "submitting"} data-testid="button-voice-pause">
            <Pause className="h-4 w-4 mr-1" aria-hidden /> Pause
          </Button>
        )}
        {speech.support.synthesis && (
          <Button type="button" variant="outline" size="sm" onClick={toggleMute} aria-pressed={muted} data-testid="button-voice-mute">
            {muted ? <VolumeX className="h-4 w-4 mr-1" aria-hidden /> : <Volume2 className="h-4 w-4 mr-1" aria-hidden />}
            {muted ? "Unmute assistant" : "Mute assistant"}
          </Button>
        )}
        {!["ready", "review", "confirm:submit"].includes(step) && (
          <Button type="button" variant="outline" size="sm" onClick={next} disabled={busy || phase === "submitting"} data-testid="button-voice-next">
            <SkipForward className="h-4 w-4 mr-1" aria-hidden /> Next question
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={exit} data-testid="button-voice-exit">
          <LogOut className="h-4 w-4 mr-1" aria-hidden /> Exit voice intake
        </Button>
      </div>

      {speech.support.synthesis && !muted && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-gray-600">
          <div className="space-y-1">
            <span id="voice-volume-label">Assistant volume</span>
            <Slider aria-labelledby="voice-volume-label" min={0.1} max={1} step={0.1} value={[volume]} onValueChange={([v]) => setVolume(v)} />
          </div>
          <div className="space-y-1">
            <span id="voice-rate-label">Speaking speed</span>
            <Slider aria-labelledby="voice-rate-label" min={0.7} max={1.4} step={0.1} value={[rate]} onValueChange={([v]) => setRate(v)} />
          </div>
        </div>
      )}

      {inputMode === "text" && speech.support.recognition && !notice && (
        <p className="text-xs text-gray-500 flex items-center gap-1"><MicOff className="h-3 w-3" aria-hidden /> Microphone off. Typing mode.</p>
      )}

      <div className="rounded-md border p-3" data-testid="voice-summary">
        <p className="text-sm font-semibold mb-2">{step === "review" || step === "confirm:submit" ? "Please review your request" : "Your answers so far"}</p>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {VOICE_STEPS.map(({ field, required }) => {
            const value = display(field);
            const ok = required ? answered(field) : Boolean(value);
            return (
              <div key={field} className="flex gap-2 items-start">
                {ok
                  ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-600 shrink-0" aria-label="Completed" />
                  : <Circle className={`h-4 w-4 mt-0.5 shrink-0 ${required ? "text-red-400" : "text-gray-300"}`} aria-label={required ? "Required, missing" : "Optional"} />}
                <div className="min-w-0">
                  <dt className="text-xs text-gray-500">{FIELD_LABELS[field]}{required ? "" : " (optional)"}</dt>
                  <dd className="break-words">{value || <span className="text-gray-400">—</span>}</dd>
                </div>
              </div>
            );
          })}
        </dl>
        <p className="text-xs text-gray-500 mt-2">
          Text-message updates: {values.smsConsent ? "you opted in on the form" : "not selected (optional, tick the box on the form if you want them)"}.
        </p>
        {(step === "review" || step === "confirm:submit") && (
          <Button type="button" className="w-full mt-3" onClick={() => void submit()} disabled={busy || phase === "submitting"} data-testid="button-voice-submit">
            {phase === "submitting" ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> Submitting…</> : "Approve and submit service request"}
          </Button>
        )}
      </div>
    </section>
  );
}
