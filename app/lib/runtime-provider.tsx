"use client";

import { ReactNode, useState, useCallback, useEffect } from "react";
import {
  useExternalStoreRuntime,
  ThreadMessageLike,
  AppendMessage,
  AssistantRuntimeProvider,
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
      status: { type: "complete" },
      metadata: {},
    });
  }

  return messages;
};

// API functions
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

export function FounderOSRuntimeProvider({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  // Initialize session on mount
  useEffect(() => {
    const initSession = async () => {
      const session = await createSession();
      setSessionId(session.id);

      // If session has turns, load them
      if (session.turns && session.turns.length > 0) {
        const loadedMessages = session.turns.flatMap(convertTurnToMessages);
        setMessages(loadedMessages);
      }
    };

    initSession();
  }, []);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      if (!sessionId) {
        console.error("No session ID available");
        return;
      }

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
          const withoutTemp = prev.filter(
            (m) => m.id !== tempUserMessage.id
          );
          // Add the real messages
          return [...withoutTemp, ...convertTurnToMessages(turn)];
        });
      } catch (error) {
        console.error("Failed to send message:", error);
        // Remove optimistic message on error
        setMessages((prev) =>
          prev.filter((m) => m.id !== tempUserMessage.id)
        );
        throw error;
      } finally {
        setIsRunning(false);
      }
    },
    [sessionId]
  );

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    onNew,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
