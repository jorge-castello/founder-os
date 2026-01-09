"""
Tests for the health endpoint.
"""

import pytest


@pytest.mark.asyncio
async def test_health_returns_ok(client):
    """GET /health should return status ok."""
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
