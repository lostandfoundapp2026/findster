# Save as: backend/chat.py

"""Private chat for Lost and Found claim participants.

Features:
- Authenticated private conversations
- REST-based message sending
- WebSocket live updates
- Read receipts and unread counts
- JWT session-version validation
- Automatic rejection of revoked WebSocket sessions
"""

import asyncio
import json
import logging
import os
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from collections import defaultdict
from datetime import datetime
from threading import Lock
from typing import Any

import jwt

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    File,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)

from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError

from pydantic import (
    BaseModel,
    Field,
    field_validator,
)

from auth import get_current_user
from database import get_db_connection
from notifications import queue_push_for_notification


router = APIRouter(
    prefix="/api/chat",
    tags=["Private Chat"],
)

logger = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 2000
MAX_WS_AUTH_SIZE = 8192
MAX_WS_MESSAGE_SIZE = 4096
WS_AUTH_TIMEOUT = 10
WS_RECHECK_SECONDS = 30

# Private files are deliberately outside the publicly served uploads directory.
# On Railway, store them on the mounted persistent volume alongside report
# uploads; locally, preserve the existing backend/private_chat_images path.
# Keep this storage-root logic aligned with main.py and reports.py.
DEFAULT_STORAGE_ROOT = (
    "/app/storage"
    if os.getenv("RAILWAY_ENVIRONMENT")
    else str(Path(__file__).resolve().parent)
)

STORAGE_ROOT = Path(
    os.getenv("FINDSTER_STORAGE_ROOT", DEFAULT_STORAGE_ROOT)
).expanduser().resolve()

PRIVATE_CHAT_DIR = STORAGE_ROOT / "private_chat_images"
PRIVATE_CHAT_DIR.mkdir(parents=True, exist_ok=True)
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_IMAGE_DIMENSION = 8000
IMAGE_FORMATS = {
    "image/jpeg": ("JPEG", ".jpg"),
    "image/png": ("PNG", ".png"),
    "image/webp": ("WEBP", ".webp"),
}
IMAGE_EXTENSIONS = {extension: mime for mime, (_, extension) in IMAGE_FORMATS.items()}


# ============================================================
# REQUEST MODELS
# ============================================================

class SendMessage(BaseModel):
    body: str = Field(
        min_length=1,
        max_length=MAX_MESSAGE_LENGTH,
    )

    @field_validator("body")
    @classmethod
    def clean_body(cls, value: str) -> str:
        cleaned = value.strip()

        if not cleaned:
            raise ValueError(
                "Message cannot be empty."
            )

        return cleaned


# ============================================================
# GENERAL HELPERS
# ============================================================

def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()

    return None


def _close(cursor, connection):
    if cursor is not None:
        try:
            cursor.close()
        except Exception:
            logger.exception(
                "Unable to close chat database cursor."
            )

    if connection is not None:
        try:
            connection.close()
        except Exception:
            logger.exception(
                "Unable to close chat database connection."
            )


def _query(operation):
    """Execute a database operation with safe cleanup."""

    connection = None
    cursor = None

    try:
        connection = get_db_connection()

        cursor = connection.cursor(
            dictionary=True
        )

        return operation(
            cursor,
            connection,
        )

    except Exception:
        if connection is not None:
            try:
                connection.rollback()
            except Exception:
                logger.exception(
                    "Chat database rollback failed."
                )

        raise

    finally:
        _close(
            cursor,
            connection,
        )


# ============================================================
# CLAIM AND CONVERSATION ACCESS
# ============================================================

def _claim_participants(cursor, claim_id: int):
    cursor.execute(
        """
        SELECT
            c.id AS claim_id,
            c.requester_id,
            c.status AS claim_status,
            r.id AS report_id,
            r.user_id AS owner_id,
            r.item_name,
            r.report_type,
            r.status AS report_status
        FROM claim_requests AS c
        JOIN reports AS r
            ON r.id = c.report_id
        WHERE c.id = %s
        """,
        (claim_id,),
    )

    return cursor.fetchone()


