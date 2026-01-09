"""Session manager for Claude SDK clients."""

import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
)

from founder_os.stream import event_stream

# Repo root (founder-os/)
REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent


@dataclass
class ActiveSession:
    """An active Claude SDK client with metadata."""
    client: ClaudeSDKClient
    last_used: datetime = field(default_factory=datetime.now)


class SessionManager:
    """
    Manages Claude SDK client instances with TTL and LRU eviction.

    - Lazy creation: clients created on first message
    - 24-hour TTL: clients reused within TTL
    - Max 10 clients: LRU eviction when exceeded
    """

    def __init__(
        self,
        ttl_seconds: int = 86400,  # 24 hours
        max_clients: int = 10,
    ):
        self.ttl = timedelta(seconds=ttl_seconds)
        self.max_clients = max_clients
        self._clients: dict[str, ActiveSession] = {}
        self._lock = asyncio.Lock()

    def _create_options(self, claude_session_id: str | None = None) -> ClaudeAgentOptions:
        """Create SDK options for a session.

        Args:
            claude_session_id: Claude's internal session ID for resuming a conversation.
                              If provided, the session will be resumed from that point.
        """
        return ClaudeAgentOptions(
            cwd=REPO_ROOT,
            mcp_servers=REPO_ROOT / "mcp.json",
            setting_sources=["project"],  # Loads CLAUDE.md
            system_prompt={"type": "preset", "preset": "claude_code"},
            resume=claude_session_id,  # Resume from Claude's session if provided
            include_partial_messages=True,  # Enable streaming partial text
        )

    def _is_expired(self, session: ActiveSession) -> bool:
        """Check if session has expired."""
        return datetime.now() - session.last_used > self.ttl

    def _evict_lru(self) -> None:
        """Evict least recently used client."""
        if not self._clients:
            return
        oldest_id = min(self._clients, key=lambda k: self._clients[k].last_used)
        del self._clients[oldest_id]

    async def get_client(self, session_id: str, claude_session_id: str | None = None) -> ClaudeSDKClient:
        """
        Get or create a Claude SDK client for a session.

        Args:
            session_id: Our internal session ID (used as key in _clients dict)
            claude_session_id: Claude's internal session ID for resuming (used when
                              recreating an evicted client)

        Returns existing client if within TTL, otherwise creates new one.
        If claude_session_id is provided and client needs to be recreated,
        it will resume from that conversation.
        """
        async with self._lock:
            # Check for existing valid client
            if session_id in self._clients:
                session = self._clients[session_id]
                if not self._is_expired(session):
                    session.last_used = datetime.now()
                    return session.client
                else:
                    # Expired, remove it
                    del self._clients[session_id]

            # Evict if at capacity
            if len(self._clients) >= self.max_clients:
                self._evict_lru()

            # Create new client (with resume if we have Claude's session ID)
            options = self._create_options(claude_session_id)
            client = ClaudeSDKClient(options=options)
            await client.connect()

            self._clients[session_id] = ActiveSession(client=client)
            return client

    async def send_message(
        self, session_id: str, prompt: str, claude_session_id: str | None = None
    ) -> tuple[str, str]:
        """
        Send a message and get the full structured response.

        Args:
            session_id: Our internal session ID
            prompt: The user's message
            claude_session_id: Claude's session ID for resume (if we have one stored)

        Emits events to Redis stream as Claude responds:
        - text_delta: Incremental text as it streams
        - text: Final complete TextBlock content
        - tool_call: ToolUseBlock (tool name and input)
        - tool_result: ToolResultBlock (tool output)

        Returns:
            Tuple of (blocks_json, claude_session_id) where blocks_json is a JSON
            array of content blocks (text and tool_use with results) in order.
        """
        client = await self.get_client(session_id, claude_session_id)

        await client.query(prompt)

        # Track blocks in order for persistence
        blocks: list[dict] = []
        # Map tool_use_id to block index for adding results later
        tool_use_index: dict[str, int] = {}
        # Track accumulated text per block ID
        accumulated_text: dict[str, str] = {}
        result_session_id: str | None = None

        # Use receive_messages() instead of receive_response() to get partial updates
        async for message in client.receive_messages():
            msg_type = type(message).__name__

            # Handle StreamEvent for real-time streaming deltas
            if msg_type == "StreamEvent":
                event = message.event
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        text_chunk = delta.get("text", "")
                        if text_chunk:
                            await event_stream.publish(
                                session_id,
                                "text_delta",
                                {"content": text_chunk},
                            )
                continue

            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        block_id = getattr(block, 'id', 'default')
                        accumulated_text[block_id] = block.text
                        # Add or update text block
                        blocks.append({"type": "text", "text": block.text})

                    elif isinstance(block, ToolUseBlock):
                        await event_stream.publish(
                            session_id,
                            "tool_call",
                            {
                                "id": block.id,
                                "name": block.name,
                                "input": block.input,
                            },
                        )
                        # Add tool_use block and track index
                        tool_use_index[block.id] = len(blocks)
                        blocks.append({
                            "type": "tool_use",
                            "id": block.id,
                            "name": block.name,
                            "input": block.input,
                        })

                    elif isinstance(block, ToolResultBlock):
                        await event_stream.publish(
                            session_id,
                            "tool_result",
                            {
                                "tool_use_id": block.tool_use_id,
                                "content": block.content,
                                "is_error": block.is_error,
                            },
                        )
                        # Add result to corresponding tool_use block
                        if block.tool_use_id in tool_use_index:
                            idx = tool_use_index[block.tool_use_id]
                            blocks[idx]["result"] = block.content
                            blocks[idx]["is_error"] = block.is_error

            elif isinstance(message, ResultMessage):
                result_session_id = message.session_id
                # ResultMessage indicates completion - break out of loop
                break

        # Emit final complete text
        for block_id, text in accumulated_text.items():
            await event_stream.publish(
                session_id,
                "text",
                {"content": text},
            )

        return json.dumps(blocks), result_session_id or ""

    async def cleanup_expired(self) -> int:
        """Remove expired clients. Returns count removed."""
        async with self._lock:
            expired = [
                sid for sid, session in self._clients.items()
                if self._is_expired(session)
            ]
            for sid in expired:
                del self._clients[sid]
            return len(expired)


# Global instance
session_manager = SessionManager()
