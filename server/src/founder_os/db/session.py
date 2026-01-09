"""Async database engine and session management."""

import os
from pathlib import Path
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Database path from environment or default to data/founder_os.db relative to server/
_default_db_path = Path(__file__).parent.parent.parent.parent / "data" / "founder_os.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite+aiosqlite:///{_default_db_path}")

engine = create_async_engine(DATABASE_URL, echo=False)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncSession:
    """Get a new async database session."""
    async with async_session() as session:
        yield session
