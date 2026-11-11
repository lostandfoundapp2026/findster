# Save as: backend/auth.py
# FINDSTER - Authentication and current user profile
# Includes structured name fields while retaining full_name compatibility.

import logging
import os

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import (
    HTTPAuthorizationCredentials,
    HTTPBearer,
)

from database import get_db_connection

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)


def unauthorized(
    detail: str = "Invalid or expired token.",
) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict:
    if credentials is None or not credentials.credentials:
        raise unauthorized("Authentication required.")

    secret = os.getenv("JWT_SECRET")
    algorithm = os.getenv(
        "JWT_ALGORITHM",
        "HS256",
    ).strip().upper()

    if not secret or algorithm != "HS256":
        logger.error("Invalid JWT authentication configuration.")
        raise HTTPException(
            status_code=500,
            detail="Authentication is not configured.",
        )

    try:
        payload = jwt.decode(
            credentials.credentials,
            secret,
            algorithms=["HS256"],
            options={"require": ["exp", "sub"]},
        )

        subject = payload.get("sub")

        if (
            not isinstance(subject, str)
            or not subject.isdecimal()
        ):
            raise ValueError("Invalid JWT subject.")

        user_id = int(subject)

        if user_id <= 0:
            raise ValueError("Invalid user ID.")

        # Keep compatibility with previously issued tokens.
        token_version = payload.get("token_version", 0)

        if (
            type(token_version) is not int
            or token_version < 0
        ):
            raise ValueError("Invalid token version.")

    except (
        jwt.InvalidTokenError,
        ValueError,
        TypeError,
        OverflowError,
    ) as exc:
        raise unauthorized() from exc

    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        # The structured name fields are nullable for existing accounts.
        # Keep full_name in the response for existing Findster features.
        cursor.execute(
            """
            SELECT
                id,
                first_name,
                middle_name,
                last_name,
                full_name,
                email,
                contact_number,
                barangay,
                token_version
            FROM users
            WHERE id = %s
            LIMIT 1
            """,
            (user_id,),
        )

        user = cursor.fetchone()

        if user is None:
            raise unauthorized("User account not found.")

        # Reject tokens issued before a session version change.
        if token_version != user["token_version"]:
            raise unauthorized(
                "Your session has expired. Please sign in again."
            )

        # Never expose the internal token version in API responses.
        user.pop("token_version", None)

        return user

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "Database lookup failed during authentication."
        )

        raise HTTPException(
            status_code=503,
            detail="Authentication is temporarily unavailable.",
        ) from exc

    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                logger.warning(
                    "Failed to close authentication cursor."
                )

        if connection is not None:
            try:
                connection.close()
            except Exception:
                logger.warning(
                    "Failed to close authentication connection."
                )