def _conversation_context(
    cursor,
    conversation_id: int,
):
    cursor.execute(
        """
        SELECT
            cc.id AS conversation_id,
            cc.claim_id,
            cc.initiated_by,
            cc.created_at AS conversation_created_at,
            cc.updated_at AS conversation_updated_at,
            c.requester_id,
            c.status AS claim_status,
            r.id AS report_id,
            r.user_id AS owner_id,
            r.item_name,
            r.report_type,
            r.status AS report_status
        FROM chat_conversations AS cc
        JOIN claim_requests AS c
            ON c.id = cc.claim_id
        JOIN reports AS r
            ON r.id = c.report_id
        WHERE cc.id = %s
        """,
        (conversation_id,),
    )

    return cursor.fetchone()


def _require_participant(context, user_id: int):
    """Prevent access to another user's conversation."""

    if context is None:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found.",
        )

    if user_id not in (
        context["owner_id"],
        context["requester_id"],
    ):
        # Avoid exposing the existence of private conversations.
        raise HTTPException(
            status_code=404,
            detail="Conversation not found.",
        )


def _may_send(context):
    """Determine whether a conversation remains writable."""

    return (
        context["claim_status"] in (
            "pending",
            "approved",
        )
        and context["report_status"] in (
            "active",
            "claimed",
        )
    )


def _conversation_payload(row):
    return {
        "id": row["conversation_id"],
        "claim_id": row["claim_id"],
        "report_id": row["report_id"],
        "item_name": row["item_name"],
        "report_type": row["report_type"],
        "claim_status": row["claim_status"],
        "report_status": row["report_status"],
        "report_owner_id": row["owner_id"],
        "requester_id": row["requester_id"],
        "can_send": _may_send(row),
        "created_at": _iso(
            row.get("conversation_created_at")
        ),
        "updated_at": _iso(
            row.get("conversation_updated_at")
        ),
    }


def _message_payload(row):
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "sender_id": row["sender_id"],
        "body": row["body"],
        "message_type": row.get("message_type") or "text",
        "image_url": (
            f'/api/chat/{row["conversation_id"]}/images/{row["id"]}'
            if row.get("message_type") == "image" and row.get("image_path")
            else None
        ),
        "created_at": _iso(
            row.get("created_at")
        ),
        "read_at": _iso(
            row.get("read_at")
        ),
    }


# ============================================================
# PRIVATE CHAT IMAGE HELPERS
# ============================================================

def _lock_conversation_for_send(cursor, conversation_id: int, user_id: int):
    """Use the same report-first lock ordering as claim handover actions."""
    cursor.execute(
        """SELECT c.report_id FROM chat_conversations AS cc
           JOIN claim_requests AS c ON c.id = cc.claim_id
           WHERE cc.id = %s""",
        (conversation_id,),
    )
    reference = cursor.fetchone()
    if reference is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    cursor.execute("SELECT id FROM reports WHERE id = %s FOR UPDATE", (reference["report_id"],))
    if cursor.fetchone() is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    context = _conversation_context(cursor, conversation_id)
    _require_participant(context, user_id)
    return context


