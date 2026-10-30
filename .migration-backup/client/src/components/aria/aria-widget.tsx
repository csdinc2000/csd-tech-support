import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Send, Minimize2, Maximize2, StopCircle, Bot, Sparkles, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { SiOpenai, SiGooglegemini } from 'react-icons/si';
import ariaAvatar from '@assets/CSD_Tech_Support_Logo.png_1783482672036.png';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useAria, type AIModel } from '@/hooks/use-aria';
import { useVoice } from '@/hooks/use-voice';
import { Link } from 'wouter';

const MODEL_ICONS: Record<string, any> = {
  claude: Bot,
  chatgpt: SiOpenai,
  gemini: SiGooglegemini,
};

const MODEL_COLORS: Record<string, string> = {
  claude: 'text-orange-500',
  chatgpt: 'text-green-600',
  gemini: 'text-blue-500',
};

const MODEL_LABELS: Record<string, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
};

export default function AriaWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSpokenIndexRef = useRef<number>(-1);

  const {
    messages,
    isStreaming,
    isConfigured,
    availableModels,
    selectedModel,
    setSelectedModel,
    sendMessage,
    stopStreaming,
    clearConversation,
  } = useAria();

  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const handleVoiceTranscript = useCallback((text: string) => {
    setInputValue(text);
  }, []);

  const handleFinalTranscript = useCallback((text: string) => {
    if (text.trim()) {
      setInputValue('');
      sendMessageRef.current(text);
    }
  }, []);

  const {
    isListening,
    isSpeaking,
    voiceEnabled,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    toggleVoice,
    hasSpeechRecognition,
    hasSpeechSynthesis,
  } = useVoice({ onTranscript: handleVoiceTranscript, onFinalTranscript: handleFinalTranscript });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (isOpen && !isMinimized && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen, isMinimized]);

  useEffect(() => {
    if (messages.length === 0) {
      lastSpokenIndexRef.current = -1;
      return;
    }
    if (!voiceEnabled || isStreaming || !isOpen) return;

    const lastMsg = messages[messages.length - 1];
    const lastIndex = messages.length - 1;

    if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isStreaming && lastIndex > lastSpokenIndexRef.current) {
      lastSpokenIndexRef.current = lastIndex;
      speak(lastMsg.content);
    }
  }, [messages, isStreaming, voiceEnabled, isOpen, speak]);

  const handleSend = async () => {
    if (!inputValue.trim() || isStreaming) return;
    const message = inputValue;
    setInputValue('');
    stopSpeaking();
    await sendMessage(message);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMicToggle = () => {
    if (isListening) {
      stopListening();
    } else {
      stopSpeaking();
      setInputValue('');
      startListening();
    }
  };

  if (!isConfigured) return null;

  const SelectedIcon = MODEL_ICONS[selectedModel] || Bot;

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-primary text-white shadow-lg hover:bg-primary/90 transition-all duration-200 flex items-center justify-center group"
          title="Chat with ARIA"
        >
          <img src={ariaAvatar} alt="ARIA" className="w-full h-full rounded-full object-cover" />
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white" />
        </button>
      )}

      {isOpen && (
        <div
          className={cn(
            "fixed z-50 bg-white rounded-lg shadow-2xl border border-gray-200 flex flex-col transition-all duration-200",
            isMinimized
              ? "bottom-4 right-4 w-[calc(100vw-2rem)] max-w-[18rem] h-14"
              : "bottom-4 right-4 w-[calc(100vw-2rem)] max-w-sm sm:max-w-md h-[min(70vh,500px)]"
          )}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b bg-primary text-white rounded-t-lg">
            <div className="flex items-center space-x-2">
              <img src={ariaAvatar} alt="ARIA" className="w-8 h-8 rounded-full object-cover" />
              <div>
                <h3 className="font-semibold text-sm">ARIA</h3>
                <p className="text-xs text-white/80">
                  {isSpeaking ? "Speaking..." : isListening ? "Listening..." : "AI Business Assistant"}
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-1">
              {hasSpeechSynthesis && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleVoice}
                  className="text-white hover:bg-white/20 h-8 w-8 p-0"
                  title={voiceEnabled ? "Mute voice" : "Unmute voice"}
                >
                  {voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsMinimized(!isMinimized)}
                className="text-white hover:bg-white/20 h-8 w-8 p-0"
              >
                {isMinimized ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setIsOpen(false); stopSpeaking(); stopListening(); }}
                className="text-white hover:bg-white/20 h-8 w-8 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {!isMinimized && (
            <>
              <ScrollArea className="flex-1 p-4" ref={scrollRef}>
                {messages.length === 0 ? (
                  <div className="text-center text-gray-500 py-6">
                    <img src={ariaAvatar} alt="ARIA" className="w-12 h-12 rounded-full object-cover mx-auto mb-3" />
                    <p className="text-sm font-medium">Hi, I'm Aria!</p>
                    <p className="text-xs mt-1 mb-4">Your AI business assistant for CSD. How can I help?</p>
                    {hasSpeechRecognition && (
                      <p className="text-xs text-primary mb-4 flex items-center justify-center gap-1">
                        <Mic className="h-3 w-3" /> Click the mic to talk
                      </p>
                    )}
                    <div className="space-y-2">
                      <button
                        onClick={() => sendMessage("What's the current status of open tickets?")}
                        className="w-full text-left px-3 py-2 text-xs bg-gray-50 hover:bg-gray-100 rounded-md transition-colors flex items-center"
                      >
                        <Sparkles className="h-3 w-3 mr-2 text-primary" />
                        Check open tickets
                      </button>
                      <button
                        onClick={() => sendMessage("Generate a social media post about our repair services")}
                        className="w-full text-left px-3 py-2 text-xs bg-gray-50 hover:bg-gray-100 rounded-md transition-colors flex items-center"
                      >
                        <Sparkles className="h-3 w-3 mr-2 text-primary" />
                        Generate social post
                      </button>
                      <button
                        onClick={() => sendMessage("Help me with a sales pitch for managed IT services")}
                        className="w-full text-left px-3 py-2 text-xs bg-gray-50 hover:bg-gray-100 rounded-md transition-colors flex items-center"
                      >
                        <Sparkles className="h-3 w-3 mr-2 text-primary" />
                        Sales assistance
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {messages.map((msg, idx) => {
                      const msgModel = msg.modelUsed || selectedModel;
                      const MsgIcon = msg.role === 'assistant' ? (MODEL_ICONS[msgModel] || Bot) : null;
                      return (
                        <div
                          key={idx}
                          className={cn(
                            "flex",
                            msg.role === 'user' ? "justify-end" : "justify-start"
                          )}
                        >
                          <div className="max-w-[85%]">
                            {msg.role === 'assistant' && (
                              <div className="flex items-center gap-1 mb-1">
                                {MsgIcon && <MsgIcon className={cn("h-3 w-3", MODEL_COLORS[msgModel])} />}
                                <span className={cn("text-[10px] font-medium", MODEL_COLORS[msgModel])}>
                                  {MODEL_LABELS[msgModel] || msgModel}
                                </span>
                              </div>
                            )}
                            <div
                              className={cn(
                                "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                                msg.role === 'user'
                                  ? "bg-primary text-white"
                                  : "bg-gray-100 text-gray-900"
                              )}
                            >
                              {msg.content}
                              {msg.isStreaming && (
                                <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>

              {isListening && (
                <div className="flex items-center justify-center gap-2 px-3 py-2 bg-red-50 border-t border-red-200">
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-xs text-red-600 font-medium">Listening...</span>
                  {inputValue && <span className="text-xs text-gray-500 italic">"{inputValue}"</span>}
                </div>
              )}

              <div className="p-3 border-t">
                <div className="flex items-center space-x-2">
                  {availableModels.length > 1 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild disabled={isStreaming}>
                        <Button variant="ghost" size="icon" className="shrink-0 h-9 w-9">
                          <SelectedIcon className={cn("h-4 w-4", MODEL_COLORS[selectedModel])} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="top">
                        {availableModels.map((model) => {
                          const MIcon = MODEL_ICONS[model.name] || Bot;
                          return (
                            <DropdownMenuItem
                              key={model.name}
                              onClick={() => setSelectedModel(model.name as AIModel)}
                              className={cn("gap-2 cursor-pointer", selectedModel === model.name && "bg-accent")}
                            >
                              <MIcon className={cn("h-4 w-4", MODEL_COLORS[model.name])} />
                              {MODEL_LABELS[model.name] || model.displayName}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {hasSpeechRecognition && (
                    <Button
                      variant={isListening ? "destructive" : "ghost"}
                      size="icon"
                      onClick={handleMicToggle}
                      disabled={isStreaming}
                      className={cn("shrink-0 h-9 w-9", isListening && "animate-pulse")}
                      title={isListening ? "Stop" : "Talk to Aria"}
                    >
                      {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    </Button>
                  )}
                  <Input
                    ref={inputRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isListening ? "Listening..." : "Ask Aria anything..."}
                    disabled={isStreaming || isListening}
                    className="flex-1 text-sm"
                  />
                  {isStreaming ? (
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={stopStreaming}
                      className="shrink-0 h-9 w-9"
                    >
                      <StopCircle className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      onClick={handleSend}
                      disabled={!inputValue.trim() || isListening}
                      className="shrink-0 h-9 w-9"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                  <button
                    onClick={clearConversation}
                    className="hover:text-gray-700"
                    disabled={messages.length === 0}
                  >
                    New chat
                  </button>
                  <Link href="/aria" className="hover:text-primary">
                    Open full view
                  </Link>
                </div>
                <p className="mt-1.5 text-[10px] leading-snug text-gray-400">
                  ARIA provides AI-assisted suggestions and can make mistakes. It is not legal,
                  tax, medical, credit, or financial advice — material actions require human
                  review and authorization.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
