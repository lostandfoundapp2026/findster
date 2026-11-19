# Save as: backend/claims.py

"""Lost and Found claim requests, decisions, and handover confirmation."""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from auth import get_current_user
from database import get_db_connection
from notifications import queue_push_for_notification


logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/claims",
    tags=["Claim Requests"],
)

REJECTED_CLAIM_COOLDOWN_HOURS = 24


# ============================================================
# REQUEST MODELS
# ============================================================

class ClaimCreate(BaseModel):
    message: str | None = Field(
        default=None,
        max_length=500,
    )

    # Kept for compatibility with existing claims and database schema.
    # New requests no longer require private verification text: ownership
    # is verified through the existing private chat workflow.
    verification_details: str = Field(
        default="",
        max_length=2000,
    )

    @field_validator("verification_details")
    @classmethod
    def normalize_verification_details(cls, value: str) -> str:
        return value.strip()


class ClaimDecision(BaseModel):
    action: Literal["approve", "reject"]


# ============================================================
# HELPERS
# ============================================================

def request_kind(report_type: str) -> str:
    if report_type == "found":
        return "ownership_claim"

    return "found_item_response"


def request_label(report_type: str) -> str:
    if report_type == "found":
        return "ownership claim"

    return "found-item response"


def close_db(cursor, connection):
    if cursor is not None:
        try:
            cursor.close()
        except Exception:
            logger.exception(
                "Unable to close claims database cursor."
            )

    if connection is not None:
        try:
            connection.close()
        except Exception:
            logger.exception(
                "Unable to close claims database connection."
            )


def rollback_db(connection):
    if connection is not None:
        try:
            connection.rollback()
        except Exception:
            logger.exception(
                "Claims database rollback failed."
            )


def claim_response(row):
    """Preserve existing fields and expose closure_reason."""

    return {
        "id": row["id"],
        "report_id": row["report_id"],
        "requester_id": row["requester_id"],
        "requester_name": row.get("requester_name"),
        "requester_email": row.get("requester_email"),
        "report_owner_id": row.get("report_owner_id"),
        "item_name": row.get("item_name"),
        "report_status": row.get("report_status"),
        "report_type": row.get("report_type"),
        "request_kind": (
            request_kind(row["report_type"])
            if row.get("report_type") in ("lost", "found")
            else None
        ),
        "message": row.get("message"),
        "verification_details": row.get(
            "verification_details"
        ),
        "owner_return_confirmed_at": (
            row["owner_return_confirmed_at"].isoformat()
            if row.get("owner_return_confirmed_at")
            else None
        ),
        "requester_return_confirmed_at": (
            row["requester_return_confirmed_at"].isoformat()
            if row.get("requester_return_confirmed_at")
            else None
        ),
        "status": row["status"],
        "closure_reason": row.get("closure_reason"),
        "created_at": (
            row["created_at"].isoformat()
            if row.get("created_at")
            else None
        ),
        "updated_at": (
            row["updated_at"].isoformat()
            if row.get("updated_at")
            else None
        ),
    }


def create_notification(
    cursor,
    user_id: int,
    title: str,
    message: str,
    notification_type: str,
    report_id: int | None = None,
    claim_id: int | None = None,
):
    """Insert an in-app notification inside the current transaction."""

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
            user_id,
            title,
            message,
            notification_type,
            report_id,
            claim_id,
        ),
    )

    return int(cursor.lastrowid)


def dispatch_committed_pushes(
    notification_ids: list[int],
) -> None:
    """Queue Firebase pushes only after the DB transaction commits."""

    for notification_id in notification_ids:
        try:
            queue_push_for_notification(notification_id)
        except Exception:
            logger.exception(
                "Unable to queue push for notification_id=%s",
                notification_id,
            )


def get_report_for_update(cursor, report_id: int):
    """Lock the parent report before modifying related claims."""

    cursor.execute(
        """
        SELECT
            id,
            user_id,
            item_name,
            report_type,
            status
        FROM reports
        WHERE id = %s
        FOR UPDATE
        """,
        (report_id,),
    )

    return cursor.fetchone()


