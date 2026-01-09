"""Founder OS Agent Server."""

from fastapi import FastAPI

from founder_os.api import router

app = FastAPI(title="Founder OS", version="0.1.0")
app.include_router(router)