def _sanitize_chat_image(contents: bytes, mime: str) -> tuple[bytes, str]:
    """Decode pixels, limit image dimensions, and re-encode without source metadata."""
    if mime not in IMAGE_FORMATS:
        raise HTTPException(400, "Only JPG, PNG, and WEBP images are supported.")
    if not contents or len(contents) > MAX_IMAGE_BYTES:
        raise HTTPException(400, "Image must be nonempty and no larger than 5 MB.")
    expected_format, extension = IMAGE_FORMATS[mime]
    try:
        with Image.open(BytesIO(contents)) as source:
            if source.format != expected_format:
                raise HTTPException(400, "Image contents do not match its media type.")
            width, height = source.size
            if (width < 1 or height < 1 or width > MAX_IMAGE_DIMENSION
                    or height > MAX_IMAGE_DIMENSION
                    or width * height > MAX_IMAGE_PIXELS):
                raise HTTPException(400, "Image dimensions exceed the allowed limit.")
            source.load()
            oriented = ImageOps.exif_transpose(source)
            has_alpha = "A" in oriented.getbands() or "transparency" in oriented.info
            mode = "RGB" if expected_format == "JPEG" else ("RGBA" if has_alpha else "RGB")
            with Image.new(mode, oriented.size) as clean:
                clean.paste(oriented.convert(mode))
                output = BytesIO()
                if expected_format == "JPEG":
                    clean.save(output, format="JPEG", quality=85, optimize=True)
                elif expected_format == "PNG":
                    clean.save(output, format="PNG", optimize=True)
                else:
                    clean.save(output, format="WEBP", quality=85, method=4)
                encoded = output.getvalue()
        if not encoded or len(encoded) > MAX_IMAGE_BYTES:
            raise HTTPException(400, "Processed image exceeds the 5 MB limit.")
        return encoded, extension
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, EOFError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(400, "Invalid or corrupted image.") from exc


def _private_image_path(name: str) -> Path:
    """Accept only our UUID filenames, never paths supplied by clients."""
    if not isinstance(name, str) or len(name) < 36:
        raise HTTPException(404, "Image not found.")
    stem, dot, extension = name.rpartition(".")
    if not dot or f".{extension}" not in IMAGE_EXTENSIONS:
        raise HTTPException(404, "Image not found.")
    if len(stem) != 32 or any(c not in "0123456789abcdef" for c in stem):
        raise HTTPException(404, "Image not found.")
    return PRIVATE_CHAT_DIR / name


# ============================================================
# JWT AND WEBSOCKET SESSION SECURITY
# ============================================================

def _verify_ws_token(
    token: str,
) -> tuple[int, int] | None:
    """Verify JWT and extract user ID and session version."""

    secret = os.getenv("JWT_SECRET", "").strip()

    algorithm = os.getenv(
        "JWT_ALGORITHM",
        "HS256",
    ).strip().upper()

    if (
        not secret
        or not isinstance(token, str)
        or not token
        or algorithm != "HS256"
    ):
        return None

    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            options={
                "require": [
                    "sub",
                    "exp",
                ],
            },
        )

        # Reject non-string subjects and malformed IDs.
        subject = payload["sub"]

        if (
            not isinstance(subject, str)
            or not subject.isdecimal()
        ):
            return None

        user_id = int(subject)

        # Legacy tokens without token_version are treated
        # as version zero, consistent with the existing JWT setup.
        token_version = payload.get(
            "token_version",
            0,
        )

        if user_id <= 0:
            return None

        if (
            type(token_version) is not int
            or token_version < 0
        ):
            return None

        return (
            user_id,
            token_version,
        )

    except (
        jwt.InvalidTokenError,
        KeyError,
        TypeError,
        ValueError,
    ):
        return None


def _database_session_valid(
    user_id: int,
    token_version: int,
) -> bool:
    """Check whether a user's session version is still current."""

    def action(cursor, _connection):
        cursor.execute(
            """
            SELECT token_version
            FROM users
            WHERE id = %s
            """,
            (user_id,),
        )

        row = cursor.fetchone()

        if row is None:
            return False

        return (
            int(row["token_version"])
            == token_version
        )

    return _query(action)


def _session_valid(
    token: str,
    user_id: int,
    token_version: int,
) -> bool:
    """Validate both the JWT and its database session version."""

    decoded = _verify_ws_token(token)

    if decoded != (
        user_id,
        token_version,
    ):
        return False

    return _database_session_valid(
        user_id,
        token_version,
    )


# ============================================================
# WEBSOCKET REGISTRY
# ============================================================

# Store the token and version with each WebSocket.
# This registry supports one FastAPI worker only.
#
# JWT and MySQL remain authoritative for access control.

_sockets: dict[
    int,
    dict[WebSocket, tuple[str, int]],
] = defaultdict(dict)

_registry_lock = Lock()