def get_claim_reference(cursor, claim_id: int):
    """Read the report reference before acquiring write locks."""

    cursor.execute(
        """
        SELECT report_id
        FROM claim_requests
        WHERE id = %s
        """,
        (claim_id,),
    )

    return cursor.fetchone()


def get_locked_claim(cursor, claim_id: int, report_id: int):
    cursor.execute(
        """
        SELECT
            id,
            report_id,
            requester_id,
            message,
            status,
            closure_reason,
            owner_return_confirmed_at,
            requester_return_confirmed_at,
            created_at,
            updated_at
        FROM claim_requests
        WHERE id = %s
          AND report_id = %s
        FOR UPDATE
        """,
        (claim_id, report_id),
    )

    return cursor.fetchone()


def get_locked_claim_context(cursor, claim_id: int):
    """
    Acquire locks in the same order as the existing workflow:
    report first, followed by claim.
    """

    reference = get_claim_reference(cursor, claim_id)

    if not reference:
        raise HTTPException(
            status_code=404,
            detail="Claim request not found.",
        )

    report_id = reference["report_id"]

    report = get_report_for_update(cursor, report_id)

    if not report:
        raise HTTPException(
            status_code=404,
            detail="Report not found.",
        )

    claim = get_locked_claim(
        cursor,
        claim_id,
        report_id,
    )

    if not claim:
        raise HTTPException(
            status_code=404,
            detail="Claim request not found.",
        )

    return report_id, report, claim


def require_report_owner(report, user):
    if report["user_id"] != user["id"]:
        raise HTTPException(
            status_code=403,
            detail="Only the report owner can perform this action.",
        )


def require_pending_claim(claim):
    if claim["status"] != "pending":
        raise HTTPException(
            status_code=409,
            detail=(
                "This request has already been processed. "
                "Please refresh."
            ),
        )


def update_claim_as_rejected(
    cursor,
    claim_id: int,
    report_id: int,
    closure_reason: str,
):
    """
    Close exactly one pending claim and record why it was closed.
    """

    cursor.execute(
        """
        UPDATE claim_requests
        SET
            status = 'rejected',
            closure_reason = %s
        WHERE id = %s
          AND report_id = %s
          AND status = 'pending'
        """,
        (
            closure_reason,
            claim_id,
            report_id,
        ),
    )

    if cursor.rowcount != 1:
        raise HTTPException(
            status_code=409,
            detail=(
                "The request status changed. "
                "Please refresh and try again."
            ),
        )


# ============================================================
# CREATE CLAIM / FOUND-ITEM RESPONSE
# ============================================================

