"""Public branding/assets and non-sensitive operational readiness endpoints."""
from __future__ import annotations

import asyncio
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .db import get_session
from .managed_assets import ASSET_BY_KEY, asset_path, detect_image_type

router = APIRouter()


@router.get('/config/public')
def public_config() -> dict:
    icon = ASSET_BY_KEY['web-app-icon']
    return {
        'app_name': settings.web_app_name,
        'app_icon': icon.public_path if asset_path(icon).is_file() else '',
        'log_level': settings.web_log_level,
    }


@router.get('/assets/{asset_key}')
def managed_asset_file(asset_key: str) -> FileResponse:
    asset = ASSET_BY_KEY.get(asset_key)
    if asset is None or not asset.public_path:
        raise HTTPException(status_code=404, detail='未知图片资源')
    path = asset_path(asset)
    if not path.is_file():
        raise HTTPException(status_code=404, detail='尚未上传图片')
    media_type = detect_image_type(path.read_bytes()) or 'application/octet-stream'
    return FileResponse(path, media_type=media_type, headers={'Cache-Control': 'no-cache'})


@router.get('/health/live', include_in_schema=False)
def liveness() -> dict:
    return {'ok': True}


def create_readiness_router(voice) -> APIRouter:
    readiness = APIRouter()

    @readiness.get('/health/ready', include_in_schema=False)
    async def ready(session: Session = Depends(get_session)):
        checks = {'database': False, 'voice': False}
        try:
            session.execute(text('SELECT 1'))
            checks['database'] = True
        except Exception:
            pass
        try:
            await asyncio.wait_for(voice.ping(), timeout=2.0)
            checks['voice'] = True
        except Exception:
            pass
        ok = all(checks.values())
        return JSONResponse({'ok': ok, 'checks': checks}, status_code=200 if ok else 503)

    return readiness
