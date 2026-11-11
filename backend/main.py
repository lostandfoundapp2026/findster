# Save as: backend/main.py
"""Main FastAPI application for the San Leonardo Lost and Found System."""
import logging
import os
import re
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from uuid import UUID
import jwt
import mysql.connector
from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import (
    BaseModel,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)
from pwdlib import PasswordHash
from auth import get_current_user
from database import get_db_connection
from reports import router as reports_router
from claims import router as claims_router
from notifications import router as notifications_router
from chat import router as chat_router
from push_notifications import router as push_router
from password_reset import router as password_reset_router
# ============================================================
# APPLICATION CONFIGURATION
# ============================================================
logger = logging.getLogger(__name__)
app = FastAPI(
    title="Lost and Found API",
    description=(
        "Backend API for the San Leonardo "
        "Lost and Found mobile app"
    ),
    version="1.0.0",
)
# ============================================================
# CORS CONFIGURATION
# ============================================================
# Existing development origins are preserved.
# Configure production origins through CORS_ORIGINS.
DEFAULT_CORS_ORIGINS = [
    "capacitor://localhost",
    "ionic://localhost",
    "http://localhost",
    "https://localhost",
    "http://localhost:8100",
    "http://localhost:8101",
    "http://127.0.0.1",
    "http://127.0.0.1:8100",
    "http://127.0.0.1:8101",
    "http://192.168.100.73:8100",
    "http://192.168.100.73:8101",
]
additional_origins = [
    origin.strip().rstrip("/")
    for origin in os.getenv(
        "CORS_ORIGINS",
        "",
    ).split(",")
    if origin.strip()
]
allowed_origins = sorted(
    set(
        DEFAULT_CORS_ORIGINS
        + additional_origins
    )
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=[
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
    ],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Accept",
    ],
)
# ============================================================
# PASSWORD CONFIGURATION
# ============================================================
password_hash = PasswordHash.recommended()
# ============================================================
# BARANGAY CONFIGURATION
# ============================================================
BARANGAYS = [
    "San Bartolome",
    "Burgos",
    "Rizal",
    "Bonifacio",
    "Mallorca",
    "Mambangnan",
    "Diversion",
    "Tambo-Adorable",
    "Nieves",
    "Tabuating",
    "Magpapalayoc",
    "San Anton",
    "Castellano",
    "Tagumpay",
    "San Roque",
]
# ============================================================
# SECURE PUBLIC REPORT IMAGE SERVING
# ============================================================
# Only the report-images directory is exposed.
# Do not mount the entire backend/uploads directory.
# Use persistent storage on Railway and local storage during development.
STORAGE_ROOT = Path(
    os.getenv(
        "FINDSTER_STORAGE_ROOT",
        "/app/storage"
        if os.getenv("RAILWAY_ENVIRONMENT")
        else str(Path(__file__).resolve().parent),
    )
).expanduser().resolve()

UPLOADS_DIR = STORAGE_ROOT / "uploads"
REPORT_PHOTOS_DIR = (
    UPLOADS_DIR / "reports"
)
REPORT_PHOTOS_DIR.mkdir(
    parents=True,
    exist_ok=True,
)
REPORT_PHOTOS_DIR = REPORT_PHOTOS_DIR.resolve()
ALLOWED_REPORT_EXTENSIONS = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
REPORT_IMAGE_PATTERN = re.compile(
    r"^[0-9a-f]{32}\.(jpg|png|webp)$"
)
@app.get(
    "/uploads/reports/{filename}",
    include_in_schema=False,
)
def serve_report_image(filename: str):
    """Serve only UUID-named public report images."""
    # Reject unexpected filenames, extensions, and paths.
    if not REPORT_IMAGE_PATTERN.fullmatch(filename):
        raise HTTPException(
            status_code=404,
            detail="Image not found.",
        )
    # Validate the UUID component.
    filename_stem = filename.rsplit(
        ".",
        1,
    )[0]
    try:
        parsed_uuid = UUID(
            hex=filename_stem
        )
        if parsed_uuid.hex != filename_stem:
            raise ValueError(
                "Noncanonical UUID filename."
            )
    except ValueError:
        raise HTTPException(
            status_code=404,
            detail="Image not found.",
        )
    image_path = (
        REPORT_PHOTOS_DIR / filename
    ).resolve()
    # Defense in depth against escaping the upload directory.
    if image_path.parent != REPORT_PHOTOS_DIR:
        raise HTTPException(
            status_code=404,
            detail="Image not found.",
        )
    if not image_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Image not found.",
        )
    media_type = ALLOWED_REPORT_EXTENSIONS.get(
        image_path.suffix.lower()
    )
    if media_type is None:
        raise HTTPException(
            status_code=404,
            detail="Image not found.",
        )
    return FileResponse(
        path=str(image_path),
        media_type=media_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "public, max-age=300",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )
