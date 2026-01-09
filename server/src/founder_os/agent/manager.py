"""Session manager for Claude SDK clients."""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions, AssistantMessage, TextBlock

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

    def _create_options(self, session_id: str) -> ClaudeAgentOptions:
        """Create SDK options for a session."""
        return ClaudeAgentOptions(
            cwd=REPO_ROOT,
            mcp_servers=REPO_ROOT / "mcp.json",
            setting_sources=["project"],  # Loads CLAUDE.md
            system_prompt={"type": "preset", "preset": "claude_code"},
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

    async def get_client(self, session_id: str) -> ClaudeSDKClient:
        """
        Get or create a Claude SDK client for a session.

        Returns existing client if within TTL, otherwise creates new one.
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

            # Create new client
            options = self._create_options(session_id)
            client = ClaudeSDKClient(options=options)
            await client.connect()

            self._clients[session_id] = ActiveSession(client=client)
            return client

    async def send_message(self, session_id: str, prompt: str) -> str:
        """
        Send a message and get the full text response.

        Returns the concatenated text from all TextBlocks.
        """
        client = await self.get_client(session_id)

        await client.query(prompt)

        text_parts: list[str] = []
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        text_parts.append(block.text)

        return "".join(text_parts)

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
