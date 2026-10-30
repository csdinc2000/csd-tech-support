import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import ariaAvatar from "@assets/CSD_Tech_Support_Logo.png_1783482672036.png";

type ChatMessage = { role: "user" | "assistant"; content: string };

const WELCOME: ChatMessage = {
  role: "assistant",
  content:
    "Hi! I'm Aria, the Computer Systems Depot assistant. Ask me about our services, remote support, or how to start a repair. How can I help?",
};

export default function SupportChatWidget({
  hideLauncherOnMobile = false,
  onOpenChange,
}: {
  hideLauncherOnMobile?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  function setChatOpen(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await apiRequest("POST", "/api/aria/support-chat", {
          messages: next
            .filter((m) => m.content !== WELCOME.content)
            .map((m) => ({ role: m.role, content: m.content })),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply || "" },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            err?.message ||
            "Sorry, something went wrong. Please call (954) 637-7300.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      className="fixed right-4 z-50 flex flex-col items-end"
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
    >
      {open && (
        <div
          role="dialog"
          aria-label="Support chat"
          className="mb-3 flex h-[60dvh] max-h-[calc(100dvh-6rem-env(safe-area-inset-bottom,0px))] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl sm:h-[32rem]"
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between bg-blue-600 px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <img src={ariaAvatar} alt="Aria" className="h-8 w-8 rounded-full object-cover" />
              <div className="leading-tight">
                <div className="text-sm font-semibold">Ask Aria</div>
                <div className="text-xs text-blue-100">Computer Systems Depot</div>
              </div>
            </div>
            <button
              onClick={() => setChatOpen(false)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-white/20 sm:min-h-0 sm:min-w-0 sm:p-1"
              aria-label="Close chat"
              data-testid="button-close-support-chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-gray-50 p-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "flex",
                  m.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                    m.role === "user"
                      ? "rounded-br-sm bg-blue-600 text-white"
                      : "rounded-bl-sm border border-gray-200 bg-white text-gray-800",
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Aria is typing…
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="flex shrink-0 items-center gap-2 border-t border-gray-200 bg-white p-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type your question…"
              disabled={loading}
              className="flex-1"
              data-testid="input-support-chat"
            />
            <Button
              size="icon"
              onClick={send}
              disabled={loading || !input.trim()}
              className="bg-blue-600 hover:bg-blue-700"
              aria-label="Send message"
              data-testid="button-send-support-chat"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="shrink-0 border-t border-gray-100 bg-white px-3 py-1.5 text-[10px] leading-snug text-gray-400">
            Aria is an AI assistant and can make mistakes — for anything important, please
            confirm with our team.
          </p>
        </div>
      )}

      {/* Launcher bubble */}
      <button
        onClick={() => setChatOpen(!open)}
        className={cn(
          "h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition-transform hover:scale-105 hover:bg-blue-700",
          open || hideLauncherOnMobile ? "hidden sm:flex" : "flex",
        )}
        aria-label={open ? "Close chat" : "Open chat"}
        aria-expanded={open}
        data-testid="button-toggle-support-chat"
      >
        {open ? <X className="h-6 w-6" /> : <img src={ariaAvatar} alt="Aria" className="h-full w-full rounded-full object-cover" />}
      </button>
    </div>
  );
}
