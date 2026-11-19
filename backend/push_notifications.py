
# Save as: backend/push_notifications.py

"""Firebase Cloud Messaging registration and delivery.

Device registrations are linked to the user's JWT session version.
Old registrations stop qualifying for push delivery after a
successful password reset increments users.token_version.
"""

import asyncio
import logging
import os
from pathlib import Path
from threading import Lock

import jwt
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from auth import get_current_user
from database import get_db_connection

load_dotenv(Path(__file__).resolve().parent / ".env")

router = APIRouter(
    prefix="/api/push",
    tags=["Push Notifications"],
)

logger = logging.getLogger(__name__)
_firebase_init_lock = Lock()


class DeviceTokenPayload(BaseModel):
    fcm_token: str = Field(min_length=20, max_length=512)
    platform: str = "android"

    @field_validator("fcm_token")
    @classmethod
    def check_token(cls, value: str) -> str:
        value = value.strip()

        if not value or any(ch.isspace() for ch in value):
            raise ValueError("Invalid FCM token.")

        return value

    @field_validator("platform")
    @classmethod
    def check_platform(cls, value: str) -> str:
        value = value.strip().lower()

        if value != "android":
            raise ValueError("Only Android is supported.")

        return value


def _db_action(operation):
    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        return operation(cursor, connection)

    except Exception:
        if connection is not None:
            try:
                connection.rollback()
            except Exception:
                pass
        raise

    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                logger.warning("Could not close push database cursor.")

        if connection is not None:
            try:
                connection.close()
            except Exception:
                logger.warning("Could not close push database connection.")


