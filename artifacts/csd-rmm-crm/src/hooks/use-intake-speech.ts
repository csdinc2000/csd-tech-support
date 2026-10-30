import { useCallback, useEffect, useRef, useState } from "react";

// Browser speech for the public voice intake. Uses only the Web Speech API —
// no server audio, nothing recorded. Recognition (speech-to-text) is provided
// by the browser vendor; synthesis (text-to-speech) runs on the device.

export type ListenError =
  | "not-allowed" | "no-speech" | "audio-capture" | "network" | "unsupported" | "other";

interface ListenHandlers {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: ListenError) => void;
}

const SpeechRecognitionCtor: any =
  typeof window !== "undefined"
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : undefined;

// Pause after the last recognised word before the answer counts as finished,
// so customers can take a breath mid-sentence.
const END_OF_ANSWER_MS = 1800;

const PREFERRED_VOICES = [/Google US English/i, /Samantha/i, /Jenny/i, /Aria/i, /Natural/i, /Zira/i];

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices().filter((v) => /^en(-|_)?US/i.test(v.lang) || /^en/i.test(v.lang));
  for (const re of PREFERRED_VOICES) {
    const v = voices.find((voice) => re.test(voice.name));
    if (v) return v;
  }
  return voices.find((v) => /^en(-|_)?US/i.test(v.lang)) ?? voices[0] ?? null;
}

/** Splits text into sentences: Chrome cuts off utterances longer than ~15 s. */
function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

export function useIntakeSpeech() {
  const support = {
    recognition: Boolean(SpeechRecognitionCtor),
    synthesis: typeof window !== "undefined" && "speechSynthesis" in window,
  };
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recognitionRef = useRef<any>(null);
  const speakTokenRef = useRef(0);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (!support.synthesis) return;
    const load = () => { voiceRef.current = pickVoice(); };
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
  }, [support.synthesis]);

  const cancelSpeech = useCallback(() => {
    speakTokenRef.current++;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  /** Speaks text aloud; resolves when finished, cancelled, or on error. */
  const speak = useCallback(async (text: string, opts: { volume: number; rate: number }) => {
    if (!support.synthesis || !text.trim()) return;
    window.speechSynthesis.cancel();
    const token = ++speakTokenRef.current;
    setSpeaking(true);
    try {
      for (const part of sentences(text)) {
        if (token !== speakTokenRef.current) return;
        await new Promise<void>((resolve) => {
          const u = new SpeechSynthesisUtterance(part);
          u.lang = "en-US";
          u.volume = opts.volume;
          u.rate = opts.rate;
          if (voiceRef.current) u.voice = voiceRef.current;
          u.onend = () => resolve();
          u.onerror = () => resolve();
          window.speechSynthesis.speak(u);
          // Some mobile browsers never fire onend; don't hang the conversation.
          setTimeout(resolve, Math.max(4000, part.length * 120 / opts.rate));
        });
      }
    } finally {
      if (token === speakTokenRef.current) setSpeaking(false);
    }
  }, [support.synthesis]);

  const stopListening = useCallback(() => {
    const r = recognitionRef.current;
    recognitionRef.current = null;
    if (r) {
      r.onresult = r.onerror = r.onend = null;
      try { r.abort(); } catch { /* already stopped */ }
    }
    setListening(false);
  }, []);

  /**
   * Listens for one answer. Starting recognition is what triggers the
   * browser's microphone permission prompt, so this is only ever called after
   * the customer chose to start voice intake.
   */
  const listen = useCallback((handlers: ListenHandlers) => {
    stopListening();
    if (!SpeechRecognitionCtor) { handlers.onError("unsupported"); return; }
    let finalText = "";
    let latest = "";
    let finished = false;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(silenceTimer);
      const text = (finalText || latest).trim();
      stopListening();
      if (text) handlers.onFinal(text);
      else handlers.onError("no-speech");
    };

    recognition.onresult = (event: any) => {
      let interim = "";
      finalText = "";
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += `${res[0].transcript} `;
        else interim += res[0].transcript;
      }
      latest = `${finalText}${interim}`.trim();
      handlers.onInterim(latest);
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, END_OF_ANSWER_MS);
    };
    recognition.onerror = (event: any) => {
      if (finished) return;
      const code: string = event?.error ?? "other";
      if (code === "aborted") return;
      if (code === "no-speech" && latest) return finish();
      finished = true;
      clearTimeout(silenceTimer);
      stopListening();
      handlers.onError(
        code === "not-allowed" || code === "service-not-allowed" ? "not-allowed"
          : code === "no-speech" ? "no-speech"
          : code === "audio-capture" ? "audio-capture"
          : code === "network" ? "network"
          : "other",
      );
    };
    // Browsers also end sessions on their own (silence, time limits).
    recognition.onend = () => finish();

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      handlers.onError("other");
    }
  }, [stopListening]);

  useEffect(() => () => { stopListening(); cancelSpeech(); }, [stopListening, cancelSpeech]);

  return { support, listening, speaking, speak, cancelSpeech, listen, stopListening };
}
