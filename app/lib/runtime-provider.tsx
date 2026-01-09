"use client";

import { ReactNode, useState, useCallback, useEffect, useMemo } from "react";
import {
  useExternalStoreRuntime,
  ThreadMessageLike,
  AppendMessage,
  AssistantRuntimeProvider,
  ExternalStoreThreadListAdapter,
} from "@assistant-ui/react";

// Backend API configuration
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

// Types matching our FastAPI backend
interface Turn {
  id: string;
  user_content: string | null;
  assistant_content: string | null;
  created_at: string;
}

interface Session {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  turns?: Turn[];
}

// Convert our Turn format to assistant-ui's ThreadMessageLike
const convertTurnToMessages = (turn: Turn): ThreadMessageLike[] => {
  const messages: ThreadMessageLike[] = [];

  if (turn.user_content) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: turn.user_content }],
      id: `${turn.id}-user`,
      createdAt: new Date(turn.created_at),
      metadata: {},
      attachments: [],
    });
  }

  if (turn.assistant_content) {
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: turn.assistant_content }],
      id: `${turn.id}-assistant`,
      createdAt: new Date(turn.created_at),
      status: { type: "complete", reason: "stop" },
      metadata: {},
    });
  }

  return messages;
};

// API functions
async function fetchSessions(): Promise<Session[]> {
  const response = await fetch(`${API_BASE}/sessions`);
  if (!response.ok) throw new Error("Failed to fetch sessions");
  return response.json();
}

async function createSession(): Promise<Session> {
  const response = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: null }),
  });
  if (!response.ok) throw new Error("Failed to create session");
  return response.json();
}

