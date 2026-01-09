"""Redis Streams for decoupled event streaming."""

import json
import os
from typing import AsyncIterator

from redis.asyncio import Redis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
STREAM_MAX_LEN = 1000  # Max events per session stream
STREAM_TTL = 86400  # 24 hours


def _stream_key(session_id: str) -> str:
    """Get Redis stream key for a session."""
    return f"session:{session_id}:events"


class EventStream:
    """
    Redis Streams-based event streaming.

    Producer and consumer are fully decoupled:
    - Producer adds events with XADD
    - Consumer reads with XREAD from any position
    - Consumer can disconnect and reconnect with last_id
    """

    def __init__(self):
        self._redis: Redis | None = None

    async def _get_redis(self) -> Redis:
        """Get or create Redis connection."""
        if self._redis is None:
            self._redis = Redis.from_url(REDIS_URL, decode_responses=True)
        return self._redis

    async def publish(
        self,
        session_id: str,
        event_type: str,
        data: dict,
    ) -> str:
        """
        Publish an event to a session's stream.

        Returns the event ID.
        """
        redis = await self._get_redis()
        key = _stream_key(session_id)

        event_id = await redis.xadd(
            key,
            {"type": event_type, "data": json.dumps(data)},
            maxlen=STREAM_MAX_LEN,
        )

        # Set TTL on first event (refresh on each add would be expensive)
        # Stream auto-expires if no new events
        await redis.expire(key, STREAM_TTL)

        return event_id

    async def subscribe(
        self,
        session_id: str,
        last_id: str = "0",
        block_ms: int = 5000,
    ) -> AsyncIterator[tuple[str, str, dict]]:
        """
        Subscribe to a session's event stream.

        Args:
            session_id: Session to subscribe to
            last_id: Start reading after this ID ("0" for all, "$" for new only)
            block_ms: How long to block waiting for new events

        Yields:
            (event_id, event_type, data) tuples
        """
        redis = await self._get_redis()
        key = _stream_key(session_id)

        current_id = last_id
        while True:
            # XREAD blocks until new events or timeout
            result = await redis.xread({key: current_id}, block=block_ms, count=100)

            if not result:
                # Timeout, no new events - yield control and continue
                continue

            for stream_key, events in result:
                for event_id, fields in events:
                    current_id = event_id
                    yield (
                        event_id,
                        fields["type"],
                        json.loads(fields["data"]),
                    )

    async def close(self) -> None:
        """Close Redis connection."""
        if self._redis:
            await self._redis.close()
            self._redis = None


# Global instance
event_stream = EventStream()
