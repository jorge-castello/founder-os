"""File server endpoints for browsing the repo."""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# Repo root (founder-os/)
REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent

# Directories/files to exclude from listing
EXCLUDED = {".git", "node_modules", ".venv", "__pycache__", ".env", ".env.local"}

router = APIRouter(prefix="/files", tags=["files"])


class FileEntry(BaseModel):
    name: str
    path: str
    is_dir: bool


class FileContent(BaseModel):
    path: str
    content: str


def _is_safe_path(path: Path) -> bool:
    """Check if path is within repo root (prevent directory traversal)."""
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
        return True
    except ValueError:
        return False


def _list_dir(dir_path: Path, relative_to: Path) -> list[FileEntry]:
    """List directory contents, excluding hidden/ignored items."""
    entries = []
    try:
        for item in sorted(dir_path.iterdir()):
            if item.name in EXCLUDED or item.name.startswith("."):
                continue
            rel_path = item.relative_to(relative_to)
            entries.append(
                FileEntry(
                    name=item.name,
                    path=str(rel_path),
                    is_dir=item.is_dir(),
                )
            )
    except PermissionError:
        pass
    return entries


@router.get("", response_model=list[FileEntry])
async def list_files(path: str = "") -> list[FileEntry]:
    """
    List files in the repo.

    Args:
        path: Relative path within repo (empty for root)
    """
    target = REPO_ROOT / path if path else REPO_ROOT

    if not _is_safe_path(target):
        raise HTTPException(status_code=403, detail="Access denied")

    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")

    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    return _list_dir(target, REPO_ROOT)


@router.get("/{file_path:path}", response_model=FileContent)
async def read_file(file_path: str) -> FileContent:
    """
    Read a file's content.

    Args:
        file_path: Relative path to file within repo
    """
    target = REPO_ROOT / file_path

    if not _is_safe_path(target):
        raise HTTPException(status_code=403, detail="Access denied")

    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if target.is_dir():
        raise HTTPException(status_code=400, detail="Path is a directory, not a file")

    # Check if file is in excluded list
    if target.name in EXCLUDED:
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        content = target.read_text()
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Binary file not supported")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return FileContent(path=file_path, content=content)
