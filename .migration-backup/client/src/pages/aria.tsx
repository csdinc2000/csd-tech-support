import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Plus,
  Trash2,
  Clock,
  StopCircle,
  Bot,
  User as UserIcon,
  Sparkles,
  MessageCircle,
  FileText,
  Phone,
  TrendingUp,
  HelpCircle,
  ChevronDown,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Square
} from 'lucide-react';
import { SiOpenai, SiGooglegemini } from 'react-icons/si';
import ariaAvatar from '@assets/CSD_Tech_Support_Logo.png_1783482672036.png';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useAria, type AIModel } from '@/hooks/use-aria';
import { useVoice } from '@/hooks/use-voice';

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

export default function AriaPage() {
  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastSpokenIndexRef = useRef<number>(-1);

  const {
    conversationId,
    messages,
    conversations,
    isStreaming,
    isConfigured,
    availableModels,
    selectedModel,
    setSelectedModel,
    sendMessage,
    stopStreaming,
    loadConversation,
    clearConversation,
    deleteConversation,
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
    availableVoices,
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
  } = useVoice({ onTranscript: handleVoiceTranscript, onFinalTranscript: handleFinalTranscript });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (messages.length === 0) {
      lastSpokenIndexRef.current = -1;
      return;
    }
    if (!voiceEnabled || isStreaming) return;

    const lastMsg = messages[messages.length - 1];
    const lastIndex = messages.length - 1;

    if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isStreaming && lastIndex > lastSpokenIndexRef.current) {
      lastSpokenIndexRef.current = lastIndex;
      speak(lastMsg.content);
    }
  }, [messages, isStreaming, voiceEnabled, speak]);

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

  const suggestedPrompts = [
    { icon: MessageCircle, text: "Write me a week of social media posts", category: "Social Media" },
    { icon: Phone, text: "Create a phone script for following up on repair quotes", category: "Phone Scripts" },
    { icon: TrendingUp, text: "Help me handle a customer objection about pricing", category: "Sales" },
    { icon: FileText, text: "Generate a 30-day content calendar", category: "Marketing" },
    { icon: HelpCircle, text: "Create FAQ responses for common customer questions", category: "FAQ" },
    { icon: Sparkles, text: "What's the status of our current leads and tickets?", category: "Dashboard" },
  ];

  if (!isConfigured) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center">
            <Bot className="h-16 w-16 mx-auto mb-4 text-gray-400" />
            <h2 className="text-xl font-semibold mb-2">ARIA Not Configured</h2>
            <p className="text-gray-600 text-sm">
              No AI model API keys are configured.
              Please set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to enable ARIA.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <img src={ariaAvatar} alt="ARIA" className="w-10 h-10 rounded-full object-cover" />
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-gray-900">ARIA</h2>
              <p className="text-sm text-gray-600">AI Business Assistant</p>
              <p className="text-xs text-gray-400">
                AI-assisted suggestions only — not legal, tax, medical, credit, or financial
                advice. Material technical actions require human review and authorization.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            {hasSpeechSynthesis && (
              <VoiceSelector
                voiceEnabled={voiceEnabled}
                toggleVoice={toggleVoice}
                availableVoices={availableVoices}
                selectedVoiceId={selectedVoiceId}
                setSelectedVoiceId={setSelectedVoiceId}
                useServerTTS={useServerTTS}
              />
            )}
            <ModelSelector
              selectedModel={selectedModel}
              availableModels={availableModels}
              onSelect={setSelectedModel}
              disabled={isStreaming}
            />
            <Button onClick={clearConversation} variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              New Chat
            </Button>
          </div>
        </div>
      </div>

      <div className="flex h-[calc(100vh-8rem)]">
        <div className="hidden lg:flex w-64 border-r bg-white flex-col">
          <div className="p-4 border-b">
            <h3 className="font-semibold text-sm text-gray-600">Recent Conversations</h3>
          </div>
          <ScrollArea className="flex-1 p-2">
            {conversations.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No conversations yet</p>
            ) : (
              <div className="space-y-1">
                {conversations.map((conv) => (
                  <div
                    key={conv.id}
                    className={cn(
                      "group relative w-full text-left p-3 rounded-lg transition-colors text-sm",
                      conversationId === conv.id
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-gray-100 text-gray-700"
                    )}
                  >
                    <button
                      onClick={() => loadConversation(conv.id)}
                      className="w-full text-left"
                    >
                      <div className="font-medium truncate pr-6">
                        {conv.title || 'New conversation'}
                      </div>
                      <div className="text-xs text-gray-500 mt-1 flex items-center">
                        <Clock className="h-3 w-3 mr-1" />
                        {new Date(conv.updatedAt).toLocaleDateString()}
                      </div>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteConversation(conv.id);
                      }}
                      className="absolute right-2 top-3 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-gray-200 rounded"
                    >
                      <Trash2 className="h-3 w-3 text-gray-500" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        <div className="flex-1 flex flex-col">
          <ScrollArea className="flex-1 p-4 md:p-6" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="max-w-2xl mx-auto">
                <div className="text-center mb-8">
                  <img src={ariaAvatar} alt="ARIA" className="w-20 h-20 rounded-full object-cover mx-auto mb-4" />
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">Welcome to ARIA</h2>
                  <p className="text-gray-600">
                    Your AI-powered business assistant for Computer Systems Depot.
                    I can help with social media, sales, phone scripts, and more!
                  </p>
                  {hasSpeechRecognition && (
                    <p className="text-sm text-primary mt-2 flex items-center justify-center gap-1">
                      <Mic className="h-4 w-4" />
                      Voice enabled — click the mic to talk to Aria
                    </p>
                  )}
                  {availableModels.length > 1 && (
                    <p className="text-sm text-gray-500 mt-1">
                      Powered by {availableModels.map(m => MODEL_LABELS[m.name] || m.displayName).join(', ')}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {suggestedPrompts.map((prompt, idx) => {
                    const Icon = prompt.icon;
                    return (
                      <button
                        key={idx}
                        onClick={() => sendMessage(prompt.text)}
                        className="flex items-start p-4 bg-white rounded-lg border border-gray-200 hover:border-primary hover:shadow-md transition-all text-left"
                      >
                        <Icon className="h-5 w-5 text-primary mt-0.5 mr-3 shrink-0" />
                        <div>
                          <Badge variant="secondary" className="mb-2 text-xs">
                            {prompt.category}
                          </Badge>
                          <p className="text-sm text-gray-700">{prompt.text}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto space-y-6">
                {messages.map((msg, idx) => {
                  const msgModel = msg.modelUsed || selectedModel;
                  const MsgModelIcon = msg.role === 'assistant' ? (MODEL_ICONS[msgModel] || Bot) : UserIcon;
                  return (
                    <div
                      key={idx}
                      className={cn(
                        "flex",
                        msg.role === 'user' ? "justify-end" : "justify-start"
                      )}
                    >
                      <div
                        className={cn(
                          "flex items-start space-x-3 max-w-[85%]",
                          msg.role === 'user' && "flex-row-reverse space-x-reverse"
                        )}
                      >
                        <div
                          className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                            msg.role === 'user' ? "bg-primary" : "bg-gray-200"
                          )}
                        >
                          {msg.role === 'user' ? (
                            <UserIcon className="h-4 w-4 text-white" />
                          ) : (
                            <MsgModelIcon className={cn("h-4 w-4", MODEL_COLORS[msgModel] || "text-gray-600")} />
                          )}
                        </div>
                        <div>
                          {msg.role === 'assistant' && (
                            <span className={cn("text-xs font-medium mb-1 block", MODEL_COLORS[msgModel] || "text-gray-500")}>
                              {MODEL_LABELS[msgModel] || msgModel}
                            </span>
                          )}
                          <div
                            className={cn(
                              "rounded-lg px-4 py-3 text-sm",
                              msg.role === 'user'
                                ? "bg-primary text-white"
                                : "bg-white border border-gray-200 text-gray-900"
                            )}
                          >
                            <div className="whitespace-pre-wrap">{msg.content}</div>
                            {msg.isStreaming && (
                              <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          <div className="border-t bg-white p-4">
            <div className="max-w-3xl mx-auto">
              {isListening && (
                <div className="flex items-center justify-center gap-2 mb-3 py-2 px-4 bg-red-50 rounded-lg border border-red-200">
                  <div className="flex items-center gap-1">
                    <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                    <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                    <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }} />
                  </div>
                  <span className="text-sm text-red-600 font-medium">Listening...</span>
                  {inputValue && <span className="text-sm text-gray-600 italic ml-2">"{inputValue}"</span>}
                </div>
              )}
              {isSpeaking && (
                <div className="flex items-center justify-center gap-2 mb-3 py-2 px-4 bg-blue-50 rounded-lg border border-blue-200">
                  <Volume2 className="h-4 w-4 text-blue-500 animate-pulse" />
                  <span className="text-sm text-blue-600 font-medium">Aria is speaking...</span>
                  <button onClick={stopSpeaking} className="text-xs text-blue-500 hover:text-blue-700 underline ml-2">
                    Stop
                  </button>
                </div>
              )}
              <div className="flex items-end space-x-3">
                {hasSpeechRecognition && (
                  <Button
                    variant={isListening ? "destructive" : "outline"}
                    size="icon"
                    onClick={handleMicToggle}
                    disabled={isStreaming}
                    className={cn("h-12 w-12 shrink-0", isListening && "animate-pulse")}
                    title={isListening ? "Stop listening" : "Start voice input"}
                  >
                    {isListening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  </Button>
                )}
                <div className="flex-1 relative">
                  <Textarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isListening ? "Listening..." : "Ask ARIA anything..."}
                    disabled={isStreaming || isListening}
                    rows={1}
                    className="resize-none pr-12 min-h-[48px] max-h-32"
                  />
                </div>
                {isStreaming ? (
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={stopStreaming}
                    className="h-12 w-12"
                  >
                    <StopCircle className="h-5 w-5" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    onClick={handleSend}
                    disabled={!inputValue.trim() || isListening}
                    className="h-12 w-12"
                  >
                    <Send className="h-5 w-5" />
                  </Button>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-2 text-center">
                {voiceEnabled ? "Voice responses on" : "Voice responses off"} · Using {MODEL_LABELS[selectedModel]}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function VoiceSelector({
  voiceEnabled,
  toggleVoice,
  availableVoices,
  selectedVoiceId,
  setSelectedVoiceId,
  useServerTTS,
}: {
  voiceEnabled: boolean;
  toggleVoice: () => void;
  availableVoices: { id: string; name: string; description: string }[];
  selectedVoiceId: string;
  setSelectedVoiceId: (id: string) => void;
  useServerTTS: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" title={voiceEnabled ? "Voice on" : "Voice off"}>
          {voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-gray-400" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 max-h-64 overflow-y-auto">
        <DropdownMenuItem onClick={toggleVoice} className="cursor-pointer">
          {voiceEnabled ? (
            <><VolumeX className="h-4 w-4 mr-2" /> Turn voice off</>
          ) : (
            <><Volume2 className="h-4 w-4 mr-2" /> Turn voice on</>
          )}
        </DropdownMenuItem>
        {voiceEnabled && useServerTTS && availableVoices.length > 0 && (
          <>
            <div className="px-2 py-1.5 text-xs font-semibold text-gray-500 border-t mt-1 pt-1">Voice</div>
            {availableVoices.map((voice) => (
              <DropdownMenuItem
                key={voice.id}
                onClick={() => setSelectedVoiceId(voice.id)}
                className={cn("cursor-pointer text-xs", selectedVoiceId === voice.id && "bg-accent")}
              >
                <div className="flex flex-col">
                  <span className="font-medium">{voice.name}</span>
                  <span className="text-[10px] text-muted-foreground">{voice.description}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelSelector({
  selectedModel,
  availableModels,
  onSelect,
  disabled,
}: {
  selectedModel: AIModel;
  availableModels: { name: string; displayName: string; configured: boolean }[];
  onSelect: (model: AIModel) => void;
  disabled: boolean;
}) {
  if (availableModels.length <= 1) return null;

  const Icon = MODEL_ICONS[selectedModel] || Bot;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="outline" className="gap-2">
          <Icon className={cn("h-4 w-4", MODEL_COLORS[selectedModel])} />
          <span className="hidden sm:inline">{MODEL_LABELS[selectedModel]}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {availableModels.map((model) => {
          const ModelIcon = MODEL_ICONS[model.name] || Bot;
          return (
            <DropdownMenuItem
              key={model.name}
              onClick={() => onSelect(model.name as AIModel)}
              className={cn(
                "gap-2 cursor-pointer",
                selectedModel === model.name && "bg-accent"
              )}
            >
              <ModelIcon className={cn("h-4 w-4", MODEL_COLORS[model.name])} />
              {MODEL_LABELS[model.name] || model.displayName}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
