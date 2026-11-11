"""MySQL connection configuration for local development and Railway."""

import os

import mysql.connector
from dotenv import load_dotenv

load_dotenv()


def get_db_connection():
    """Create a MySQL connection without embedding credentials in source code."""
    on_railway = bool(os.getenv("RAILWAY_ENVIRONMENT"))

    if on_railway:
        # Fail closed instead of falling back to local XAMPP credentials.
        required = ("DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME")
        missing = [key for key in required if not os.getenv(key)]
        if missing:
            raise RuntimeError(
                "Missing Railway database environment variables: "
                + ", ".join(missing)
            )

    db_host = os.getenv("DB_HOST", "127.0.0.1").strip()
    db_port_value = os.getenv("DB_PORT", "3306").strip()
    db_user = os.getenv("DB_USER", "root").strip()
    db_password = os.getenv("DB_PASSWORD", "")
    db_name = os.getenv("DB_NAME", "lost_found_db").strip()

    try:
        db_port = int(db_port_value)
    except (TypeError, ValueError) as exc:
        raise ValueError("DB_PORT must be a valid integer.") from exc

    if not 1 <= db_port <= 65535:
        raise ValueError("DB_PORT must be between 1 and 65535.")

    if not db_host or not db_user or not db_name:
        raise ValueError("DB_HOST, DB_USER, and DB_NAME must not be empty.")

    return mysql.connector.connect(
        host=db_host,
        port=db_port,
        user=db_user,
        password=db_password,
        database=db_name,
        connection_timeout=10,
    )