def _register(
    user_id: int,
    websocket: WebSocket,
    token: str,
    token_version: int,
):
    with _registry_lock:
        _sockets[user_id][websocket] = (
            token,
            token_version,
        )


def _unregister(
    user_id: int,
    websocket: WebSocket,
):
    with _registry_lock:
        connections = _sockets.get(
            user_id
        )

        if connections is None:
            return

        connections.pop(
            websocket,
            None,
        )

        if not connections:
            _sockets.pop(
                user_id,
                None,
            )


async def _close_invalid_socket(
    user_id: int,
    websocket: WebSocket,
):
    """Remove revoked sockets from the delivery registry."""

    _unregister(
        user_id,
        websocket,
    )

    try:
        await websocket.close(
            code=1008,
            reason="Session expired",
        )
    except Exception:
        pass


async def _publish(
    user_ids: set[int],
    payload: dict,
):
    """Publish events only to currently authorized sessions.

    Snapshot registry entries before awaiting database checks.
    Never hold the registry lock during network or DB operations.
    """

    with _registry_lock:
        connections = [
            (
                user_id,
                websocket,
                token,
                token_version,
            )
            for user_id in user_ids
            for websocket, (
                token,
                token_version,
            ) in _sockets.get(
                user_id,
                {},
            ).items()
        ]

    for (
        user_id,
        websocket,
        token,
        token_version,
    ) in connections:
        try:
            # Confirm the socket still belongs to this session.
            with _registry_lock:
                registered_session = (
                    _sockets.get(user_id, {}).get(
                        websocket
                    )
                )

            if registered_session != (
                token,
                token_version,
            ):
                continue

            # Revalidate JWT expiry and token_version before
            # delivering the event, not only periodically.
            valid = await asyncio.to_thread(
                _session_valid,
                token,
                user_id,
                token_version,
            )

            if not valid:
                await _close_invalid_socket(
                    user_id,
                    websocket,
                )
                continue

            await websocket.send_json(
                payload
            )

        except Exception as exc:
            logger.warning(
                "WebSocket delivery failed for user_id=%s error_type=%s",
                user_id,
                type(exc).__name__,
            )

            _unregister(
                user_id,
                websocket,
            )


# ============================================================
# START CONVERSATION
# ============================================================

@router.post(
    "/claims/{claim_id}/start",
    status_code=201,
)
async def start_conversation(
    claim_id: int,
    user: dict = Depends(get_current_user),
):
    """Create or retrieve a shared conversation for a valid claim."""

    def action(cursor, connection):
        claim = _claim_participants(
            cursor,
            claim_id,
        )

        if claim is None:
            raise HTTPException(
                status_code=404,
                detail="Claim not found.",
            )

        if user["id"] not in (
            claim["owner_id"],
            claim["requester_id"],
        ):
            raise HTTPException(
                status_code=404,
                detail="Claim not found.",
            )

        if not _may_send(claim):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Chat cannot be started for this claim."
                ),
            )

        cursor.execute(
            """
            INSERT INTO chat_conversations (
                claim_id,
                initiated_by
            )
            VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE
                id = LAST_INSERT_ID(id)
            """,
            (
                claim_id,
                user["id"],
            ),
        )

        conversation_id = cursor.lastrowid

        context = _conversation_context(
            cursor,
            conversation_id,
        )

        connection.commit()

        return _conversation_payload(
            context
        )

    result = await asyncio.to_thread(
        _query,
        action,
    )

    other_user_id = (
        result["requester_id"]
        if user["id"] == result["report_owner_id"]
        else result["report_owner_id"]
    )

    await _publish(
        {other_user_id},
        {
            "type": "conversation_started",
            "conversation": result,
        },
    )

    return {
        "conversation": result,
    }


# ============================================================
# MY CONVERSATIONS
# ============================================================

