
# Save as: backend/notifications.py

"""In-app notifications and best-effort FCM push dispatch.

Call queue_push_for_notification(notification_id) only AFTER
the transaction creating the notification has committed.

Push dispatch uses a bounded, in-process worker pool.
For production durability, use a persistent task queue.
"""

import logging
from concurrent.futures import Future, ThreadPoolExecutor
from threading import BoundedSemaphore, Lock

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from database import get_db_connection
from push_notifications import send_push_to_user


router = APIRouter(
    prefix="/api/notifications",
    tags=["Notifications"],
)

logger = logging.getLogger(__name__)

MAX_OUTSTANDING_PUSH_JOBS = 100

_push_executor = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="notification-push",
)

_push_slots = BoundedSemaphore(
    MAX_OUTSTANDING_PUSH_JOBS
)

_push_lock = Lock()

_pending_push_ids: set[int] = set()


# ============================================================
# DATABASE HELPERS
# ============================================================

def close_db(cursor, connection):
    """Close database resources safely."""

    if cursor is not None:
        try:
            cursor.close()
        except Exception:
            logger.exception(
                "Notification cursor cleanup failed."
            )

    if connection is not None:
        try:
            connection.close()
        except Exception:
            logger.exception(
                "Notification database connection cleanup failed."
            )


def rollback_db(connection):
    """Safely roll back a transaction."""

    if connection is not None:
        try:
            connection.rollback()
        except Exception:
            logger.exception(
                "Notification transaction rollback failed."
            )


# ============================================================
# RESPONSE FORMAT
# ============================================================

def notification_response(row):
    """Keep the existing response format for the frontend."""

    return {
        "id": row["id"],
        "title": row["title"],
        "message": row["message"],
        "notification_type": row["notification_type"],
        "related_report_id": row["related_report_id"],
        "related_claim_id": row["related_claim_id"],
        "is_read": bool(row["is_read"]),
        "created_at": (
            row["created_at"].isoformat()
            if row.get("created_at")
            else None
        ),
    }


# ============================================================
# FIREBASE PUSH DELIVERY
# ============================================================

def send_push_for_notification(
    notification_id: int,
) -> None:
    """Send an FCM push for an already committed notification.

    The recipient is retrieved from the database, never
    supplied by a client request.

    FCM acceptance does not guarantee device display.
    """

    connection = None
    cursor = None
    row = None

    try:
        connection = get_db_connection()

        cursor = connection.cursor(
            dictionary=True
        )

        cursor.execute(
            """
            SELECT
                user_id,
                title,
                message,
                notification_type,
                related_report_id,
                related_claim_id
            FROM notifications
            WHERE id = %s
            """,
            (notification_id,),
        )

        row = cursor.fetchone()

    except Exception:
        logger.exception(
            "Unable to load notification_id=%s for push.",
            notification_id,
        )
        return

    finally:
        close_db(cursor, connection)

    if row is None:
        logger.warning(
            "Push skipped: notification_id=%s not found.",
            notification_id,
        )
        return

    try:
        outcome = send_push_to_user(
            int(row["user_id"]),
            row["title"],
            row["message"],
            notification_type=row["notification_type"],
            related_report_id=row["related_report_id"],
            related_claim_id=row["related_claim_id"],
        )

        logger.info(
            "Push notification_id=%s accepted_by_fcm=%s failed=%s",
            notification_id,
            outcome.get("sent", 0),
            outcome.get("failed", 0),
        )

    except Exception:
        logger.exception(
            "Push delivery failed for notification_id=%s.",
            notification_id,
        )


# ============================================================
# PUSH QUEUE MANAGEMENT
# ============================================================

def _push_job_finished(
    notification_id: int,
    future: Future,
) -> None:
    """Release the queue slot after a worker completes."""

    with _push_lock:
        _pending_push_ids.discard(
            notification_id
        )

        _push_slots.release()

    try:
        future.result()

    except Exception:
        logger.exception(
            "Unexpected push worker failure "
            "for notification_id=%s.",
            notification_id,
        )


