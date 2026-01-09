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

      // Optimistically add user message
      const tempUserMessage: ThreadMessageLike = {
        role: "user",
        content: [{ type: "text", text: input }],
        id: `temp-user-${Date.now()}`,
        createdAt: new Date(),
        metadata: {},
        attachments: [],
      };
      setMessages((prev) => [...prev, tempUserMessage]);

      // Show loading state
      setIsRunning(true);

      try {
        // Send to backend
        const turn = await sendMessage(sessionId, input);

        // Replace temp message with real messages from the turn
        setMessages((prev) => {
          // Remove temp message
          const withoutTemp = prev.filter((m) => m.id !== tempUserMessage.id);
          // Add the real messages
          return [...withoutTemp, ...convertTurnToMessages(turn)];
        });
      } catch (error) {
        console.error("Failed to send message:", error);
        // Remove optimistic message on error
        setMessages((prev) => prev.filter((m) => m.id !== tempUserMessage.id));
        throw error;
      } finally {
        setIsRunning(false);
      }
    },
    [sessionId, setMessages]
  );

  // Memoize threads array to prevent reference changes on every render
  const threads = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        threadId: s.id,
        title: s.title || "New Chat",
        status: "regular" as const,
      })),
    [sessions]
  );

  // Memoize thread list adapter
  const threadListAdapter: ExternalStoreThreadListAdapter = useMemo(
    () => ({
      threadId: sessionId,
      threads,
      archivedThreads: [],

      onSwitchToNewThread: async () => {
        const newSession = await createSession();
        setSessions((prev) => [newSession, ...prev]);
        setMessages([]);
        await loadSession(newSession.id);
      },

      onSwitchToThread: async (threadId: string) => {
        await loadSession(threadId);
      },
    }),
    [sessionId, threads, setSessions, setMessages, loadSession]
  );

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