@router.get("/mine")
async def my_conversations(
    user: dict = Depends(get_current_user),
):
    def action(cursor, _connection):
        cursor.execute(
            """
            SELECT
                cc.id AS conversation_id,
                cc.claim_id,
                cc.initiated_by,
                cc.created_at AS conversation_created_at,
                cc.updated_at AS conversation_updated_at,
                c.requester_id,
                c.status AS claim_status,
                r.id AS report_id,
                r.user_id AS owner_id,
                r.item_name,
                r.report_type,
                r.status AS report_status,
                (
                    SELECT COUNT(*)
                    FROM chat_messages AS m
                    WHERE m.conversation_id = cc.id
                      AND m.sender_id <> %s
                      AND m.read_at IS NULL
                ) AS unread_count
            FROM chat_conversations AS cc
            JOIN claim_requests AS c
                ON c.id = cc.claim_id
            JOIN reports AS r
                ON r.id = c.report_id
            WHERE
                c.requester_id = %s
                OR r.user_id = %s
            ORDER BY
                cc.updated_at DESC,
                cc.id DESC
            """,
            (
                user["id"],
                user["id"],
                user["id"],
            ),
        )

        result = []

        for row in cursor.fetchall():
            item = _conversation_payload(
                row
            )

            item["unread_count"] = row[
                "unread_count"
            ]

            result.append(item)

        return result

    return {
        "conversations": await asyncio.to_thread(
            _query,
            action,
        ),
    }


# ============================================================
# GET CONVERSATION FOR A CLAIM
# ============================================================

@router.get("/claims/{claim_id}")
async def conversation_for_claim(
    claim_id: int,
    user: dict = Depends(get_current_user),
):
    def action(cursor, _connection):
        claim = _claim_participants(
            cursor,
            claim_id,
        )

        if claim is None:
            raise HTTPException(
                status_code=404,
                detail="Conversation not found.",
            )

        _require_participant(
            {
                "owner_id": claim["owner_id"],
                "requester_id": claim["requester_id"],
            },
            user["id"],
        )

        cursor.execute(
            """
            SELECT id
            FROM chat_conversations
            WHERE claim_id = %s
            """,
            (claim_id,),
        )

        row = cursor.fetchone()

        if not row:
            return None

        context = _conversation_context(
            cursor,
            row["id"],
        )

        return _conversation_payload(
            context
        )

    return {
        "conversation": await asyncio.to_thread(
            _query,
            action,
        ),
    }


# ============================================================
# LIST CHAT MESSAGES
# ============================================================

@router.get("/{conversation_id}/messages")
async def list_messages(
    conversation_id: int,
    before_id: int | None = None,
    limit: int = 50,
    user: dict = Depends(get_current_user),
):
    if not 1 <= limit <= 100:
        raise HTTPException(
            status_code=422,
            detail="Limit must be between 1 and 100.",
        )

    if (
        before_id is not None
        and before_id < 1
    ):
        raise HTTPException(
            status_code=422,
            detail="before_id must be positive.",
        )

    def action(cursor, _connection):
        context = _conversation_context(
            cursor,
            conversation_id,
        )

        _require_participant(
            context,
            user["id"],
        )

        if before_id is None:
            cursor.execute(
                """
                SELECT
                    id,
                    conversation_id,
                    sender_id,
                    body,
                    message_type,
                    image_path,
                    created_at,
                    read_at
                FROM chat_messages
                WHERE conversation_id = %s
                ORDER BY id DESC
                LIMIT %s
                """,
                (
                    conversation_id,
                    limit,
                ),
            )

        else:
            cursor.execute(
                """
                SELECT
                    id,
                    conversation_id,
                    sender_id,
                    body,
                    message_type,
                    image_path,
                    created_at,
                    read_at
                FROM chat_messages
                WHERE conversation_id = %s
                  AND id < %s
                ORDER BY id DESC
                LIMIT %s
                """,
                (
                    conversation_id,
                    before_id,
                    limit,
                ),
            )

        rows = cursor.fetchall()

        messages = [
            _message_payload(row)
            for row in rows
        ]

        return list(
            reversed(messages)
        )

    return {
        "messages": await asyncio.to_thread(
            _query,
            action,
        ),
    }


# ============================================================
# SEND MESSAGE
# ============================================================

