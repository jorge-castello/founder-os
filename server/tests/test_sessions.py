"""
Tests for session endpoints.
"""

import pytest


@pytest.mark.asyncio
async def test_create_session_without_title(client):
    """POST /sessions should create a session without title."""
    response = await client.post("/sessions", json={})

    assert response.status_code == 200
    data = response.json()
    assert "id" in data
    assert data["title"] is None
    assert data["status"] == "active"
    assert "created_at" in data
    assert "updated_at" in data


@pytest.mark.asyncio
async def test_create_session_with_title(client):
    """POST /sessions should create a session with title."""
    response = await client.post("/sessions", json={"title": "Test Session"})

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Test Session"


@pytest.mark.asyncio
async def test_list_sessions_empty(client):
    """GET /sessions should return empty list when no sessions."""
    response = await client.get("/sessions")

    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.asyncio
async def test_list_sessions_with_data(client):
    """GET /sessions should return all sessions."""
    # Create two sessions
    await client.post("/sessions", json={"title": "Session 1"})
    await client.post("/sessions", json={"title": "Session 2"})

    response = await client.get("/sessions")

    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    # Verify both sessions exist (order may vary)
    titles = {s["title"] for s in data}
    assert titles == {"Session 1", "Session 2"}


@pytest.mark.asyncio
async def test_get_session_detail(client):
    """GET /sessions/{id} should return session with turns."""
    # Create session
    create_response = await client.post("/sessions", json={"title": "Detail Test"})
    session_id = create_response.json()["id"]

    response = await client.get(f"/sessions/{session_id}")

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == session_id
    assert data["title"] == "Detail Test"
    assert "turns" in data
    assert data["turns"] == []


@pytest.mark.asyncio
async def test_get_session_not_found(client):
    """GET /sessions/{id} should return 404 for invalid ID."""
    response = await client.get("/sessions/nonexistent-id")

    assert response.status_code == 404
    assert response.json()["detail"] == "Session not found"