@router.post("/reports/{report_id}", status_code=201)
def create_claim_request(
    report_id: int,
    data: ClaimCreate,
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None
    push_notification_ids: list[int] = []

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        report = get_report_for_update(cursor, report_id)

        if not report:
            raise HTTPException(
                status_code=404,
                detail="Report not found.",
            )

        if report["user_id"] == user["id"]:
            raise HTTPException(
                status_code=400,
                detail=(
                    "You cannot submit a request "
                    "for your own report."
                ),
            )

        if report["status"] != "active":
            raise HTTPException(
                status_code=409,
                detail=(
                    "This report is no longer accepting requests."
                ),
            )

        # Prevent duplicate active requests.
        cursor.execute(
            """
            SELECT id
            FROM claim_requests
            WHERE report_id = %s
              AND requester_id = %s
              AND status IN ('pending', 'approved')
            LIMIT 1
            """,
            (report_id, user["id"]),
        )

        if cursor.fetchone():
            raise HTTPException(
                status_code=409,
                detail=(
                    "You already have a pending or approved "
                    "request for this report."
                ),
            )

        # Preserve the existing 24-hour rejection cooldown.
        cursor.execute(
            """
            SELECT id
            FROM claim_requests
            WHERE report_id = %s
              AND requester_id = %s
              AND status = 'rejected'
              AND updated_at >
                  UTC_TIMESTAMP() - INTERVAL 24 HOUR
            LIMIT 1
            """,
            (report_id, user["id"]),
        )

        if cursor.fetchone():
            raise HTTPException(
                status_code=429,
                detail=(
                    "Your previous request was closed. "
                    "Please wait 24 hours before submitting "
                    "another request for this report."
                ),
            )

        # A report cannot accept another request after selection.
        cursor.execute(
            """
            SELECT id
            FROM claim_requests
            WHERE report_id = %s
              AND status = 'approved'
            LIMIT 1
            """,
            (report_id,),
        )

        if cursor.fetchone():
            raise HTTPException(
                status_code=409,
                detail=(
                    "This report already has a selected request."
                ),
            )

        message = (
            data.message.strip()
            if data.message and data.message.strip()
            else None
        )

        cursor.execute(
            """
            INSERT INTO claim_requests (
                report_id,
                requester_id,
                message,
                verification_details
            )
            VALUES (%s, %s, %s, %s)
            """,
            (
                report_id,
                user["id"],
                message,
                data.verification_details,
            ),
        )

        claim_id = int(cursor.lastrowid)

        if report["report_type"] == "found":
            notice_title = "New Ownership Claim"
            notice_message = (
                f'Someone says they own the found item '
                f'"{report["item_name"]}".'
            )
        else:
            notice_title = "Someone May Have Found Your Item"
            notice_message = (
                f'Someone responded that they may have found '
                f'"{report["item_name"]}".'
            )

        push_notification_ids.append(
            create_notification(
                cursor=cursor,
                user_id=report["user_id"],
                title=notice_title,
                message=notice_message,
                notification_type="new_claim",
                report_id=report_id,
                claim_id=claim_id,
            )
        )

        connection.commit()

        dispatch_committed_pushes(push_notification_ids)

        logger.info(
            "Claim created claim_id=%s report_id=%s requester_id=%s",
            claim_id,
            report_id,
            user["id"],
        )

        return {
            "message": (
                "Ownership claim submitted successfully."
                if report["report_type"] == "found"
                else "Found-item response submitted successfully."
            ),
            "claim_id": claim_id,
            "report_type": report["report_type"],
            "request_kind": request_kind(
                report["report_type"]
            ),
            "status": "pending",
        }

    except HTTPException:
        rollback_db(connection)
        raise

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Unable to create claim for report_id=%s",
            report_id,
        )

        raise HTTPException(
            status_code=500,
            detail="Could not submit claim request.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# LIST MY SUBMITTED CLAIMS
# ============================================================

@router.get("/mine")
def list_my_claim_requests(
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            """
            SELECT
                c.*,
                r.user_id AS report_owner_id,
                r.item_name,
                r.report_type,
                r.status AS report_status
            FROM claim_requests AS c
            JOIN reports AS r
                ON r.id = c.report_id
            WHERE c.requester_id = %s
            ORDER BY
                c.created_at DESC,
                c.id DESC
            """,
            (user["id"],),
        )

        rows = cursor.fetchall()

        return {
            "claims": [
                claim_response(row)
                for row in rows
            ]
        }

    except Exception as exc:
        logger.exception(
            "Unable to retrieve claims for user_id=%s",
            user["id"],
        )

        raise HTTPException(
            status_code=500,
            detail="Could not retrieve your claim requests.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# LIST RECEIVED CLAIMS
# ============================================================

@router.get("/received")
def list_received_claim_requests(
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            """
            SELECT
                c.*,
                r.user_id AS report_owner_id,
                r.item_name,
                r.report_type,
                r.status AS report_status,
                u.full_name AS requester_name,
                u.email AS requester_email
            FROM claim_requests AS c
            JOIN reports AS r
                ON r.id = c.report_id
            JOIN users AS u
                ON u.id = c.requester_id
            WHERE r.user_id = %s
            ORDER BY
                CASE
                    WHEN c.status = 'pending' THEN 0
                    ELSE 1
                END,
                c.created_at DESC,
                c.id DESC
            """,
            (user["id"],),
        )

        rows = cursor.fetchall()

        return {
            "claims": [
                claim_response(row)
                for row in rows
            ]
        }

    except Exception as exc:
        logger.exception(
            "Unable to retrieve received claims for user_id=%s",
            user["id"],
        )

        raise HTTPException(
            status_code=500,
            detail="Could not retrieve received claim requests.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# GET CURRENT USER'S CLAIM FOR A REPORT
# ============================================================

@router.get("/reports/{report_id}/mine")
def get_my_claim_for_report(
    report_id: int,
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            """
            SELECT
                c.*,
                r.user_id AS report_owner_id,
                r.item_name,
                r.report_type,
                r.status AS report_status
            FROM claim_requests AS c
            JOIN reports AS r
                ON r.id = c.report_id
            WHERE c.report_id = %s
              AND c.requester_id = %s
            ORDER BY
                c.created_at DESC,
                c.id DESC
            LIMIT 1
            """,
            (
                report_id,
                user["id"],
            ),
        )

        row = cursor.fetchone()

        return {
            "claim": (
                claim_response(row)
                if row
                else None
            )
        }

    except Exception as exc:
        logger.exception(
            "Unable to retrieve user's claim for report_id=%s",
            report_id,
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Could not retrieve your claim "
                "for this report."
            ),
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# FOUND REPORT: APPROVE OR REJECT OWNERSHIP CLAIM
# ============================================================

@router.patch("/{claim_id}/decision")
def decide_claim_request(
    claim_id: int,
    data: ClaimDecision,
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None
    push_notification_ids: list[int] = []

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        report_id, report, claim = get_locked_claim_context(
            cursor,
            claim_id,
        )

        require_report_owner(report, user)

        # Lost Reports must use Not a Match or physical receipt.
        if report["report_type"] != "found":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Lost-item responses do not use Approve/Reject. "
                    "Use Not a Match for an incorrect item, "
                    "or confirm physical receipt after receiving "
                    "the correct item."
                ),
            )

        require_pending_claim(claim)

        if report["status"] != "active":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Only active reports can process ownership claims."
                ),
            )

        # ----------------------------------------------------
        # MANUAL REJECTION
        # ----------------------------------------------------

        if data.action == "reject":
            update_claim_as_rejected(
                cursor=cursor,
                claim_id=claim_id,
                report_id=report_id,
                closure_reason="verification_failed",
            )

            push_notification_ids.append(
                create_notification(
                    cursor=cursor,
                    user_id=claim["requester_id"],
                    title="Ownership Claim Not Verified",
                    message=(
                        f'Your ownership claim for '
                        f'"{report["item_name"]}" was reviewed '
                        f'and could not be verified by the finder.'
                    ),
                    notification_type="claim_rejected",
                    report_id=report_id,
                    claim_id=claim_id,
                )
            )

            connection.commit()

            dispatch_committed_pushes(push_notification_ids)

            return {
                "message": "Ownership claim rejected.",
                "status": "rejected",
                "closure_reason": "verification_failed",
            }

        # ----------------------------------------------------
        # APPROVAL
        # ----------------------------------------------------

        cursor.execute(
            """
            SELECT id
            FROM claim_requests
            WHERE report_id = %s
              AND status = 'approved'
            LIMIT 1
            FOR UPDATE
            """,
            (report_id,),
        )

        if cursor.fetchone():
            raise HTTPException(
                status_code=409,
                detail="Another claim has already been approved.",
            )

        cursor.execute(
            """
            SELECT id, requester_id
            FROM claim_requests
            WHERE report_id = %s
              AND id <> %s
              AND status = 'pending'
            FOR UPDATE
            """,
            (report_id, claim_id),
        )

        other_pending_claims = cursor.fetchall()

        cursor.execute(
            """
            UPDATE claim_requests
            SET
                status = 'approved',
                closure_reason = NULL
            WHERE id = %s
              AND report_id = %s
              AND status = 'pending'
            """,
            (claim_id, report_id),
        )

        if cursor.rowcount != 1:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The claim status changed. "
                    "Please refresh."
                ),
            )

        # Close all other pending ownership claims.
        cursor.execute(
            """
            UPDATE claim_requests
            SET
                status = 'rejected',
                closure_reason = 'owner_verified'
            WHERE report_id = %s
              AND id <> %s
              AND status = 'pending'
            """,
            (report_id, claim_id),
        )

        cursor.execute(
            """
            UPDATE reports
            SET status = 'claimed'
            WHERE id = %s
              AND user_id = %s
              AND status = 'active'
            """,
            (report_id, user["id"]),
        )

        if cursor.rowcount != 1:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The report status changed. "
                    "Please refresh and try again."
                ),
            )

        push_notification_ids.append(
            create_notification(
                cursor=cursor,
                user_id=claim["requester_id"],
                title="Ownership Claim Approved",
                message=(
                    f'Your ownership claim for '
                    f'"{report["item_name"]}" has been approved. '
                    f'Please coordinate the physical item handover '
                    f'with the finder.'
                ),
                notification_type="claim_approved",
                report_id=report_id,
                claim_id=claim_id,
            )
        )

        for other_claim in other_pending_claims:
            push_notification_ids.append(
                create_notification(
                    cursor=cursor,
                    user_id=other_claim["requester_id"],
                    title="Ownership Claim Closed",
                    message=(
                        f'The found item "{report["item_name"]}" '
                        f'has been matched with another verified owner. '
                        f'Your pending ownership claim is now closed.'
                    ),
                    notification_type="claim_rejected",
                    report_id=report_id,
                    claim_id=other_claim["id"],
                )
            )

        connection.commit()

        dispatch_committed_pushes(push_notification_ids)

        logger.info(
            "Ownership claim approved claim_id=%s report_id=%s",
            claim_id,
            report_id,
        )

        return {
            "message": (
                "Ownership claim approved. "
                "Other pending requests were closed."
            ),
            "status": "approved",
            "closure_reason": None,
            "rejected_pending_claims": len(
                other_pending_claims
            ),
        }

    except HTTPException:
        rollback_db(connection)
        raise

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Unable to process claim decision claim_id=%s",
            claim_id,
        )

        raise HTTPException(
            status_code=500,
            detail="Could not process this claim request.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# LOST REPORT: MARK A FINDER RESPONSE AS NOT A MATCH
# ============================================================

@router.patch("/{claim_id}/not-a-match")
def mark_finder_response_not_a_match(
    claim_id: int,
    user: dict = Depends(get_current_user),
):
    """
    Only a Lost Report owner may mark a pending response
    as Not a Match.

    This closes one incorrect response without closing the
    Lost Report or affecting other pending responses.
    """

    connection = None
    cursor = None
    push_notification_ids: list[int] = []

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        report_id, report, claim = get_locked_claim_context(
            cursor,
            claim_id,
        )

        require_report_owner(report, user)

        if report["report_type"] != "lost":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Not a Match is only available "
                    "for Lost Report finder responses."
                ),
            )

        if report["status"] != "active":
            raise HTTPException(
                status_code=409,
                detail=(
                    "This Lost Report is no longer "
                    "accepting verification decisions."
                ),
            )

        require_pending_claim(claim)

        update_claim_as_rejected(
            cursor=cursor,
            claim_id=claim_id,
            report_id=report_id,
            closure_reason="not_a_match",
        )

        push_notification_ids.append(
            create_notification(
                cursor=cursor,
                user_id=claim["requester_id"],
                title="Found-Item Response Not a Match",
                message=(
                    f'The owner of "{report["item_name"]}" '
                    f'reviewed your response and determined '
                    f'that the item does not match their lost item. '
                    f'Thank you for your assistance.'
                ),
                notification_type="claim_rejected",
                report_id=report_id,
                claim_id=claim_id,
            )
        )

        connection.commit()

        dispatch_committed_pushes(push_notification_ids)

        logger.info(
            "Finder response not a match claim_id=%s report_id=%s",
            claim_id,
            report_id,
        )

        return {
            "message": (
                "This finder response was marked as Not a Match. "
                "The Lost Report remains active."
            ),
            "status": "rejected",
            "closure_reason": "not_a_match",
            "report_status": "active",
        }

    except HTTPException:
        rollback_db(connection)
        raise

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Unable to mark finder response as Not a Match "
            "claim_id=%s",
            claim_id,
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Could not mark this finder response "
                "as Not a Match."
            ),
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# CONFIRM PHYSICAL HANDOVER
# ============================================================