@router.post(
    "/{conversation_id}/messages",
    status_code=201,
)
async def send_message(
    conversation_id: int,
    data: SendMessage,
    user: dict = Depends(get_current_user),
):
    def action(cursor, connection):
        context = _lock_conversation_for_send(cursor, conversation_id, user["id"])

        if not _may_send(context):
            raise HTTPException(
                status_code=409,
                detail=(
                    "This conversation is now read-only."
                ),
            )

        cursor.execute(
            """
            INSERT INTO chat_messages (
                conversation_id,
                sender_id,
                body,
                message_type
            )
            VALUES (%s, %s, %s, 'text')
            """,
            (
                conversation_id,
                user["id"],
                data.body,
            ),
        )

        message_id = cursor.lastrowid

        cursor.execute(
            """
            UPDATE chat_conversations
            SET updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (conversation_id,),
        )

        cursor.execute(
            """
            SELECT
                id,
                conversation_id,
                sender_id,
                body,
                message_type,
                image_path,
                created_at,
                read_at
            FROM chat_messages
            WHERE id = %s
            """,
            (message_id,),
        )

        message = _message_payload(
            cursor.fetchone()
        )

        recipient_id = (
            context["requester_id"]
            if user["id"] == context["owner_id"]
            else context["owner_id"]
        )

        # Do not place private chat text in notifications.
        item_name = str(
            context["item_name"] or "an item"
        )

        notification_message = (
            f'You received a private message '
            f'regarding "{item_name}".'
        )

        cursor.execute(
            """
            INSERT INTO notifications (
                user_id,
                title,
                message,
                notification_type,
                related_report_id,
                related_claim_id
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                recipient_id,
                "New Chat Message",
                notification_message[:500],
                "new_chat_message",
                context["report_id"],
                context["claim_id"],
            ),
        )

        notification_id = int(
            cursor.lastrowid
        )

        # Commit message and notification together.
        connection.commit()

        return (
            message,
            context,
            notification_id,
        )

    (
        message,
        context,
        notification_id,
    ) = await asyncio.to_thread(
        _query,
        action,
    )

    try:
        queue_push_for_notification(
            notification_id
        )

    except Exception:
        logger.exception(
            "Unable to queue push notification_id=%s",
            notification_id,
        )

    await _publish(
        {
            context["owner_id"],
            context["requester_id"],
        },
        {
            "type": "new_message",
            "message": message,
            "conversation_id": conversation_id,
        },
    )

    return {
        "message": message,
    }


# ============================================================
# PRIVATE CHAT IMAGE UPLOAD AND DOWNLOAD
# ============================================================

@router.post("/{conversation_id}/images", status_code=201)
async def send_image(
    conversation_id: int,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Send an image-only message, authorized just like a text message."""
    try:
        if file.content_type not in IMAGE_FORMATS:
            raise HTTPException(400, "Only JPG, PNG, and WEBP images are supported.")
        raw = await file.read(MAX_IMAGE_BYTES + 1)
        encoded, extension = await asyncio.to_thread(
            _sanitize_chat_image, raw, file.content_type
        )
    finally:
        await file.close()

    filename = f"{uuid4().hex}{extension}"
    file_path = _private_image_path(filename)

    def action(cursor, connection):
        context = _lock_conversation_for_send(cursor, conversation_id, user["id"])
        if not _may_send(context):
            raise HTTPException(409, "This conversation is now read-only.")

        # Save before committing; on any DB failure, remove the new image.
        try:
            with file_path.open("xb") as handle:
                handle.write(encoded)

            cursor.execute(
                """INSERT INTO chat_messages
                   (conversation_id, sender_id, body, message_type, image_path)
                   VALUES (%s, %s, NULL, 'image', %s)""",
                (conversation_id, user["id"], filename),
            )
            message_id = cursor.lastrowid
            cursor.execute(
                "UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                (conversation_id,),
            )
            cursor.execute(
                """SELECT id, conversation_id, sender_id, body, message_type,
                          image_path, created_at, read_at
                   FROM chat_messages WHERE id = %s""",
                (message_id,),
            )
            message = _message_payload(cursor.fetchone())
            recipient_id = (
                context["requester_id"] if user["id"] == context["owner_id"]
                else context["owner_id"]
            )
            cursor.execute(
                """INSERT INTO notifications
                   (user_id, title, message, notification_type,
                    related_report_id, related_claim_id)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (recipient_id, "New Chat Image",
                 "You received an image in a private conversation.",
                 "new_chat_message", context["report_id"], context["claim_id"]),
            )
            notification_id = int(cursor.lastrowid)
            connection.commit()
            return message, context, notification_id
        except Exception:
            try:
                file_path.unlink(missing_ok=True)
            except OSError:
                logger.exception("Failed to remove uncommitted chat image")
            raise

    message, context, notification_id = await asyncio.to_thread(_query, action)
    try:
        queue_push_for_notification(notification_id)
    except Exception:
        logger.exception("Unable to queue image push notification_id=%s", notification_id)
    await _publish(
        {context["owner_id"], context["requester_id"]},
        {"type": "new_message", "message": message, "conversation_id": conversation_id},
    )
    return {"message": message}


