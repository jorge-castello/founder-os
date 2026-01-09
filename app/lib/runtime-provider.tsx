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
  assistant_blocks: string | null; // JSON array of content blocks
  created_at: string;
}

// Block types from backend
interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock;

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

  if (turn.assistant_blocks) {
    // Parse blocks JSON and convert to assistant-ui format
    const blocks: ContentBlock[] = JSON.parse(turn.assistant_blocks);
    const content: ThreadMessageLike["content"] = blocks.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      } else {
        // tool_use block
        return {
          type: "tool-call" as const,
          toolCallId: block.id,
          toolName: block.name,
          args: block.input as Record<string, string | number | boolean | null>,
          argsText: JSON.stringify(block.input, null, 2),
          result: block.result as string | number | boolean | null | Record<string, unknown> | undefined,
          isError: block.is_error,
        };
      }
    });

    messages.push({
      role: "assistant",
      content,
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

async function generateTitle(sessionId: string): Promise<string> {
  const response = await fetch(
    `${API_BASE}/sessions/${sessionId}/generate-title`,
    { method: "POST" }
  );
  if (!response.ok) throw new Error("Failed to generate title");
  const data = await response.json();
  return data.title;
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

      // Track content items in arrival order (text and tool calls interleaved)
      type ContentItem =
        | { type: "text"; text: string }
        | {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            args: Record<string, string | number | boolean | null>;
            argsText: string;
            result?: string | number | boolean | null | Record<string, unknown>;
            isError?: boolean;
          };
      const contentItems: ContentItem[] = [];
      let currentTextIndex: number | null = null; // Track current text block for streaming

      // Helper to build content array from ordered items
      const buildContent = (): ThreadMessageLike["content"] => {
        if (contentItems.length === 0) {
          return [{ type: "text" as const, text: "" }];
        }
        return contentItems.map((item) => {
          if (item.type === "text") {
            return { type: "text" as const, text: item.text };
          }
          return {
            type: "tool-call" as const,
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            args: item.args,
            argsText: item.argsText,
            result: item.result,
            isError: item.isError,
          } as const;
        });
      };

      try {
        // Subscribe to SSE stream BEFORE sending message
        const eventSource = new EventSource(
          `${API_BASE}/sessions/${sessionId}/stream?last_id=$`
        );

        // Handle streaming events
        eventSource.addEventListener("text_delta", (event) => {
          const data = JSON.parse(event.data);

          // Append to current text block or create new one
          if (
            currentTextIndex !== null &&
            contentItems[currentTextIndex]?.type === "text"
          ) {
            (contentItems[currentTextIndex] as { type: "text"; text: string }).text += data.content;
          } else {
            currentTextIndex = contentItems.length;
            contentItems.push({ type: "text", text: data.content });
          }

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

          // Reset text index - next text will be a new block after this tool call
          currentTextIndex = null;

          contentItems.push({
            type: "tool-call",
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
          // Find the tool call by ID and update it
          const toolCall = contentItems.find(
            (item) =>
              item.type === "tool-call" && item.toolCallId === data.tool_use_id
          );
          if (toolCall && toolCall.type === "tool-call") {
            toolCall.result = data.content;
            toolCall.isError = data.is_error;
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

          // Final text - if there's content, ensure it's captured
          // This replaces the accumulated text with final version
          if (data.content) {
            // Find last text item or create one
            const lastTextIndex = contentItems.findLastIndex(
              (item) => item.type === "text"
            );
            if (lastTextIndex >= 0) {
              (contentItems[lastTextIndex] as { type: "text"; text: string }).text = data.content;
            } else {
              contentItems.push({ type: "text", text: data.content });
            }
          }

          // Mark complete
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

          // Generate title if session doesn't have one
          const currentSession = sessions.find((s) => s.id === sessionId);
          if (currentSession && !currentSession.title) {
            generateTitle(sessionId)
              .then((title) => {
                setSessions((prev) =>
                  prev.map((s) =>
                    s.id === sessionId ? { ...s, title } : s
                  )
                );
              })
              .catch((err) => {
                console.error("Failed to generate title:", err);
              });
          }
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
    [sessionId, sessions, setMessages, setSessions]
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
