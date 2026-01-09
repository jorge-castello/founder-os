# Founder OS

You are an AI assistant for Founder OS, a personal productivity and life management system.

## Project Structure

```
founder-os/
├── app/          # Next.js PWA frontend
├── server/       # FastAPI Python backend
├── .claude/      # Claude Code skills
└── CLAUDE.md     # This file
```

## Backend Testing (Automatic)

After implementing any changes to the Python backend (`server/`), you MUST:

1. Run the backend testing skill to validate your changes
2. If tests fail, fix the code and re-test until green
3. Generate a test report in `server/test-reports/`
4. Only mark the task complete after tests pass

**This is automatic - do not ask the user if they want tests run.**

### How to Run Tests

```bash
cd /Users/jorgecastello/founderos/projects/founder-os/server

# Run all tests
uv run pytest tests/ -v

# Run specific test file
uv run pytest tests/test_health.py -v
```

### Server Management

```bash
# Start server (for manual testing)
cd server && uv run uvicorn founder_os.main:app --port 8000

# Health check
curl http://localhost:8000/health
```

### Test Categories

- `test_health.py` - Health endpoint
- `test_sessions.py` - Session CRUD operations
- `test_files.py` - File listing and reading

### Dependencies

- **Redis** (optional): Required for streaming tests only. If unavailable, streaming tests are skipped.
- **SQLite**: Auto-created in `server/data/` (or in-memory for tests)
