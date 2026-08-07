"""Internal auth verify endpoint for APISIX forward-auth.

APISIX calls GET /internal/auth/verify with the user's Authorization header.
On 200 it reads X-Uid from the response and injects it into the upstream
request, so backend / app-task trust the caller identity without each service
validating bili_session itself.

This endpoint is called directly by APISIX (http://backend:8000/internal/auth/verify),
NOT routed through APISIX, so it needs no APISIX key-auth. Backend is only
reachable on the container network.
"""

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.routers.auth import get_current_uid

router = APIRouter(prefix="/internal/auth", tags=["internal-auth"])


@router.get("/verify")
async def verify(uid: int = Depends(get_current_uid)):
    """Validate bili_session via get_current_uid; return X-Uid header on success.

    get_current_uid raises 401 on invalid/missing token -> APISIX forward-auth
    returns 401 to the client. On success, X-Uid header is injected upstream.
    """
    return JSONResponse({"ok": True, "uid": uid}, headers={"X-Uid": str(uid)})