@router.post("/{claim_id}/return")
def confirm_item_returned(
    claim_id: int,
    user: dict = Depends(get_current_user),
):
    """
    Two-party confirmation.

    FOUND:
        Requires the finder to approve ownership first.
        Both finder and verified owner confirm handover.

    LOST:
        The Lost Report owner first confirms actual receipt.
        This selects the correct finder and closes other
        pending responses.
        The selected finder then confirms the handover.

    The report becomes returned only after both confirm.
    """

    connection = None
    cursor = None
    push_notification_ids: list[int] = []

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        report_id, report, claim = get_locked_claim_context(
            cursor,
            claim_id,
        )

        is_owner = report["user_id"] == user["id"]
        is_requester = claim["requester_id"] == user["id"]

        if not (is_owner or is_requester):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Only the report owner and requester "
                    "can confirm the handover."
                ),
            )

        # ----------------------------------------------------
        # LOST REPORT: OWNER RECEIVES ITEM FIRST
        # ----------------------------------------------------

        if (
            report["report_type"] == "lost"
            and claim["status"] == "pending"
        ):
            if report["status"] != "active":
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This Lost Report is no longer "
                        "available for handover."
                    ),
                )

            if not is_owner:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "The Lost Report owner must confirm "
                        "physical receipt first. You can then "
                        "confirm that you handed over the item."
                    ),
                )

            cursor.execute(
                """
                SELECT id, requester_id
                FROM claim_requests
                WHERE report_id = %s
                  AND id <> %s
                  AND status = 'pending'
                FOR UPDATE
                """,
                (report_id, claim_id),
            )

            other_pending = cursor.fetchall()

            # Internally select the actual finder.
            # The UI does not show an Approve button for LOST.
            cursor.execute(
                """
                UPDATE claim_requests
                SET
                    status = 'approved',
                    closure_reason = NULL
                WHERE id = %s
                  AND report_id = %s
                  AND status = 'pending'
                """,
                (claim_id, report_id),
            )

            if cursor.rowcount != 1:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Response changed. Please refresh."
                    ),
                )

            cursor.execute(
                """
                UPDATE reports
                SET status = 'claimed'
                WHERE id = %s
                  AND user_id = %s
                  AND status = 'active'
                """,
                (report_id, user["id"]),
            )

            if cursor.rowcount != 1:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Report changed. Please refresh."
                    ),
                )

            # Close competing finder responses.
            cursor.execute(
                """
                UPDATE claim_requests
                SET
                    status = 'rejected',
                    closure_reason = 'item_recovered'
                WHERE report_id = %s
                  AND id <> %s
                  AND status = 'pending'
                """,
                (report_id, claim_id),
            )

            for other in other_pending:
                push_notification_ids.append(
                    create_notification(
                        cursor=cursor,
                        user_id=other["requester_id"],
                        title="Found-Item Response Closed",
                        message=(
                            f'The owner of "{report["item_name"]}" '
                            f'confirmed receiving their item '
                            f'from another finder. '
                            f'Your pending response is now closed. '
                            f'Thank you for your assistance.'
                        ),
                        notification_type="claim_rejected",
                        report_id=report_id,
                        claim_id=other["id"],
                    )
                )

            # Keep in-memory values consistent with the
            # changes made inside this transaction.
            claim["status"] = "approved"
            report["status"] = "claimed"

        # ----------------------------------------------------
        # HANDOVER STATUS CHECKS
        # ----------------------------------------------------

        if (
            claim["status"] != "approved"
            or report["status"] != "claimed"
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Handover confirmation is not available "
                    "for this request."
                ),
            )

        # Confirm only the currently logged-in user's side.
        if is_owner:
            field = "owner_return_confirmed_at"
        else:
            field = "requester_return_confirmed_at"

        if claim[field] is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "You have already confirmed this handover."
                ),
            )

        # Field is selected exclusively from server constants.
        cursor.execute(
            f"""
            UPDATE claim_requests
            SET {field} = UTC_TIMESTAMP()
            WHERE id = %s
              AND report_id = %s
              AND status = 'approved'
              AND {field} IS NULL
            """,
            (claim_id, report_id),
        )

        if cursor.rowcount != 1:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The confirmation changed. "
                    "Please refresh."
                ),
            )

        owner_confirmed = (
            is_owner
            or claim["owner_return_confirmed_at"] is not None
        )

        requester_confirmed = (
            is_requester
            or claim["requester_return_confirmed_at"] is not None
        )

        both_confirmed = (
            owner_confirmed and requester_confirmed
        )

        other_user_id = (
            claim["requester_id"]
            if is_owner
            else report["user_id"]
        )

        # ----------------------------------------------------
        # BOTH PARTICIPANTS CONFIRMED
        # ----------------------------------------------------

        if both_confirmed:
            cursor.execute(
                """
                UPDATE reports
                SET status = 'returned'
                WHERE id = %s
                  AND status = 'claimed'
                """,
                (report_id,),
            )

            if cursor.rowcount != 1:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Report status changed. "
                        "Please refresh."
                    ),
                )

            for participant_id in (
                report["user_id"],
                claim["requester_id"],
            ):
                push_notification_ids.append(
                    create_notification(
                        cursor=cursor,
                        user_id=participant_id,
                        title="Item Return Completed",
                        message=(
                            f'Both parties confirmed the return '
                            f'of "{report["item_name"]}".'
                        ),
                        notification_type="item_returned",
                        report_id=report_id,
                        claim_id=claim_id,
                    )
                )

            message = (
                "Both parties confirmed. "
                "The report is now returned."
            )

            report_status = "returned"

        # ----------------------------------------------------
        # WAITING FOR OTHER PARTICIPANT
        # ----------------------------------------------------

        else:
            push_notification_ids.append(
                create_notification(
                    cursor=cursor,
                    user_id=other_user_id,
                    title="Handover Confirmation Needed",
                    message=(
                        f'The other party confirmed the handover '
                        f'of "{report["item_name"]}". '
                        f'Please confirm only after the physical '
                        f'handover.'
                    ),
                    notification_type=(
                        "return_confirmation_needed"
                    ),
                    report_id=report_id,
                    claim_id=claim_id,
                )
            )

            message = (
                "Your confirmation was recorded. "
                "Waiting for the other party."
            )

            report_status = "claimed"

        connection.commit()

        dispatch_committed_pushes(push_notification_ids)

        logger.info(
            "Handover confirmation claim_id=%s "
            "user_id=%s completed=%s",
            claim_id,
            user["id"],
            both_confirmed,
        )

        return {
            "message": message,
            "status": report_status,
            "owner_return_confirmed": owner_confirmed,
            "requester_return_confirmed": requester_confirmed,
        }

    except HTTPException:
        rollback_db(connection)
        raise

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Unable to confirm handover for claim_id=%s",
            claim_id,
        )

        raise HTTPException(
            status_code=500,
            detail="Could not confirm item return.",
        ) from exc

    finally:
        close_db(cursor, connection)