def queue_push_for_notification(
    notification_id: int,
) -> None:
    """Queue a committed notification for push delivery.

    Duplicate requests are ignored only while the job
    is waiting or running.

    This is best-effort delivery, not permanent
    exactly-once delivery.
    """

    if (
        type(notification_id) is not int
        or notification_id <= 0
    ):
        raise ValueError(
            "notification_id must be a positive integer."
        )

    with _push_lock:
        if notification_id in _pending_push_ids:
            logger.debug(
                "Duplicate pending push ignored "
                "for notification_id=%s.",
                notification_id,
            )
            return

        # Prevent unlimited queued background tasks.
        if not _push_slots.acquire(
            blocking=False
        ):
            logger.warning(
                "Push queue full. "
                "notification_id=%s was not queued.",
                notification_id,
            )
            return

        _pending_push_ids.add(
            notification_id
        )

    try:
        future = _push_executor.submit(
            send_push_for_notification,
            notification_id,
        )

    except Exception:
        with _push_lock:
            _pending_push_ids.discard(
                notification_id
            )

            _push_slots.release()

        logger.exception(
            "Unable to enqueue push "
            "for notification_id=%s.",
            notification_id,
        )
        return

    future.add_done_callback(
        lambda completed: _push_job_finished(
            notification_id,
            completed,
        )
    )


# ============================================================
# GET MY NOTIFICATIONS
# ============================================================

@router.get("")
def list_notifications(
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None

    try:
        connection = get_db_connection()

        cursor = connection.cursor(
            dictionary=True
        )

        cursor.execute(
            """
            SELECT
                id,
                title,
                message,
                notification_type,
                related_report_id,
                related_claim_id,
                is_read,
                created_at
            FROM notifications
            WHERE user_id = %s
            ORDER BY
                created_at DESC,
                id DESC
            LIMIT 100
            """,
            (user["id"],),
        )

        rows = cursor.fetchall()

        return {
            "notifications": [
                notification_response(row)
                for row in rows
            ]
        }

    except Exception as exc:
        logger.exception(
            "Unable to retrieve notifications "
            "for user_id=%s.",
            user["id"],
        )

        raise HTTPException(
            status_code=500,
            detail="Could not retrieve notifications.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# GET UNREAD NOTIFICATION COUNT
# ============================================================

@router.get("/unread-count")
def get_unread_count(
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None

    try:
        connection = get_db_connection()

        cursor = connection.cursor(
            dictionary=True
        )

        cursor.execute(
            """
            SELECT COUNT(*) AS unread_count
            FROM notifications
            WHERE user_id = %s
              AND is_read = 0
            """,
            (user["id"],),
        )

        row = cursor.fetchone()

        return {
            "unread_count": int(
                row["unread_count"]
            )
        }

    except Exception as exc:
        logger.exception(
            "Unable to count unread notifications "
            "for user_id=%s.",
            user["id"],
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Could not retrieve unread "
                "notification count."
            ),
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# MARK ALL MY NOTIFICATIONS AS READ
# ============================================================

@router.patch("/read-all")
def mark_all_notifications_read(
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None

    try:
        connection = get_db_connection()

        cursor = connection.cursor()

        cursor.execute(
            """
            UPDATE notifications
            SET is_read = 1
            WHERE user_id = %s
              AND is_read = 0
            """,
            (user["id"],),
        )

        updated_count = cursor.rowcount

        connection.commit()

        return {
            "message": "All notifications marked as read.",
            "updated_count": updated_count,
        }

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Unable to mark all notifications "
            "as read for user_id=%s.",
            user["id"],
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Could not mark notifications as read."
            ),
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# MARK ONE NOTIFICATION AS READ
# ============================================================

@router.patch("/{notification_id}/read")
def mark_notification_read(
    notification_id: int,
    user: dict = Depends(get_current_user),
):
    if notification_id <= 0:
        raise HTTPException(
            status_code=404,
            detail="Notification not found.",
        )

    connection = None
    cursor = None

    try:
        connection = get_db_connection()

        cursor = connection.cursor(
            dictionary=True
        )

        cursor.execute(
            """
            UPDATE notifications
            SET is_read = 1
            WHERE id = %s
              AND user_id = %s
              AND is_read = 0
            """,
            (
                notification_id,
                user["id"],
            ),
        )

        if cursor.rowcount == 0:
            # Already-read notifications are valid.
            # But another user's notification must remain hidden.
            cursor.execute(
                """
                SELECT id
                FROM notifications
                WHERE id = %s
                  AND user_id = %s
                """,
                (
                    notification_id,
                    user["id"],
                ),
            )

            if cursor.fetchone() is None:
                raise HTTPException(
                    status_code=404,
                    detail="Notification not found.",
                )

        connection.commit()

        return {
            "message": "Notification marked as read."
        }

    except HTTPException:
        rollback_db(connection)
        raise

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Unable to mark notification_id=%s "
            "as read for user_id=%s.",
            notification_id,
            user["id"],
        )

        raise HTTPException(
            status_code=500,
            detail="Could not update notification.",
        ) from exc

    finally:
        close_db(cursor, connection)