@router.get("/{conversation_id}/images/{message_id}")
async def get_chat_image(
    conversation_id: int,
    message_id: int,
    user: dict = Depends(get_current_user),
):
    """Return a private image only to a conversation participant with valid JWT."""
    def action(cursor, _connection):
        context = _conversation_context(cursor, conversation_id)
        _require_participant(context, user["id"])
        cursor.execute(
            """SELECT image_path FROM chat_messages
               WHERE id = %s AND conversation_id = %s AND message_type = 'image'""",
            (message_id, conversation_id),
        )
        row = cursor.fetchone()
        if not row or not row["image_path"]:
            raise HTTPException(404, "Image not found.")
        return row["image_path"]

    filename = await asyncio.to_thread(_query, action)
    image_path = _private_image_path(filename)
    if not image_path.is_file():
        raise HTTPException(404, "Image not found.")
    return FileResponse(
        image_path,
        media_type=IMAGE_EXTENSIONS[image_path.suffix],
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "inline",
        },
    )


# ============================================================
# MARK MESSAGES AS READ
# ============================================================

@router.post("/{conversation_id}/read")
async def mark_read(
    conversation_id: int,
    user: dict = Depends(get_current_user),
):
    def action(cursor, connection):
        context = _conversation_context(
            cursor,
            conversation_id,
        )

        _require_participant(
            context,
            user["id"],
        )

        cursor.execute(
            """
            UPDATE chat_messages
            SET read_at = UTC_TIMESTAMP(6)
            WHERE conversation_id = %s
              AND sender_id <> %s
              AND read_at IS NULL
            """,
            (
                conversation_id,
                user["id"],
            ),
        )

        marked = cursor.rowcount

        connection.commit()

        return (
            marked,
            context,
        )

    count, context = await asyncio.to_thread(
        _query,
        action,
    )

    if count:
        await _publish(
            {
                context["owner_id"],
                context["requester_id"],
            },
            {
                "type": "messages_read",
                "conversation_id": conversation_id,
                "read_by": user["id"],
            },
        )

    return {
        "marked_read": count,
    }


# ============================================================
# UNREAD MESSAGE COUNT
# ============================================================

@router.get("/unread/count")
async def unread_count(
    user: dict = Depends(get_current_user),
):
    def action(cursor, _connection):
        cursor.execute(
            """
            SELECT COUNT(*) AS total
            FROM chat_messages AS m
            JOIN chat_conversations AS cc
                ON cc.id = m.conversation_id
            JOIN claim_requests AS c
                ON c.id = cc.claim_id
            JOIN reports AS r
                ON r.id = c.report_id
            WHERE (
                c.requester_id = %s
                OR r.user_id = %s
            )
              AND m.sender_id <> %s
              AND m.read_at IS NULL
            """,
            (
                user["id"],
                user["id"],
                user["id"],
            ),
        )

        row = cursor.fetchone()

        return row["total"]

    return {
        "unread_count": await asyncio.to_thread(
            _query,
            action,
        ),
    }


