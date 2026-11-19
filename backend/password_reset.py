
import hashlib
import hmac
import logging
import os
import secrets
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from threading import Lock
from time import monotonic

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from pwdlib import PasswordHash

from database import get_db_connection

router = APIRouter(
    prefix="/api/password-reset",
    tags=["Password Reset"],
)

logger = logging.getLogger(__name__)
password_hash = PasswordHash.recommended()

rate_lock = Lock()
rate_attempts = {}

GENERIC_MESSAGE = {
    "message": (
        "If this email is registered, "
        "a verification code will be sent."
    )
}


class RequestOTP(BaseModel):
    email: EmailStr


class VerifyOTP(BaseModel):
    email: EmailStr
    otp: str = Field(pattern=r"^[0-9]{6}$")


class ResetPassword(BaseModel):
    reset_token: str = Field(min_length=32, max_length=512)
    new_password: str = Field(min_length=8, max_length=128)


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def secret_hash(purpose, value):
    secret = os.getenv("JWT_SECRET", "")

    if len(secret) < 32:
        raise RuntimeError("JWT_SECRET is missing or too short.")

    return hmac.new(
        secret.encode(),
        f"password-reset:{purpose}:{value}".encode(),
        hashlib.sha256,
    ).hexdigest()


def rate_limit(key, limit, seconds):
    now = monotonic()

    with rate_lock:
        attempts = [
            timestamp
            for timestamp in rate_attempts.get(key, [])
            if now - timestamp < seconds
        ]

        if len(attempts) >= limit:
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Please try again later.",
            )

        attempts.append(now)
        rate_attempts[key] = attempts


def client_ip(request):
    return request.client.host if request.client else "unknown"


def send_otp_email(email, otp):
    host = os.getenv("SMTP_HOST", "").strip()
    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USERNAME", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    sender = os.getenv("SMTP_FROM_EMAIL", username).strip()

    if not all([host, username, password, sender]):
        raise RuntimeError("SMTP configuration is incomplete.")

    message = EmailMessage()
    message["From"] = sender
    message["To"] = email
    message["Subject"] = "Lost and Found Password Reset"

    message.set_content(
        "Your Lost and Found password reset code is:\n\n"
        f"{otp}\n\n"
        "This code expires in 10 minutes.\n"
        "If you did not request this, ignore this email."
    )

    context = ssl.create_default_context()

    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.ehlo()
        smtp.starttls(context=context)
        smtp.ehlo()
        smtp.login(username, password)
        smtp.send_message(message)


def close_connection(cursor, connection):
    if cursor is not None:
        cursor.close()

    if connection is not None:
        connection.close()


def rollback(connection):
    if connection is not None:
        try:
            connection.rollback()
        except Exception:
            pass


@router.post("/request")
def request_otp(data: RequestOTP, request: Request):
    email = str(data.email).strip().lower()

    rate_limit(
        f"reset-request-ip:{client_ip(request)}",
        8,
        900,
    )

    rate_limit(
        f"reset-request-email:{secret_hash('email', email)}",
        8,
        900,
    )

    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            "SELECT id FROM users WHERE email = %s LIMIT 1",
            (email,),
        )

        user = cursor.fetchone()

        if not user:
            return GENERIC_MESSAGE

        user_id = user["id"]

        # Serialize reset requests for the same account.
        cursor.execute(
            "SELECT id FROM users WHERE id = %s FOR UPDATE",
            (user_id,),
        )
        cursor.fetchone()

        cursor.execute(
            """
            SELECT id, created_at
            FROM password_reset_otps
            WHERE user_id = %s
              AND used_at IS NULL
              AND attempts >= 0
            ORDER BY id DESC
            LIMIT 1
            FOR UPDATE
            """,
            (user_id,),
        )

        previous = cursor.fetchone()

        if previous:
            elapsed = utc_now() - previous["created_at"]

            if elapsed < timedelta(seconds=60):
                connection.commit()
                return GENERIC_MESSAGE

        otp = f"{secrets.randbelow(1000000):06d}"

        otp_digest = secret_hash(
            "otp",
            f"{user_id}:{otp}",
        )

        cursor.execute(
            """
            UPDATE password_reset_otps
            SET used_at = %s
            WHERE user_id = %s
              AND used_at IS NULL
            """,
            (utc_now(), user_id),
        )

        cursor.execute(
            """
            INSERT INTO password_reset_otps
                (user_id, otp_hash, expires_at,
                 attempts, created_at)
            VALUES (%s, %s, %s, 0, %s)
            """,
            (
                user_id,
                otp_digest,
                utc_now() + timedelta(minutes=10),
                utc_now(),
            ),
        )

        connection.commit()

        try:
            send_otp_email(email, otp)
        except Exception:
            logger.exception("Password reset email delivery failed.")

        return GENERIC_MESSAGE

    except HTTPException:
        rollback(connection)
        raise

    except Exception:
        rollback(connection)
        logger.exception("Password reset request failed.")
        return GENERIC_MESSAGE

    finally:
        close_connection(cursor, connection)


