from __future__ import annotations

import asyncio
import hmac
import json
import os
import threading
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import outlook_pool
from .account_sink import sync_pending
from .register_service import register_service


ADMIN_KEY = os.getenv("PROVISION_ADMIN_KEY", "")
app = FastAPI(title="image2api provisioner", docs_url=None, redoc_url=None)


class RegisterConfigRequest(BaseModel):
    mail: dict | None = None
    proxy: str | None = None
    total: int | None = None
    threads: int | None = None
    mode: str | None = None
    target_quota: int | None = None
    target_available: int | None = None
    check_interval: int | None = None


class MailPoolImportRequest(BaseModel):
    text: str = ""
    email_type: str = ""
    gen_alias: bool = False
    alias_count: int = 0


def require_admin(authorization: str | None) -> None:
    supplied = str(authorization or "").removeprefix("Bearer ").strip()
    if not ADMIN_KEY or not hmac.compare_digest(supplied, ADMIN_KEY):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "service": "image2api-provisioner"}


@app.get("/api/register")
def get_register(authorization: str | None = Header(default=None)) -> dict:
    require_admin(authorization)
    return {"register": register_service.get()}


@app.post("/api/register")
def update_register(body: RegisterConfigRequest, authorization: str | None = Header(default=None)) -> dict:
    require_admin(authorization)
    return {"register": register_service.update(body.model_dump(exclude_none=True))}


@app.post("/api/register/start")
def start_register(authorization: str | None = Header(default=None)) -> dict:
    require_admin(authorization)
    return {"register": register_service.start()}


@app.post("/api/register/stop")
def stop_register(authorization: str | None = Header(default=None)) -> dict:
    require_admin(authorization)
    return {"register": register_service.stop()}


@app.post("/api/register/reset")
def reset_register(authorization: str | None = Header(default=None)) -> dict:
    require_admin(authorization)
    return {"register": register_service.reset()}


@app.post("/api/register/mail-pool/import")
def import_mail_pool(body: MailPoolImportRequest, authorization: str | None = Header(default=None)) -> dict:
    require_admin(authorization)
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="import content is empty")
    return outlook_pool.import_accounts(
        body.text,
        email_type=body.email_type,
        gen_alias=body.gen_alias,
        alias_count=body.alias_count,
    )


@app.get("/api/register/mail-pool/stats")
def mail_pool_stats(authorization: str | None = Header(default=None)) -> dict:
    require_admin(authorization)
    return outlook_pool.stats()


@app.get("/api/register/events")
async def register_events(token: str = "") -> StreamingResponse:
    require_admin(f"Bearer {token}")

    async def stream():
        last = ""
        while True:
            payload = json.dumps(register_service.get(), ensure_ascii=False)
            if payload != last:
                last = payload
                yield f"data: {payload}\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(stream(), media_type="text/event-stream")


def _sync_loop() -> None:
    while True:
        sync_pending()
        time.sleep(60)


@app.on_event("startup")
def start_sync_loop() -> None:
    threading.Thread(target=_sync_loop, daemon=True, name="provision-sync").start()