# ============================================================
# AUTHENTICATION RATE LIMITING
# ============================================================
LOGIN_WINDOW_SECONDS = 300
LOGIN_MAX_ATTEMPTS = 10
REGISTER_WINDOW_SECONDS = 3600
REGISTER_MAX_ATTEMPTS = 5
# In-memory development throttling.
#
# For production deployments involving multiple workers or
# multiple server instances, use a shared Redis-based limiter.
login_attempts = defaultdict(deque)
register_attempts = defaultdict(deque)
login_lock = Lock()
register_lock = Lock()
_rate_limit_last_cleanup = 0.0
_rate_limit_cleanup_lock = Lock()
RATE_LIMIT_CLEANUP_INTERVAL = 300
def _prune_attempts(
    attempts: deque,
    now: float,
    window_seconds: int,
):
    """Remove timestamps outside the current rate-limit window."""
    while (
        attempts
        and now - attempts[0] >= window_seconds
    ):
        attempts.popleft()
def _cleanup_rate_limit_store(
    store,
    store_lock,
    window_seconds: int,
    now: float,
):
    """Remove expired timestamps and empty client entries."""
    with store_lock:
        expired_clients = []
        for client_ip, attempts in store.items():
            _prune_attempts(
                attempts,
                now,
                window_seconds,
            )
            if not attempts:
                expired_clients.append(
                    client_ip
                )
        for client_ip in expired_clients:
            store.pop(
                client_ip,
                None,
            )
def cleanup_rate_limits():
    """Periodically clear old login and registration counters."""
    global _rate_limit_last_cleanup
    now = time.monotonic()
    with _rate_limit_cleanup_lock:
        if (
            now - _rate_limit_last_cleanup
            < RATE_LIMIT_CLEANUP_INTERVAL
        ):
            return
        _rate_limit_last_cleanup = now
    _cleanup_rate_limit_store(
        login_attempts,
        login_lock,
        LOGIN_WINDOW_SECONDS,
        now,
    )
    _cleanup_rate_limit_store(
        register_attempts,
        register_lock,
        REGISTER_WINDOW_SECONDS,
        now,
    )
def _enforce_rate_limit(
    client_ip: str,
    store,
    store_lock,
    window_seconds: int,
    max_attempts: int,
    message: str,
):
    """Count an attempt and reject requests exceeding the limit."""
    cleanup_rate_limits()
    now = time.monotonic()
    with store_lock:
        attempts = store[client_ip]
        _prune_attempts(
            attempts,
            now,
            window_seconds,
        )
        if len(attempts) >= max_attempts:
            retry_after = max(
                1,
                int(
                    window_seconds
                    - (now - attempts[0])
                ) + 1,
            )
            raise HTTPException(
                status_code=429,
                detail=message,
                headers={
                    "Retry-After": str(
                        retry_after
                    ),
                },
            )
        attempts.append(now)
def enforce_login_rate_limit(
    client_ip: str,
):
    _enforce_rate_limit(
        client_ip=client_ip,
        store=login_attempts,
        store_lock=login_lock,
        window_seconds=LOGIN_WINDOW_SECONDS,
        max_attempts=LOGIN_MAX_ATTEMPTS,
        message=(
            "Too many login attempts. "
            "Please try again later."
        ),
    )