@router.post("/verify")
def verify_otp(data: VerifyOTP, request: Request):
    email = str(data.email).strip().lower()

    rate_limit(
        f"reset-verify-ip:{client_ip(request)}",
        30,
        900,
    )

    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            "SELECT id FROM users WHERE email = %s LIMIT 1",
            (email,),
        )

        user = cursor.fetchone()

        if not user:
            raise HTTPException(
                status_code=400,
                detail="Invalid or expired verification code.",
            )

        user_id = user["id"]

        cursor.execute(
            """
            SELECT id, otp_hash, attempts, expires_at
            FROM password_reset_otps
            WHERE user_id = %s
              AND used_at IS NULL
              AND attempts >= 0
            ORDER BY id DESC
            LIMIT 1
            FOR UPDATE
            """,
            (user_id,),
        )

        record = cursor.fetchone()

        if (
            not record
            or record["expires_at"] <= utc_now()
            or record["attempts"] >= 5
        ):
            raise HTTPException(
                status_code=400,
                detail="Invalid or expired verification code.",
            )

        supplied_hash = secret_hash(
            "otp",
            f"{user_id}:{data.otp}",
        )

        if not hmac.compare_digest(
            record["otp_hash"],
            supplied_hash,
        ):
            cursor.execute(
                """
                UPDATE password_reset_otps
                SET attempts = attempts + 1
                WHERE id = %s
                """,
                (record["id"],),
            )

            connection.commit()

            raise HTTPException(
                status_code=400,
                detail="Invalid or expired verification code.",
            )

        reset_token = secrets.token_urlsafe(48)

        cursor.execute(
            """
            UPDATE password_reset_otps
            SET otp_hash = %s,
                attempts = -1,
                expires_at = %s
            WHERE id = %s
            """,
            (
                secret_hash("reset-token", reset_token),
                utc_now() + timedelta(minutes=10),
                record["id"],
            ),
        )

        connection.commit()

        return {
            "message": "Email verification successful.",
            "reset_token": reset_token,
            "expires_in": 600,
        }

    except HTTPException:
        rollback(connection)
        raise

    except Exception as exc:
        rollback(connection)
        logger.exception("OTP verification failed.")
        raise HTTPException(
            status_code=503,
            detail="Password verification is temporarily unavailable.",
        ) from exc

    finally:
        close_connection(cursor, connection)


@router.post("/confirm")
def confirm_reset(data: ResetPassword, request: Request):
    rate_limit(
        f"reset-confirm-ip:{client_ip(request)}",
        30,
        900,
    )

    if not data.new_password.strip():
        raise HTTPException(
            status_code=400,
            detail="Please enter a valid password.",
        )

    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(dictionary=True)

        token_digest = secret_hash(
            "reset-token",
            data.reset_token,
        )

        cursor.execute(
            """
            SELECT id, user_id, expires_at
            FROM password_reset_otps
            WHERE otp_hash = %s
              AND attempts = -1
              AND used_at IS NULL
            LIMIT 1
            FOR UPDATE
            """,
            (token_digest,),
        )

        record = cursor.fetchone()

        if (
            not record
            or record["expires_at"] <= utc_now()
        ):
            raise HTTPException(
                status_code=400,
                detail="Invalid or expired reset authorization.",
            )

        new_hash = password_hash.hash(data.new_password)

        cursor.execute(
            """
            UPDATE users
            SET password_hash = %s,
                token_version = token_version + 1
            WHERE id = %s
            """,
            (new_hash, record["user_id"]),
        )

        if cursor.rowcount != 1:
            raise RuntimeError("Password reset account unavailable.")

        cursor.execute(
            """
            UPDATE password_reset_otps
            SET used_at = %s
            WHERE user_id = %s
              AND used_at IS NULL
            """,
            (utc_now(), record["user_id"]),
        )

        connection.commit()

        return {
            "message": (
                "Password updated successfully. "
                "Please log in with your new password."
            )
        }

    except HTTPException:
        rollback(connection)
        raise

    except Exception as exc:
        rollback(connection)
        logger.exception("Password reset confirmation failed.")
        raise HTTPException(
            status_code=503,
            detail="Password reset is temporarily unavailable.",
        ) from exc

    finally:
        close_connection(cursor, connection)