# ============================================================
# WEBSOCKET LIVE CHAT
# ============================================================

@router.websocket("/ws")
async def websocket_chat(
    websocket: WebSocket,
):
    """Authenticated real-time chat event delivery.

    First client message:
        {"type": "auth", "token": "JWT"}

    Server response:
        {"type": "authenticated", "user_id": 123}

    Optional heartbeat:
        {"type": "ping"}

    Heartbeat response:
        {"type": "pong"}

    All message writes continue through the REST API.
    """

    await websocket.accept()

    user_id = None
    token_version = None
    token = None

    try:
        # ----------------------------------------------------
        # INITIAL AUTHENTICATION
        # ----------------------------------------------------

        try:
            raw_auth = await asyncio.wait_for(
                websocket.receive_text(),
                timeout=WS_AUTH_TIMEOUT,
            )

        except asyncio.TimeoutError:
            await websocket.close(
                code=1008,
                reason="Authentication required",
            )
            return

        if len(raw_auth) > MAX_WS_AUTH_SIZE:
            await websocket.close(
                code=1009,
                reason="Authentication message too large",
            )
            return

        try:
            auth_data = json.loads(
                raw_auth
            )

        except (ValueError, TypeError):
            await websocket.close(
                code=1008,
                reason="Invalid authentication message",
            )
            return

        if (
            not isinstance(auth_data, dict)
            or auth_data.get("type") != "auth"
        ):
            await websocket.close(
                code=1008,
                reason="Authentication required",
            )
            return

        token = auth_data.get(
            "token"
        )

        session = _verify_ws_token(
            token
        )

        if session is None:
            await websocket.close(
                code=1008,
                reason="Invalid or expired token",
            )
            return

        user_id, token_version = session

        # Check against users.token_version immediately.
        valid = await asyncio.to_thread(
            _database_session_valid,
            user_id,
            token_version,
        )

        if not valid:
            await websocket.close(
                code=1008,
                reason="Session expired",
            )
            return

        # Register only after all checks pass.
        _register(
            user_id,
            websocket,
            token,
            token_version,
        )

        await websocket.send_json({
            "type": "authenticated",
            "user_id": user_id,
        })

        logger.info(
            "WebSocket authenticated user_id=%s",
            user_id,
        )

        # ----------------------------------------------------
        # AUTHENTICATED EVENT LOOP
        # ----------------------------------------------------

        while True:
            try:
                raw_data = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=WS_RECHECK_SECONDS,
                )

            except asyncio.TimeoutError:
                raw_data = None

            # Revalidate on every incoming message and timeout.
            valid = await asyncio.to_thread(
                _session_valid,
                token,
                user_id,
                token_version,
            )

            if not valid:
                _unregister(
                    user_id,
                    websocket,
                )

                await websocket.close(
                    code=1008,
                    reason="Session revoked or expired",
                )
                return

            if raw_data is None:
                continue

            if len(raw_data) > MAX_WS_MESSAGE_SIZE:
                await websocket.close(
                    code=1009,
                    reason="Message too large",
                )
                return

            try:
                data = json.loads(
                    raw_data
                )
            except (ValueError, TypeError):
                continue

            if (
                isinstance(data, dict)
                and data.get("type") == "ping"
            ):
                await websocket.send_json({
                    "type": "pong",
                })

            # Client messages are not broadcast.
            # Sending chats still requires POST /messages.

    except WebSocketDisconnect:
        pass

    except Exception as exc:
        logger.warning(
            "WebSocket disconnected user_id=%s error_type=%s",
            user_id,
            type(exc).__name__,
        )

        try:
            await websocket.close(
                code=1011
            )
        except Exception:
            pass

    finally:
        if user_id is not None:
            _unregister(
                user_id,
                websocket,
            )

        logger.info(
            "WebSocket session closed user_id=%s",
            user_id,
        )