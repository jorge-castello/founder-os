"""
Tests for file endpoints.
"""

import pytest


@pytest.mark.asyncio
async def test_list_files_root(client):
    """GET /files should list root directory."""
    response = await client.get("/files")

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    # Should have some files/directories (at least CLAUDE.md exists)
    assert len(data) > 0
    # Each entry should have required fields
    for entry in data:
        assert "name" in entry
        assert "path" in entry
        assert "is_dir" in entry


@pytest.mark.asyncio
async def test_list_files_excludes_hidden(client):
    """GET /files should exclude .git, node_modules, etc."""
    response = await client.get("/files")

    assert response.status_code == 200
    data = response.json()
    names = [entry["name"] for entry in data]
    assert ".git" not in names
    assert "node_modules" not in names
    assert ".venv" not in names
    assert "__pycache__" not in names


@pytest.mark.asyncio
async def test_list_files_subdirectory(client):
    """GET /files?path=server should list server directory."""
    response = await client.get("/files", params={"path": "server"})

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    # Server directory should have src, pyproject.toml, etc.
    names = [entry["name"] for entry in data]
    assert "src" in names or "pyproject.toml" in names


@pytest.mark.asyncio
async def test_read_file(client):
    """GET /files/{path} should return file content."""
    response = await client.get("/files/CLAUDE.md")

    assert response.status_code == 200
    data = response.json()
    assert "path" in data
    assert "content" in data
    assert data["path"] == "CLAUDE.md"
    assert len(data["content"]) > 0


@pytest.mark.asyncio
async def test_read_file_not_found(client):
    """GET /files/{path} should return 404 for missing file."""
    response = await client.get("/files/nonexistent-file.txt")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_directory_traversal_blocked(client):
    """GET /files should block directory traversal attempts."""
    response = await client.get("/files", params={"path": "../../../etc/passwd"})

    assert response.status_code == 403
    # API returns "Access denied" for traversal attempts
    assert "denied" in response.json()["detail"].lower()