def enforce_register_rate_limit(
    client_ip: str,
):
    _enforce_rate_limit(
        client_ip=client_ip,
        store=register_attempts,
        store_lock=register_lock,
        window_seconds=REGISTER_WINDOW_SECONDS,
        max_attempts=REGISTER_MAX_ATTEMPTS,
        message=(
            "Too many registration attempts. "
            "Please try again later."
        ),
    )
def clear_login_attempts(
    client_ip: str,
):
    """Clear login attempts after successful authentication."""
    with login_lock:
        login_attempts.pop(
            client_ip,
            None,
        )
def get_client_ip(
    request: Request,
) -> str:
    """Use the peer IP supplied by the ASGI server.
    Do not trust arbitrary X-Forwarded-For headers.
    Configure trusted proxy handling separately if deployed
    behind a reverse proxy.
    """
    if request.client:
        return request.client.host
    return "unknown"
# ============================================================
# REQUEST MODELS
# ============================================================
class RegisterRequest(BaseModel):
    # New registrations use structured names. Keep full_name optional for
    # older app builds during the rollout of the updated registration form.
    first_name: str | None = Field(default=None, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    full_name: str | None = Field(default=None, max_length=100)
    email: EmailStr
    contact_number: str = Field(min_length=7, max_length=20)
    barangay: str
    password: str = Field(min_length=8, max_length=128)
    @field_validator('first_name', 'middle_name', 'last_name', 'full_name')
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = ' '.join(value.split())
        return cleaned or None
    @field_validator('contact_number')
    @classmethod
    def validate_contact(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError('Contact number is required.')
        return value
    @model_validator(mode='after')
    def validate_names(self):
        has_structured_name = bool(self.first_name and self.last_name)
        if has_structured_name:
            if len(self.first_name) < 2 or len(self.last_name) < 2:
                raise ValueError('First and last names must have at least 2 characters.')
            self.full_name = ' '.join(
                part for part in (self.first_name, self.middle_name, self.last_name)
                if part
            )
            if len(self.full_name) > 100:
                raise ValueError('Full name must not exceed 100 characters.')
        elif self.first_name or self.middle_name or self.last_name:
            raise ValueError('Both first name and last name are required.')
        elif not self.full_name or len(self.full_name) < 2:
            raise ValueError('Please provide first and last name.')
        return self
class UpdateProfileRequest(BaseModel):
    """Editable account fields. Email changes need a separate verified flow."""

    first_name: str = Field(min_length=2, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str = Field(min_length=2, max_length=100)
    contact_number: str = Field(min_length=11, max_length=11)
    barangay: str

    @field_validator("first_name", "last_name")
    @classmethod
    def normalize_required_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("First and last names must have at least 2 characters.")
        return value

    @field_validator("middle_name")
    @classmethod
    def normalize_optional_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return " ".join(value.split()) or None

    @field_validator("contact_number")
    @classmethod
    def validate_mobile_number(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"09\d{9}", value):
            raise ValueError("Enter an 11-digit mobile number starting with 09.")
        return value

    @model_validator(mode="after")
    def validate_combined_name(self):
        name = " ".join(
            part for part in (self.first_name, self.middle_name, self.last_name)
            if part
        )
        if len(name) > 100:
            raise ValueError("Full name must not exceed 100 characters.")
        return self


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(
        min_length=1,
        max_length=128,
    )
# ============================================================
# DATABASE HELPERS
# ============================================================
def close_db_resources(
    cursor=None,
    connection=None,
):
    """Close database cursor and connection safely."""
    if cursor is not None:
        try:
            cursor.close()
        except Exception:
            logger.exception(
                "Unable to close database cursor."
            )
    if connection is not None:
        try:
            connection.close()
        except Exception:
            logger.exception(
                "Unable to close database connection."
            )
def rollback_db(
    connection,
):
    """Safely roll back a database transaction."""
    if connection is not None:
        try:
            connection.rollback()
        except Exception:
            logger.exception(
                "Database rollback failed."
            )
# ============================================================
# JWT CONFIGURATION
# ============================================================
def require_jwt_configuration() -> str:
    secret = os.getenv(
        "JWT_SECRET"
    )
    algorithm = os.getenv(
        "JWT_ALGORITHM",
        "HS256",
    ).strip().upper()
    if (
        not secret
        or algorithm != "HS256"
    ):
        logger.error(
            "JWT configuration is missing or invalid."
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Authentication is not configured."
            ),
        )
    return secret
# ============================================================
# PUBLIC HEALTH ENDPOINTS
# ============================================================
@app.get("/")
def home():
    return {
        "message": (
            "Lost and Found API is running!"
        ),
        "municipality": (
            "San Leonardo, Nueva Ecija"
        ),
    }
@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "message": (
            "Backend is working correctly."
        ),
    }
# ============================================================
# AUTHENTICATED DATABASE HEALTH CHECK
# ============================================================
@app.get("/api/db-check")
def database_check(
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None
    try:
        connection = get_db_connection()
        cursor = connection.cursor()
        cursor.execute(
            "SELECT 1"
        )
        cursor.fetchone()
        return {
            "status": "ok",
            "database": "connected",
            "users_table": "not_checked",
        }
    except Exception as exc:
        logger.exception(
            "Database health check failed."
        )
        raise HTTPException(
            status_code=503,
            detail="Database check failed.",
        ) from exc
    finally:
        close_db_resources(
            cursor,
            connection,
        )
# ============================================================
# REGISTER USER
# ============================================================
@app.post(
    "/api/register",
    status_code=201,
)
def register_user(
    data: RegisterRequest,
    request: Request,
):
    client_ip = get_client_ip(
        request
    )
    # Limit repeated account registration attempts.
    enforce_register_rate_limit(
        client_ip
    )
    if data.barangay not in BARANGAYS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Please select a valid barangay "
                "in San Leonardo."
            ),
        )
    connection = None
    cursor = None
    email = str(
        data.email
    ).lower().strip()
    try:
        connection = get_db_connection()
        cursor = connection.cursor(
            dictionary=True
        )
        cursor.execute(
            """
            SELECT id
            FROM users
            WHERE email = %s
            LIMIT 1
            """,
            (email,),
        )
        if cursor.fetchone():
            raise HTTPException(
                status_code=409,
                detail=(
                    "This email is already registered."
                ),
            )
        hashed_password = password_hash.hash(
            data.password
        )
        cursor.execute(
            """
            INSERT INTO users (
                full_name,
                first_name,
                middle_name,
                last_name,
                email,
                contact_number,
                barangay,
                password_hash
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                data.full_name,
                data.first_name,
                data.middle_name,
                data.last_name,
                email,
                data.contact_number,
                data.barangay,
                hashed_password,
            ),
        )
        user_id = cursor.lastrowid
        connection.commit()
        logger.info(
            "User registration successful user_id=%s",
            user_id,
        )
        return {
            "message": (
                "Registration successful!"
            ),
            "user": {
                "id": user_id,
                "full_name": data.full_name,
                "first_name": data.first_name,
                "middle_name": data.middle_name,
                "last_name": data.last_name,
                "email": email,
                "contact_number": (
                    data.contact_number
                ),
                "barangay": data.barangay,
            },
        }
    except HTTPException:
        rollback_db(connection)
        raise
    except mysql.connector.IntegrityError as exc:
        rollback_db(connection)
        if getattr(
            exc,
            "errno",
            None,
        ) == 1062:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This email is already registered."
                ),
            ) from exc
        logger.exception(
            "Registration integrity error."
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Registration failed. "
                "Please try again."
            ),
        ) from exc
    except Exception as exc:
        rollback_db(connection)
        logger.exception(
            "Registration failed."
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Registration failed. "
                "Please try again."
            ),
        ) from exc
    finally:
        close_db_resources(
            cursor,
            connection,
        )
# ============================================================
# LOGIN USER
# ============================================================
@app.post("/api/login")
def login_user(
    data: LoginRequest,
    request: Request,
):
    client_ip = get_client_ip(
        request
    )
    enforce_login_rate_limit(
        client_ip
    )
    connection = None
    cursor = None
    email = str(
        data.email
    ).lower().strip()
    try:
        connection = get_db_connection()
        cursor = connection.cursor(
            dictionary=True
        )
        cursor.execute(
            """
            SELECT
                id,
                full_name,
                first_name,
                middle_name,
                last_name,
                email,
                contact_number,
                barangay,
                password_hash,
                token_version
            FROM users
            WHERE email = %s
            LIMIT 1
            """,
            (email,),
        )
        user = cursor.fetchone()
        if (
            not user
            or not password_hash.verify(
                data.password,
                user["password_hash"],
            )
        ):
            raise HTTPException(
                status_code=401,
                detail=(
                    "Invalid email or password."
                ),
                headers={
                    "WWW-Authenticate": "Bearer",
                },
            )
        secret = require_jwt_configuration()
        now = datetime.now(
            timezone.utc
        )
        expires_at = (
            now
            + timedelta(minutes=60)
        )
        payload = {
            "sub": str(
                user["id"]
            ),
            "email": user["email"],
            "token_version": int(
                user["token_version"]
            ),
            "iat": now,
            "exp": expires_at,
        }
        token = jwt.encode(
            payload,
            secret,
            algorithm="HS256",
        )
        clear_login_attempts(
            client_ip
        )
        logger.info(
            "Login successful user_id=%s",
            user["id"],
        )
        return {
            "message": "Login successful!",
            "access_token": token,
            "token_type": "bearer",
            "expires_in": 3600,
            "user": {
                "id": user["id"],
                "full_name": (
                    user["full_name"]
                ),
                "first_name": user["first_name"],
                "middle_name": user["middle_name"],
                "last_name": user["last_name"],
                "email": user["email"],
                "contact_number": (
                    user["contact_number"]
                ),
                "barangay": (
                    user["barangay"]
                ),
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Login processing failed."
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Login failed. "
                "Please try again later."
            ),
        ) from exc
    finally:
        close_db_resources(
            cursor,
            connection,
        )
# ============================================================
# AUTHENTICATED USER PROFILE
# ============================================================
@app.get("/api/me")
def get_my_profile(
    user: dict = Depends(get_current_user),
):
    return user
@app.patch("/api/me")
def update_my_profile(
    data: UpdateProfileRequest,
    user: dict = Depends(get_current_user),
):
    """Update only the signed-in user's permitted profile fields."""
    if data.barangay not in BARANGAYS:
        raise HTTPException(
            status_code=400,
            detail="Please select a valid barangay in San Leonardo.",
        )

    full_name = " ".join(
        part for part in (data.first_name, data.middle_name, data.last_name)
        if part
    )
    connection = None
    cursor = None
    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            """
            UPDATE users
            SET first_name = %s,
                middle_name = %s,
                last_name = %s,
                full_name = %s,
                contact_number = %s,
                barangay = %s
            WHERE id = %s
            """,
            (
                data.first_name,
                data.middle_name,
                data.last_name,
                full_name,
                data.contact_number,
                data.barangay,
                user["id"],
            ),
        )
        if cursor.rowcount == 0:
            # A no-op update may affect zero rows in MySQL; verify the account.
            cursor.execute("SELECT id FROM users WHERE id = %s", (user["id"],))
            if cursor.fetchone() is None:
                raise HTTPException(status_code=404, detail="User account not found.")

        cursor.execute(
            """
            SELECT id, full_name, first_name, middle_name, last_name,
                   email, contact_number, barangay
            FROM users
            WHERE id = %s
            LIMIT 1
            """,
            (user["id"],),
        )
        updated_user = cursor.fetchone()
        if updated_user is None:
            raise HTTPException(status_code=404, detail="User account not found.")
        connection.commit()
        return {"message": "Profile updated successfully.", "user": updated_user}
    except HTTPException:
        rollback_db(connection)
        raise
    except Exception as exc:
        rollback_db(connection)
        logger.exception("Profile update failed for user_id=%s", user["id"])
        raise HTTPException(
            status_code=500,
            detail="Unable to update profile. Please try again.",
        ) from exc
    finally:
        close_db_resources(cursor, connection)


# ============================================================
# API ROUTERS
# ============================================================
app.include_router(
    reports_router
)
app.include_router(
    claims_router
)
app.include_router(
    notifications_router
)
app.include_router(
    chat_router
)
app.include_router(
    push_router
)
app.include_router(
    password_reset_router
)