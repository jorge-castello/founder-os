"""Session CRUD endpoints."""

from datetime import datetime
from uuid import uuid4

import json

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from founder_os.db import Session, Turn, get_session
from founder_os.agent import session_manager
from founder_os.stream import event_stream

router = APIRouter(prefix="/sessions", tags=["sessions"])


# --- Schemas ---


class SessionCreate(BaseModel):
    title: str | None = None


class SessionUpdate(BaseModel):
    title: str | None = None


class TurnResponse(BaseModel):
    id: str
    user_content: str | None
    assistant_blocks: str | None  # JSON array of content blocks
    created_at: datetime

    class Config:
        from_attributes = True


class SessionResponse(BaseModel):
    id: str
    title: str | None
    status: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SessionDetailResponse(SessionResponse):
    turns: list[TurnResponse]


class TurnCreate(BaseModel):
    content: str


class TurnMessageResponse(BaseModel):
    id: str
    user_content: str
    assistant_blocks: str  # JSON array of content blocks


# --- Routes ---


@router.post("", response_model=SessionResponse)
async def create_session(
    data: SessionCreate,
    db: AsyncSession = Depends(get_session),
) -> Session:
    """Create a new session."""
    session = Session(
        id=str(uuid4()),
        title=data.title,
        status="active",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


@router.get("", response_model=list[SessionResponse])
async def list_sessions(
    db: AsyncSession = Depends(get_session),
) -> list[Session]:
    """List all sessions."""
    result = await db.execute(
        select(Session).order_by(Session.created_at.desc())
    )
    return list(result.scalars().all())


@router.get("/{session_id}", response_model=SessionDetailResponse)
async def get_session_detail(
    session_id: str,
    db: AsyncSession = Depends(get_session),
) -> Session:
    """Get a session with its turns."""
    result = await db.execute(
        select(Session)
        .where(Session.id == session_id)
        .options(selectinload(Session.turns))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.patch("/{session_id}", response_model=SessionResponse)
async def update_session(
    session_id: str,
    data: SessionUpdate,
    db: AsyncSession = Depends(get_session),
) -> Session:
    """Update a session (e.g., title)."""
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if data.title is not None:
        session.title = data.title

    await db.commit()
    await db.refresh(session)
    return session


@router.post("/{session_id}/turns", response_model=TurnMessageResponse)
async def create_turn(
    session_id: str,
    data: TurnCreate,
    db: AsyncSession = Depends(get_session),
) -> Turn:
    """Send a message and get Claude's response."""
    # Verify session exists
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Create turn immediately with user content (assistant_blocks will be updated later)
    turn = Turn(
        id=str(uuid4()),
        session_id=session_id,
        user_content=data.content,
        assistant_blocks=None,
    )
    db.add(turn)
    await db.commit()
    await db.refresh(turn)

    # Send to Claude (pass stored claude_session_id for resume if available)
    assistant_blocks, claude_session_id = await session_manager.send_message(
        session_id, data.content, session.claude_session_id
    )

    # Store Claude's session ID for future resume
    if claude_session_id and session.claude_session_id != claude_session_id:
        session.claude_session_id = claude_session_id

    # Update turn with assistant response (blocks JSON)
    turn.assistant_blocks = assistant_blocks
    await db.commit()
    await db.refresh(turn)

    return turn


@router.get("/{session_id}/stream")
async def stream_session(
    session_id: str,
    last_id: str = "0",
) -> EventSourceResponse:
    """
    Stream events for a session via Server-Sent Events.

    Args:
        session_id: Session to stream
        last_id: Resume from this event ID ("0" for all history, "$" for new only)
    """

    async def event_generator():
        async for event_id, event_type, data in event_stream.subscribe(
            session_id, last_id=last_id
        ):
            yield {
                "event": event_type,
                "id": event_id,
                "data": json.dumps(data),
            }

    return EventSourceResponse(event_generator())


class TitleResponse(BaseModel):
    title: str


@router.post("/{session_id}/generate-title", response_model=TitleResponse)
async def generate_title(
    session_id: str,
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Generate a title for a session based on its conversation."""
    import anthropic

    # Get session with turns
    result = await db.execute(
        select(Session)
        .where(Session.id == session_id)
        .options(selectinload(Session.turns))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.turns:
        raise HTTPException(status_code=400, detail="Session has no messages")

    # Build conversation summary for title generation
    conversation = []
    for turn in session.turns[:3]:  # Use first 3 turns max
        if turn.user_content:
            conversation.append(f"User: {turn.user_content[:200]}")
        if turn.assistant_blocks:
            # Extract text from blocks
            blocks = json.loads(turn.assistant_blocks)
            text_parts = [b["text"] for b in blocks if b.get("type") == "text"]
            assistant_text = " ".join(text_parts)[:200]
            if assistant_text:
                conversation.append(f"Assistant: {assistant_text}")

    conversation_text = "\n".join(conversation)

    # Call Claude to generate title
    client = anthropic.Anthropic()
    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=50,
        messages=[
            {
                "role": "user",
                "content": f"""Generate a short, descriptive title (3-6 words) for this conversation. Return only the title, no quotes or extra text.

Conversation:
{conversation_text}""",
            }
        ],
    )

    title = message.content[0].text.strip()

    # Update session title
    session.title = title
    await db.commit()

    return {"title": title}
