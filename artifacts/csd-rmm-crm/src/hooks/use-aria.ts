import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';

export type AIModel = 'claude' | 'chatgpt' | 'gemini';

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

interface Message {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  isStreaming?: boolean;
  modelUsed?: string;
}

interface Conversation {
  id: number;
  sessionId: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ModelConfig {
  name: string;
  displayName: string;
  provider: string;
  modelId: string;
  configured: boolean;
}

interface AriaStatus {
  configured: boolean;
  models: ModelConfig[];
  defaultModel: AIModel | null;
}

export function useAria(initialConversationId?: number) {
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<number | null>(initialConversationId || null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedModel, setSelectedModel] = useState<AIModel | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);

  const { data: ariaStatus } = useQuery<AriaStatus>({
    queryKey: ['/api/aria/status'],
  });

  useEffect(() => {
    if (ariaStatus?.defaultModel && selectedModel === null) {
      setSelectedModel(ariaStatus.defaultModel);
    }
  }, [ariaStatus?.defaultModel, selectedModel]);

  const effectiveModel = selectedModel || ariaStatus?.defaultModel || 'claude';

  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ['/api/aria/conversations'],
  });

  const availableModels = ariaStatus?.models?.filter(m => m.configured) || [];

  const loadConversation = useCallback(async (id: number) => {
    try {
      const res = await apiRequest('GET', `/api/aria/conversations/${id}`);
      const data = await res.json();
      setConversationId(id);
      setMessages(data.messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        modelUsed: m.modelVersion,
      })));
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  }, []);

  const createConversation = useCallback(async () => {
    try {
      const res = await apiRequest('POST', '/api/aria/conversations', {});
      const data = await res.json();
      setConversationId(data.id);
      setMessages([]);
      queryClient.invalidateQueries({ queryKey: ['/api/aria/conversations'] });
      return data;
    } catch (error) {
      console.error('Failed to create conversation:', error);
      throw error;
    }
  }, [queryClient]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isStreamingRef.current) return;

    try {
      let currentConversationId = conversationId;
      if (!currentConversationId) {
        const conv = await createConversation();
        currentConversationId = conv.id;
      }

      const userMessage: Message = { role: 'user', content, createdAt: new Date().toISOString() };
      setMessages(prev => [...prev, userMessage]);

      const assistantMessage: Message = { role: 'assistant', content: '', isStreaming: true, modelUsed: effectiveModel };
      setMessages(prev => [...prev, assistantMessage]);

      setIsStreaming(true);
      isStreamingRef.current = true;
      abortControllerRef.current = new AbortController();

      const response = await apiRequest('POST', '/api/aria/chat/stream', {
          conversationId: currentConversationId,
          message: content,
          model: effectiveModel,
        }, {
        signal: abortControllerRef.current.signal,
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error('No reader available');

      let fullContent = '';
      let pendingEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        pendingEvent += decoder.decode(value, { stream: true });
        const lines = pendingEvent.split('\n');
        pendingEvent = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'chunk') {
                fullContent += data.content;
                setMessages(prev => {
                  const newMessages = [...prev];
                  const lastIndex = newMessages.length - 1;
                  newMessages[lastIndex] = {
                    ...newMessages[lastIndex],
                    content: fullContent,
                  };
                  return newMessages;
                });
              } else if (data.type === 'done') {
                setMessages(prev => {
                  const newMessages = [...prev];
                  const lastIndex = newMessages.length - 1;
                  newMessages[lastIndex] = {
                    ...newMessages[lastIndex],
                    id: data.messageId,
                    isStreaming: false,
                  };
                  return newMessages;
                });
              } else if (data.type === 'error') {
                throw new Error(data.error);
              }
            } catch (e) {
            }
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: ['/api/aria/conversations'] });
    } catch (error: unknown) {
      const normalizedError = asError(error);
      if (normalizedError.name !== 'AbortError') {
        console.error('Stream error:', normalizedError);
        setMessages(prev => {
          if (prev.length === 0 || prev[prev.length - 1]?.role !== 'assistant') {
            return prev;
          }
          const newMessages = [...prev];
          const lastIndex = newMessages.length - 1;
          newMessages[lastIndex] = {
            ...newMessages[lastIndex],
            content: 'Sorry, I encountered an error. Please try again.',
            isStreaming: false,
          };
          return newMessages;
        });
      }
    } finally {
      setIsStreaming(false);
      isStreamingRef.current = false;
      abortControllerRef.current = null;
    }
  }, [conversationId, createConversation, queryClient, effectiveModel]);

  const stopStreaming = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const clearConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
  }, []);

  const deleteConversation = useCallback(async (id: number) => {
    try {
      await apiRequest('DELETE', `/api/aria/conversations/${id}`);
      queryClient.invalidateQueries({ queryKey: ['/api/aria/conversations'] });
      if (conversationId === id) {
        clearConversation();
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  }, [conversationId, clearConversation, queryClient]);

  return {
    conversationId,
    messages,
    conversations,
    isStreaming,
    isConfigured: ariaStatus?.configured ?? false,
    availableModels,
    selectedModel: effectiveModel,
    setSelectedModel: (m: AIModel) => setSelectedModel(m),
    sendMessage,
    stopStreaming,
    loadConversation,
    createConversation,
    clearConversation,
    deleteConversation,
  };
}
