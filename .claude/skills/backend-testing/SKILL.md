---
name: backend-testing
description: Automated testing for the Founder OS Python backend. Handles server lifecycle, test execution, and report generation.
---

# Backend Testing Skill

Automatically test the Python API after implementing backend changes.

## When to Use

Use this skill **automatically** after:
- Implementing new API endpoints
- Fixing bugs in `server/` code
- Modifying database models or queries
- Changing agent/Claude SDK integration

Do NOT ask the user - just run the tests.

## Workflow

### Step 1: Pre-flight Checks

```bash
# Check if port 8000 is in use
lsof -i :8000 | grep LISTEN

# If occupied, kill orphan processes
kill $(lsof -t -i:8000) 2>/dev/null || true

# Check Redis availability (optional)
redis-cli ping 2>/dev/null || echo "Redis unavailable - streaming tests will be skipped"
```

### Step 2: Start Server

```bash
cd /Users/jorgecastello/founderos/projects/founder-os/server

# Start server in background
uv run uvicorn founder_os.main:app --port 8000 &
SERVER_PID=$!

# Wait for health check (max 30 seconds)
for i in {1..30}; do
  if curl -s http://localhost:8000/health > /dev/null 2>&1; then
    echo "Server ready"
    break
  fi
  sleep 1
done
```

### Step 3: Run Tests

```bash
cd /Users/jorgecastello/founderos/projects/founder-os/server

# Run pytest with verbose output
uv run pytest tests/ -v --tb=short
```

Capture the exit code and output for the report.

### Step 4: Handle Failures

If tests fail:
1. Read the failure output
2. Identify the failing test and error
3. Fix the code
4. Restart server (kill → start → health check)
5. Re-run tests
6. Repeat until green or you've identified an issue requiring user input

### Step 5: Generate Report

Create a markdown report at:
`/Users/jorgecastello/founderos/projects/founder-os/server/test-reports/report-YYYY-MM-DD-HHMMSS.md`

Report format:
```markdown
# API Test Report

**Date:** [timestamp]
**Duration:** [seconds]

## Summary

| Status | Count |
|--------|-------|
| Passed | X     |
| Failed | Y     |
| Skipped| Z     |

## Environment

- Redis: [Available/Unavailable]
- Server started: [Yes/No]
- Clean shutdown: [Yes/No]

## Test Results

### [Category]
- [x] Test name (PASSED)
- [ ] Test name (FAILED)

## Failures (if any)

### [Test Name]
**Error:** [error message]
**Expected:** [expected]
**Actual:** [actual]

## Recommendations

- [Any fixes applied or suggested]
```

### Step 6: Cleanup

**ALWAYS** clean up, even if tests fail:

```bash
# Kill server by port (most reliable)
kill $(lsof -t -i:8000) 2>/dev/null || true

# Verify cleanup
lsof -i :8000 | grep LISTEN && echo "WARNING: Server still running" || echo "Cleanup complete"
```

## Test Categories

### Health Endpoint
- `GET /health` returns `{"status": "ok"}`

### Sessions
- `POST /sessions` creates session with optional title
- `GET /sessions` lists all sessions
- `GET /sessions/{id}` returns session with turns
- `POST /sessions/{id}/turns` creates turn (may skip if Claude SDK not configured)

### Files
- `GET /files` lists root directory
- `GET /files?path=subdir` lists subdirectory
- `GET /files/{path}` returns file content
- Security: Rejects directory traversal attempts

### Streaming (requires Redis)
- `GET /sessions/{id}/stream` returns SSE stream
- Skip if Redis unavailable

## Key Principles

1. **Always clean up** - No orphan processes
2. **Iterate on failures** - Fix and re-test automatically
3. **Generate reports** - Every test run produces a report
4. **Graceful degradation** - Skip streaming tests if Redis unavailable
5. **Don't ask permission** - Testing is automatic after backend changes