async function fetchSessionDetail(sessionId: string): Promise<Session> {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}`);
  if (!response.ok) throw new Error("Failed to fetch session");
  return response.json();
}

async function sendMessage(
  sessionId: string,
  content: string
): Promise<Turn> {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error("Failed to send message");
  return response.json();
}

// Inner component that only renders when we have session data
function RuntimeProviderInner({
  children,
  sessionId,
  sessions,
  setSessions,
  messages,
  setMessages,
  loadSession,
}: {
  children: ReactNode;
  sessionId: string;
  sessions: Session[];
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  messages: ThreadMessageLike[];
  setMessages: React.Dispatch<React.SetStateAction<ThreadMessageLike[]>>;
  loadSession: (id: string) => Promise<void>;
}) {
  const [isRunning, setIsRunning] = useState(false);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      // Extract text content
      const textContent = message.content.find((c) => c.type === "text");
      if (!textContent || textContent.type !== "text") {
        throw new Error("Only text messages are supported");
      }

      const input = textContent.text;
      const timestamp = Date.now();
      const userMessageId = `user-${timestamp}`;
      const assistantMessageId = `assistant-${timestamp}`;

      // Add user message
      const userMessage: ThreadMessageLike = {
        role: "user",
        content: [{ type: "text", text: input }],
        id: userMessageId,
        createdAt: new Date(),
        metadata: {},
        attachments: [],
      };
      setMessages((prev) => [...prev, userMessage]);

      // Add placeholder assistant message (streaming)
      const assistantMessage: ThreadMessageLike = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        id: assistantMessageId,
        createdAt: new Date(),
        status: { type: "running" },
        metadata: {},
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setIsRunning(true);

      // Track accumulated text and tool calls for streaming
      let accumulatedText = "";
      interface ToolCallState {
        toolCallId: string;
        toolName: string;
        args: Record<string, string | number | boolean | null>;
        argsText: string;
        result?: string | number | boolean | null | Record<string, unknown>;
        isError?: boolean;
      }
      const toolCalls: Map<string, ToolCallState> = new Map();

      // Helper to build content array from accumulated state
      const buildContent = (): ThreadMessageLike["content"] => {
        const content: Array<
          | { type: "text"; text: string }
          | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly args: Record<string, string | number | boolean | null>; readonly argsText: string; readonly result?: string | number | boolean | null | Record<string, unknown>; readonly isError?: boolean }
        > = [];

        if (accumulatedText) {
          content.push({ type: "text", text: accumulatedText });
        }

        for (const tc of toolCalls.values()) {
          content.push({
            type: "tool-call" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
            argsText: tc.argsText,
            result: tc.result,
            isError: tc.isError,
          } as const);
        }

        return content.length > 0 ? content : [{ type: "text" as const, text: "" }];
      };

      try {
        // Subscribe to SSE stream BEFORE sending message
        const eventSource = new EventSource(
          `${API_BASE}/sessions/${sessionId}/stream?last_id=$`
        );

        // Handle streaming events
        eventSource.addEventListener("text_delta", (event) => {
          const data = JSON.parse(event.data);
          accumulatedText += data.content;

          // Update assistant message with new content
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, content: buildContent() }
                : m
            )
          );
        });

        // Handle tool call events from backend
        eventSource.addEventListener("tool_call", (event) => {
          const data = JSON.parse(event.data);
          // data: { id, name, input }
          const input = data.input || {};
          toolCalls.set(data.id, {
            toolCallId: data.id,
            toolName: data.name,
            args: input as Record<string, string | number | boolean | null>,
            argsText: JSON.stringify(input, null, 2),
          });

          // Update assistant message with tool call
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, content: buildContent() }
                : m
            )
          );
        });

        // Handle tool result events from backend
        eventSource.addEventListener("tool_result", (event) => {
          const data = JSON.parse(event.data);
          // data: { tool_use_id, content, is_error }
          const existing = toolCalls.get(data.tool_use_id);
          if (existing) {
            existing.result = data.content;
            existing.isError = data.is_error;
          }

          // Update assistant message with tool result
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, content: buildContent() }
                : m
            )
          );
        });

        eventSource.addEventListener("text", (event) => {
          const data = JSON.parse(event.data);
          accumulatedText = data.content;
          // Final text - update and mark complete
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: buildContent(),
                    status: { type: "complete", reason: "stop" },
                  }
                : m
            )
          );
          eventSource.close();
          setIsRunning(false);
        });

        eventSource.onerror = () => {
          eventSource.close();
          setIsRunning(false);
        };

        // Send message to backend (this triggers Claude response)
        await sendMessage(sessionId, input);
      } catch (error) {
        console.error("Failed to send message:", error);
        // Mark as error
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? {
                  ...m,
                  content: [{ type: "text", text: "Error: Failed to get response" }],
                  status: { type: "incomplete", reason: "error" },
                }
              : m
          )
        );
        setIsRunning(false);
        throw error;
      }
    },
    [sessionId, setMessages]
  );

  // Build threads array from sessions
  const threads = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        title: s.title || "New Chat",
        status: "regular" as const,
      })),
    [sessions]
  );

  // Create thread list adapter - spread threads to ensure new array reference
  // This works around a bug in assistant-ui where the runtime's _threads
  // doesn't get initialized on construction due to reference comparison
  const threadListAdapter: ExternalStoreThreadListAdapter = {
    threadId: sessionId,
    threads: [...threads], // Spread to create new reference each render
    archivedThreads: [],
    isLoading: false,

    onSwitchToNewThread: async () => {
      const newSession = await createSession();
      setSessions((prev) => [newSession, ...prev]);
      setMessages([]);
      await loadSession(newSession.id);
    },

    onSwitchToThread: async (threadId: string) => {
      await loadSession(threadId);
    },
  };

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    onNew,
    convertMessage: (message) => message,
    adapters: {
      threadList: threadListAdapter,
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

export function FounderOSRuntimeProvider({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);

  // Load session messages
  const loadSession = useCallback(async (id: string) => {
    const session = await fetchSessionDetail(id);
    setSessionId(id);
    if (session.turns && session.turns.length > 0) {
      setMessages(session.turns.flatMap(convertTurnToMessages));
    } else {
      setMessages([]);
    }
  }, []);

  // Initialize: load sessions list, create or select first session
  useEffect(() => {
    const init = async () => {
      const existingSessions = await fetchSessions();
      setSessions(existingSessions);

      if (existingSessions.length > 0) {
        // Load most recent session
        await loadSession(existingSessions[0].id);
      } else {
        // Create first session
        const newSession = await createSession();
        setSessions([newSession]);
        setSessionId(newSession.id);
        setMessages([]);
      }
    };

    init();
  }, [loadSession]);

  // Don't render until we have a session and it's in the sessions list
  if (!sessionId || sessions.length === 0 || !sessions.some(s => s.id === sessionId)) {
    return null;
  }

  return (
    <RuntimeProviderInner
      sessionId={sessionId}
      sessions={sessions}
      setSessions={setSessions}
      messages={messages}
      setMessages={setMessages}
      loadSession={loadSession}
    >
      {children}
    </RuntimeProviderInner>
  );
}
