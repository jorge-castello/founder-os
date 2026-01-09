"""Founder OS Agent Server."""

from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from founder_os.api import router

# Load .env from server root (server/src/founder_os/main.py -> server/.env)
env_path = Path(__file__).parent.parent.parent / ".env"
load_dotenv(env_path)

app = FastAPI(title="Founder OS", version="0.1.0")

# Allow frontend to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