def _request_token_version(request: Request) -> int:
    """Read the version from the JWT already checked by auth.py."""

    authorization = request.headers.get("authorization", "")
    scheme, separator, token = authorization.partition(" ")

    if (
        not separator
        or scheme.lower() != "bearer"
        or not token.strip()
    ):
        raise HTTPException(
            status_code=401,
            detail="Authentication required.",
        )

    secret = os.getenv("JWT_SECRET")
    algorithm = os.getenv("JWT_ALGORITHM", "HS256").strip().upper()

    if not secret or algorithm != "HS256":
        raise HTTPException(
            status_code=500,
            detail="Authentication is not configured.",
        )

    try:
        payload = jwt.decode(
            token.strip(),
            secret,
            algorithms=["HS256"],
            options={"require": ["exp", "sub"]},
        )

        # Compatibility with older, version-zero JWTs.
        version = payload.get("token_version", 0)

        if type(version) is not int or version < 0:
            raise ValueError("Invalid token version.")

        return version

    except (jwt.InvalidTokenError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


@router.post("/register")
async def register_device(
    payload: DeviceTokenPayload,
    request: Request,
    user: dict = Depends(get_current_user),
):
    requested_version = _request_token_version(request)

    def action(cursor, connection):
        # Lock the user row. Password resets update this same row,
        # preventing registration using a version that has just
        # become invalid during a concurrent password reset.
        cursor.execute(
            """
            SELECT token_version
            FROM users
            WHERE id = %s
            FOR UPDATE
            """,
            (user["id"],),
        )

        account = cursor.fetchone()

        if (
            account is None
            or int(account["token_version"]) != requested_version
        ):
            raise HTTPException(
                status_code=401,
                detail="Your session has expired. Please sign in again.",
                headers={"WWW-Authenticate": "Bearer"},
            )

        cursor.execute(
            """
            INSERT INTO device_push_tokens
                (user_id, fcm_token, platform, token_version)
            VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id),
                platform = VALUES(platform),
                token_version = VALUES(token_version),
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                user["id"],
                payload.fcm_token,
                payload.platform,
                requested_version,
            ),
        )

        connection.commit()

        return {
            "success": True,
            "message": "Push device registered.",
        }

    try:
        result = await asyncio.to_thread(_db_action, action)

        logger.info(
            "[Push] Device registered for user_id=%s",
            user["id"],
        )

        return result

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "[Push] Device registration failed for user_id=%s",
            user["id"],
        )

        raise HTTPException(
            status_code=503,
            detail="Unable to register push device.",
        ) from exc


@router.post("/unregister")
async def unregister_device(
    payload: DeviceTokenPayload,
    user: dict = Depends(get_current_user),
):
    def action(cursor, connection):
        # A previous account cannot delete another account's
        # registration, even if both used the same device.
        cursor.execute(
            """
            DELETE FROM device_push_tokens
            WHERE user_id = %s
              AND fcm_token = %s
            """,
            (user["id"], payload.fcm_token),
        )

        connection.commit()

        return {
            "success": True,
            "message": "Push device unregistered.",
        }

    try:
        return await asyncio.to_thread(_db_action, action)

    except Exception as exc:
        logger.exception(
            "[Push] Device unregistration failed for user_id=%s",
            user["id"],
        )

        raise HTTPException(
            status_code=503,
            detail="Unable to unregister push device.",
        ) from exc


def _get_firebase_app():
    """Initialize Firebase once using the configured service account."""

    import firebase_admin
    from firebase_admin import credentials

    with _firebase_init_lock:
        try:
            return firebase_admin.get_app()
        except ValueError:
            pass

        credentials_path = os.getenv(
            "GOOGLE_APPLICATION_CREDENTIALS", ""
        ).strip()

        if not credentials_path:
            raise RuntimeError(
                "Firebase service-account configuration is missing."
            )

        file_path = Path(credentials_path).expanduser()

        if not file_path.is_file():
            raise RuntimeError(
                "Firebase service-account file was not found."
            )

        app = firebase_admin.initialize_app(
            credentials.Certificate(str(file_path))
        )

        logger.info(
            "[Push] Firebase initialized for project_id=%s",
            app.project_id,
        )

        return app


def _user_tokens(user_id: int) -> list[str]:
    """Return only registrations matching the current session version."""

    def action(cursor, _connection):
        cursor.execute(
            """
            SELECT d.fcm_token
            FROM device_push_tokens AS d
            INNER JOIN users AS u
                ON u.id = d.user_id
            WHERE d.user_id = %s
              AND d.platform = 'android'
              AND d.token_version = u.token_version
            """,
            (user_id,),
        )

        return [
            row["fcm_token"]
            for row in cursor.fetchall()
        ]

    return _db_action(action)


def _delete_invalid_token(user_id: int, token: str) -> None:
    def action(cursor, connection):
        cursor.execute(
            """
            DELETE FROM device_push_tokens
            WHERE user_id = %s
              AND fcm_token = %s
            """,
            (user_id, token),
        )

        connection.commit()

    _db_action(action)


def send_push_to_user(
    user_id: int,
    title: str,
    message: str,
    *,
    notification_type: str,
    related_report_id: int | None = None,
    related_claim_id: int | None = None,
) -> dict[str, int]:
    """Send pushes to valid device registrations.

    FCM acceptance does not guarantee Android display.
    """

    from firebase_admin import messaging

    result = {
        "sent": 0,
        "failed": 0,
    }

    try:
        tokens = _user_tokens(user_id)

    except Exception:
        logger.exception(
            "[Push] Unable to retrieve device tokens for user_id=%s",
            user_id,
        )
        return result

    logger.info(
        "[Push] Dispatch user_id=%s registered_devices=%s event=%s",
        user_id,
        len(tokens),
        notification_type,
    )

    if not tokens:
        return result

    try:
        app = _get_firebase_app()

    except Exception:
        logger.exception("[Push] Firebase initialization failed.")

        return {
            "sent": 0,
            "failed": len(tokens),
        }

    data: dict[str, str] = {
        "notification_type": notification_type,
    }

    if related_report_id is not None:
        data["related_report_id"] = str(related_report_id)

    if related_claim_id is not None:
        data["related_claim_id"] = str(related_claim_id)

    for token in tokens:
        try:
            messaging.send(
                messaging.Message(
                    token=token,
                    notification=messaging.Notification(
                        title=title,
                        body=message,
                    ),
                    data=data,
                    android=messaging.AndroidConfig(
                        priority="high",
                    ),
                ),
                app=app,
            )

            result["sent"] += 1

        except messaging.UnregisteredError:
            result["failed"] += 1

            logger.warning(
                "[Push] Unregistered device for user_id=%s; removing.",
                user_id,
            )

            try:
                _delete_invalid_token(user_id, token)

            except Exception:
                logger.exception(
                    "[Push] Unable to remove invalid device token."
                )

        except Exception as exc:
            result["failed"] += 1

            logger.error(
                "[Push] Firebase send failed user_id=%s error_type=%s",
                user_id,
                type(exc).__name__,
            )

    logger.info(
        "[Push] Finished user_id=%s accepted_by_fcm=%s failed=%s",
        user_id,
        result["sent"],
        result["failed"],
    )

    return result


@router.post("/test")
async def test_push_to_self(
    user: dict = Depends(get_current_user),
):
    """Development-only notification delivery test."""

    if (
        os.getenv("PUSH_TEST_ENABLED", "false")
        .strip()
        .lower() != "true"
    ):
        raise HTTPException(
            status_code=404,
            detail="Not found.",
        )

    result = await asyncio.to_thread(
        send_push_to_user,
        user["id"],
        "Lost and Found Test",
        "This is a test push notification from your backend.",
        notification_type="test_push",
    )

    return {
        "registered_device_count":
            result["sent"] + result["failed"],
        "accepted_by_fcm": result["sent"],
        "failed": result["failed"],
        "note": (
            "Accepted by FCM does not guarantee "
            "that Android displayed an alert."
        ),
    }
