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

## Frontend Testing (Automatic)

After implementing any changes to the Next.js frontend (`app/`), you MUST:

1. Use the `webapp-testing` skill to validate your changes
2. If tests fail, fix the code and re-test until green
3. Only mark the task complete after tests pass

**This is automatic - do not ask the user if they want tests run.**

### How to Test

Use the webapp-testing skill with Playwright. Start both servers and run automation:

```bash
# Using the skill's helper script
python ~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/webapp-testing/scripts/with_server.py \
  --server "cd /Users/jorgecastello/founderos/projects/founder-os/server && uv run uvicorn founder_os.main:app --port 8000" --port 8000 \
  --server "cd /Users/jorgecastello/founderos/projects/founder-os/app && npm run dev" --port 3000 \
  -- python test_script.py
```

### Playwright Pattern

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:3000')
    page.wait_for_load_state('networkidle')  # Critical for Next.js

    # Take screenshot for inspection
    page.screenshot(path='/tmp/test.png')

    # Your test assertions here
    assert page.title() != ""

    browser.close()
```

### Frontend URLs

- **App**: http://localhost:3000
- **API**: http://localhost:8000
