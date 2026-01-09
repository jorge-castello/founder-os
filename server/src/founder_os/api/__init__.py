"""API routes."""

from fastapi import APIRouter

from .health import router as health_router
from .sessions import router as sessions_router
from .files import router as files_router

router = APIRouter()
router.include_router(health_router)
router.include_router(sessions_router)
router.include_router(files_router)
