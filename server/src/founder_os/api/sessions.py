"""Session CRUD endpoints."""

from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from founder_os.db import Session, Turn, get_session
from founder_os.agent import session_manager

router = APIRouter(prefix="/sessions", tags=["sessions"])


# --- Schemas ---


class SessionCreate(BaseModel):
    title: str | None = None  # TODO: Auto-generate from first message


class TurnResponse(BaseModel):
    id: str
    user_content: str | None
    assistant_content: str | None
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
    assistant_content: str


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

    # Send to Claude and get response
    assistant_content = await session_manager.send_message(session_id, data.content)

    # Save turn to database
    turn = Turn(
        id=str(uuid4()),
        session_id=session_id,
        user_content=data.content,
        assistant_content=assistant_content,
    )
    db.add(turn)
    await db.commit()
    await db.refresh(turn)

    return turn
