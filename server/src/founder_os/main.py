"""Founder OS Agent Server."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from founder_os.api import router

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
