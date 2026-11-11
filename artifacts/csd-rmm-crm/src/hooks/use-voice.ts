import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';

interface UseVoiceOptions {
  onTranscript?: (text: string) => void;
  onFinalTranscript?: (text: string) => void;
}

interface TTSVoice {
  id: string;
  name: string;
  description: string;
}

interface TTSStatus {
  available: boolean;
  voices: TTSVoice[];
}

const SpeechRecognitionAPI = typeof window !== 'undefined'
  ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  : null;

export function useVoice(options: UseVoiceOptions = {}) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('nova');
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onTranscriptRef = useRef(options.onTranscript);
  onTranscriptRef.current = options.onTranscript;
  const onFinalTranscriptRef = useRef(options.onFinalTranscript);
  onFinalTranscriptRef.current = options.onFinalTranscript;

  const { data: ttsStatus } = useQuery<TTSStatus>({
    queryKey: ['/api/aria/tts/status'],
  });

  const useServerTTS = ttsStatus?.available ?? false;

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
        recognitionRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    if (!SpeechRecognitionAPI) return;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setIsSpeaking(false);
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }

    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
    }

    try {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => setIsListening(true);

      recognition.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (finalTranscript) {
        setTranscript(finalTranscript);
        onTranscriptRef.current?.(finalTranscript);
        onFinalTranscriptRef.current?.(finalTranscript);
      } else {
        setTranscript(interimTranscript);
        onTranscriptRef.current?.(interimTranscript);
      }
      };

      recognition.onerror = (event: any) => {
        if (event.error !== 'aborted' && event.error !== 'no-speech') {
          console.error('Speech recognition error:', event.error);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setIsListening(false);
      console.error('Could not start speech recognition:', error);
    }
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  const speakWithServer = useCallback(async (text: string) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsSpeaking(true);

    try {
      const response = await apiRequest('POST', '/api/aria/tts', { text, voice: selectedVoiceId }, {
        signal: controller.signal,
      });

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(url);
        audioRef.current = null;
      };

      audio.onerror = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(url);
        audioRef.current = null;
      };

      await audio.play();
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('Server TTS error:', error);
      }
      setIsSpeaking(false);
      abortRef.current = null;
    }
  }, [selectedVoiceId]);

  const speakWithBrowser = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel();

    const cleanText = text
      .replace(/[#*_~`>|]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, '. ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!cleanText) return;

    const maxChunkLength = 200;
    const sentences = cleanText.match(/[^.!?]+[.!?]+/g) || [cleanText];
    const chunks: string[] = [];
    let current = '';

    for (const sentence of sentences) {
      if ((current + sentence).length > maxChunkLength && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    setIsSpeaking(true);

    const speakChunk = (index: number) => {
      if (index >= chunks.length) {
        setIsSpeaking(false);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      utterance.onend = () => speakChunk(index + 1);
      utterance.onerror = (e) => {
        if ((e as any).error !== 'interrupted' && (e as any).error !== 'canceled') {
          console.error('Speech synthesis error:', (e as any).error);
        }
        setIsSpeaking(false);
      };

      window.speechSynthesis.speak(utterance);
    };

    speakChunk(0);
  }, []);

  const speak = useCallback((text: string) => {
    if (!voiceEnabled || !text.trim()) return;
    if (useServerTTS) {
      speakWithServer(text);
    } else {
      speakWithBrowser(text);
    }
  }, [voiceEnabled, useServerTTS, speakWithServer, speakWithBrowser]);

  const stopSpeaking = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }, []);

  const toggleVoice = useCallback(() => {
    setVoiceEnabled(prev => {
      if (prev) {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current = null;
        }
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
        setIsSpeaking(false);
      }
      return !prev;
    });
  }, []);

  const hasSpeechRecognition = !!SpeechRecognitionAPI;
  const hasSpeechSynthesis = useServerTTS || (typeof window !== 'undefined' && 'speechSynthesis' in window);

  return {
    isListening,
    isSpeaking,
    transcript,
    voiceEnabled,
    availableVoices: ttsStatus?.voices || [],
    selectedVoiceId,
    setSelectedVoiceId,
    useServerTTS,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    toggleVoice,
    hasSpeechRecognition,
    hasSpeechSynthesis,
  };
}
