# Save as: backend/reports.py

"""Lost and Found report management with secure image uploads."""

import json
import logging
import os
from functools import lru_cache
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo
from io import BytesIO
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
)
from PIL import (
    Image,
    ImageOps,
    UnidentifiedImageError,
)
from pydantic import BaseModel, Field, model_validator

from auth import get_current_user
from database import get_db_connection


router = APIRouter(
    prefix="/api/reports",
    tags=["Reports"],
)

logger = logging.getLogger(__name__)


# ============================================================
# CONFIGURATION
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

# Geographic source data must be deployed beside this reports.py file.
# Coordinates in GeoJSON use [longitude, latitude] (WGS84).
BOUNDARIES_FILE = (
    Path(__file__).resolve().parent
    / "san_leonardo_barangay_boundaries.geojson"
)

# Keep API/database barangay names unchanged. GeoJSON uses some longer names.
GEOJSON_BARANGAY_NAMES = {
    "San Bartolome": "San Bartolome (Pob.)",
    "Burgos": "Burgos District (Pob.)",
    "Rizal": "Rizal District (Pob.)",
    "Bonifacio": "Bonifacio District (Pob.)",
    "Tambo-Adorable": "Tambo Adorable",
}


@lru_cache(maxsize=1)
def load_barangay_boundaries():
    """Load and validate the bundled municipality boundary data once."""
    try:
        with BOUNDARIES_FILE.open("r", encoding="utf-8-sig") as source:
            data = json.load(source)

        if data.get("type") != "FeatureCollection":
            raise ValueError("Expected a GeoJSON FeatureCollection")

        expected = {
            GEOJSON_BARANGAY_NAMES.get(name, name): name
            for name in BARANGAYS
        }
        geometries = {}
        for feature in data.get("features", []):
            properties = feature.get("properties") or {}
            if (
                properties.get("city_name") != "San Leonardo"
                or properties.get("prov_name") != "Nueva Ecija"
            ):
                raise ValueError("Boundary feature belongs to another municipality")

            raw_name = properties.get("brgy_name")
            if raw_name not in expected or raw_name in geometries:
                raise ValueError(f"Unexpected or duplicate barangay: {raw_name}")

            geometry = feature.get("geometry") or {}
            if geometry.get("type") not in ("Polygon", "MultiPolygon"):
                raise ValueError(f"Unsupported geometry for {raw_name}")
            if not geometry.get("coordinates"):
                raise ValueError(f"Empty boundary for {raw_name}")
            geometries[raw_name] = geometry

        if set(geometries) != set(expected):
            raise ValueError("Boundary file must contain the 15 expected barangays")
        return {app_name: geometries[geo_name] for geo_name, app_name in expected.items()}

    except (OSError, ValueError, TypeError, KeyError) as exc:
        logger.exception("San Leonardo GeoJSON could not be loaded")
        # Fail closed; never accept an unverified report on a broken deployment.
        raise HTTPException(
            status_code=503,
            detail="Location boundary validation is temporarily unavailable.",
        ) from exc


def point_on_segment(lon, lat, ax, ay, bx, by):
    """Boundary-inclusive segment check in longitude/latitude degrees."""
    # Small floating-point tolerance; this is not a GPS accuracy buffer.
    epsilon = 1e-11
    cross = (lon - ax) * (by - ay) - (lat - ay) * (bx - ax)
    if abs(cross) > epsilon:
        return False
    return (
        min(ax, bx) - epsilon <= lon <= max(ax, bx) + epsilon
        and min(ay, by) - epsilon <= lat <= max(ay, by) + epsilon
    )


def ring_contains_point(ring, lon, lat):
    """Return (inside, on_boundary) using a ray-casting test."""
    inside = False
    if len(ring) < 4:
        return False, False
    for index in range(len(ring)):
        ax, ay = ring[index]
        bx, by = ring[(index + 1) % len(ring)]
        if point_on_segment(lon, lat, ax, ay, bx, by):
            return True, True
        if (ay > lat) != (by > lat):
            at_longitude = ax + (lat - ay) * (bx - ax) / (by - ay)
            if lon < at_longitude:
                inside = not inside
    return inside, False


def geometry_covers_point(geometry, longitude, latitude):
    """Check Polygon or MultiPolygon, including holes and borders."""
    geometry_type = geometry["type"]
    polygons = (
        [geometry["coordinates"]]
        if geometry_type == "Polygon"
        else geometry["coordinates"]
    )
    for rings in polygons:
        if not rings:
            continue
        inside, boundary = ring_contains_point(rings[0], longitude, latitude)
        if not inside:
            continue
        if boundary:
            return True
        in_hole = False
        for hole in rings[1:]:
            hole_inside, hole_boundary = ring_contains_point(
                hole, longitude, latitude
            )
            if hole_boundary:
                return True
            if hole_inside:
                in_hole = True
                break
        if not in_hole:
            return True
    return False


def validate_incident_location(data):
    """Require a report's incident coordinates within its selected barangay.

    The location is where the item was lost/found, NOT where the user is
    when submitting the report. Selection and coordinates must agree.
    """
    if data.latitude is None or data.longitude is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "Select the actual lost/found location on the map or provide "
                "GPS coordinates inside San Leonardo before saving."
            ),
        )

    boundaries = load_barangay_boundaries()
    selected_boundary = boundaries[data.barangay]
    lon, lat = data.longitude, data.latitude
    if geometry_covers_point(selected_boundary, lon, lat):
        return

    matched_barangay = next(
        (
            name
            for name, geometry in boundaries.items()
            if geometry_covers_point(geometry, lon, lat)
        ),
        None,
    )
    if matched_barangay is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "The reported item's location is outside San Leonardo, "
                "Nueva Ecija. Only incidents within San Leonardo are accepted."
            ),
        )

    raise HTTPException(
        status_code=422,
        detail=(
            f"The selected location is in Barangay {matched_barangay}, "
            f"not Barangay {data.barangay}. Update the barangay or map pin."
        ),
    )


# Match the report-serving path in main.py. In Railway, uploads live
# on the persistent volume; locally, use backend/uploads as before.
DEFAULT_STORAGE_ROOT = (
    "/app/storage"
    if os.getenv("RAILWAY_ENVIRONMENT")
    else str(Path(__file__).resolve().parent)
)

STORAGE_ROOT = Path(
    os.getenv("FINDSTER_STORAGE_ROOT", DEFAULT_STORAGE_ROOT)
).expanduser().resolve()

UPLOAD_DIR = STORAGE_ROOT / "uploads" / "reports"

UPLOAD_DIR.mkdir(
    parents=True,
    exist_ok=True,
)

ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ("JPEG", ".jpg"),
    "image/png": ("PNG", ".png"),
    "image/webp": ("WEBP", ".webp"),
}

MAX_IMAGE_SIZE = 5 * 1024 * 1024

MAX_IMAGE_PIXELS = 20_000_000

MAX_IMAGE_DIMENSION = 8000

# Pillow's own decompression-bomb protection.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


# ============================================================
# DATA MODELS
# ============================================================

class ReportCreate(BaseModel):
    report_type: Literal["lost", "found"]

    item_name: str = Field(
        min_length=2,
        max_length=150,
    )

    description: str = Field(
        min_length=2,
        max_length=5000,
    )

    category: str = Field(
        min_length=2,
        max_length=100,
    )

    barangay: str

    specific_location: str | None = Field(
        default=None,
        max_length=255,
    )

    date_lost_found: date | None = None
    time_lost_found: time | None = None

    latitude: float | None = Field(
        default=None,
        ge=-90,
        le=90,
        allow_inf_nan=False,
    )

    longitude: float | None = Field(
        default=None,
        ge=-180,
        le=180,
        allow_inf_nan=False,
    )

    @model_validator(mode="after")
    def validate_report(self):
        if (self.latitude is None) != (
            self.longitude is None
        ):
            raise ValueError(
                "Latitude and longitude must both be "
                "provided or both be empty."
            )

        if not self.item_name.strip():
            raise ValueError(
                "Item name cannot be empty."
            )

        if not self.description.strip():
            raise ValueError(
                "Description cannot be empty."
            )

        if not self.category.strip():
            raise ValueError(
                "Category cannot be empty."
            )

        if self.barangay not in BARANGAYS:
            raise ValueError(
                "Please select a valid barangay "
                "in San Leonardo."
            )

        # Incident dates are supplied by the reporter; submission time is server-managed.
        now_local = datetime.now(ZoneInfo("Asia/Manila"))
        if self.time_lost_found is not None and self.date_lost_found is None:
            raise ValueError("Select an incident date before entering an incident time.")
        if self.date_lost_found is not None:
            if self.date_lost_found > now_local.date():
                raise ValueError("Incident date cannot be in the future.")
            if self.time_lost_found is not None:
                incident = datetime.combine(self.date_lost_found, self.time_lost_found)
                if incident > now_local.replace(tzinfo=None):
                    raise ValueError("Incident date and time cannot be in the future.")

        return self


# ============================================================
# RESPONSE FORMAT
# ============================================================

def format_report_time(value):
    """MySQL TIME columns can be returned as timedelta, time or string."""
    if value is None:
        return None
    if isinstance(value, timedelta):
        total_seconds = int(value.total_seconds())
        if not 0 <= total_seconds < 86400:
            return None
        hours, remainder = divmod(total_seconds, 3600)
        minutes = remainder // 60
        return f"{hours:02d}:{minutes:02d}"
    if isinstance(value, time):
        return value.strftime("%H:%M")
    return str(value)[:5]


def report_response(row):
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "report_type": row["report_type"],
        "item_name": row["item_name"],
        "description": row["description"],
        "category": row["category"],
        "barangay": row["barangay"],
        "specific_location": row["specific_location"],
        "date_lost_found": (
            row["date_lost_found"].isoformat()
            if row["date_lost_found"]
            else None
        ),
        "time_lost_found": format_report_time(row.get("time_lost_found")),
        "image_url": row.get("image_url"),
        "status": row["status"],
        "created_at": (
            row["created_at"].isoformat()
            if row["created_at"]
            else None
        ),
        "updated_at": (
            row["updated_at"].isoformat()
            if row["updated_at"]
            else None
        ),
        "latitude": (
            float(row["latitude"])
            if row.get("latitude") is not None
            else None
        ),
        "longitude": (
            float(row["longitude"])
            if row.get("longitude") is not None
            else None
        ),
    }


# ============================================================
# DATABASE HELPERS
# ============================================================

def close_db(cursor, connection):
    if cursor is not None:
        try:
            cursor.close()
        except Exception:
            logger.exception(
                "Failed to close database cursor."
            )

    if connection is not None:
        try:
            connection.close()
        except Exception:
            logger.exception(
                "Failed to close database connection."
            )


def rollback_db(connection):
    if connection is not None:
        try:
            connection.rollback()
        except Exception:
            logger.exception(
                "Database rollback failed."
            )


# ============================================================
# IMAGE HELPERS
# ============================================================

def cleanup_saved_image(image_path: Path | None):
    """Remove a temporary image when an operation fails."""

    if image_path is None:
        return

    try:
        if image_path.is_file():
            image_path.unlink()
    except OSError:
        logger.exception(
            "Failed to clean up temporary image."
        )


def remove_uploaded_image(image_url):
    """Delete only UUID-named images in the report upload directory."""

    if not isinstance(image_url, str):
        return

    prefix = "/uploads/reports/"

    if not image_url.startswith(prefix):
        return

    filename = image_url[len(prefix):]

    if "/" in filename or "\\" in filename:
        return

    if not filename:
        return

    path = Path(filename)

    # Only images created using this module's UUID naming format
    # may be removed automatically.
    if path.suffix.lower() not in {
        ".jpg",
        ".png",
        ".webp",
    }:
        return

    try:
        from uuid import UUID

        if UUID(hex=path.stem).hex != path.stem:
            return
    except (ValueError, AttributeError):
        return

    cleanup_saved_image(
        UPLOAD_DIR / filename
    )


def process_uploaded_image(
    contents: bytes,
    content_type: str,
) -> tuple[bytes, str]:
    """
    Validate, fully decode, and re-encode an uploaded image.

    Re-encoding avoids saving the original file bytes and strips
    EXIF/GPS metadata and other unnecessary embedded metadata.

    Returns:
        (encoded_image_bytes, file_extension)
    """

    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                "Only JPG, PNG, and WEBP "
                "images are allowed."
            ),
        )

    if not contents:
        raise HTTPException(
            status_code=400,
            detail="The selected image is empty.",
        )

    if len(contents) > MAX_IMAGE_SIZE:
        raise HTTPException(
            status_code=400,
            detail="Image must not exceed 5 MB.",
        )

    expected_format, extension = (
        ALLOWED_IMAGE_TYPES[content_type]
    )

    try:
        source = BytesIO(contents)

        with Image.open(source) as image:
            if image.format != expected_format:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "The file content does not match "
                        "the selected image type."
                    ),
                )

            width, height = image.size

            if width < 1 or height < 1:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid image dimensions.",
                )

            if (
                width > MAX_IMAGE_DIMENSION
                or height > MAX_IMAGE_DIMENSION
                or width * height > MAX_IMAGE_PIXELS
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Image dimensions exceed "
                        "the allowed limit."
                    ),
                )

            # Decode pixels completely instead of trusting
            # the file header alone.
            image.load()

            # Apply orientation before removing EXIF metadata.
            oriented = ImageOps.exif_transpose(image)

            # Build a fresh image from pixel data only.
            # This avoids copying the original metadata.
            if expected_format == "JPEG":
                clean = Image.new(
                    "RGB",
                    oriented.size,
                )

                clean.paste(
                    oriented.convert("RGB")
                )

            else:
                has_alpha = (
                    "A" in oriented.getbands()
                    or "transparency" in oriented.info
                )

                target_mode = (
                    "RGBA" if has_alpha else "RGB"
                )

                converted = oriented.convert(
                    target_mode
                )

                clean = Image.new(
                    target_mode,
                    converted.size,
                )

                clean.paste(converted)

            output = BytesIO()

            save_options = {}

            if expected_format == "JPEG":
                save_options = {
                    "format": "JPEG",
                    "quality": 85,
                    "optimize": True,
                }

            elif expected_format == "PNG":
                save_options = {
                    "format": "PNG",
                    "optimize": True,
                }

            elif expected_format == "WEBP":
                save_options = {
                    "format": "WEBP",
                    "quality": 85,
                    "method": 4,
                }

            clean.save(
                output,
                **save_options,
            )

            clean.close()

            encoded = output.getvalue()

            output.close()

        if not encoded:
            raise HTTPException(
                status_code=400,
                detail="Unable to process the image.",
            )

        if len(encoded) > MAX_IMAGE_SIZE:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Processed image exceeds 5 MB. "
                    "Please select a smaller image."
                ),
            )

        return encoded, extension

    except HTTPException:
        raise

    except (
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        OSError,
        ValueError,
        SyntaxError,
        EOFError,
    ) as exc:
        logger.warning(
            "Rejected invalid image: %s",
            type(exc).__name__,
        )

        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid or corrupted image. "
                "Please select a valid JPG, PNG, or WEBP."
            ),
        ) from exc


# ============================================================
# CREATE REPORT
# ============================================================

@router.post("", status_code=201)
def create_report(
    data: ReportCreate,
    user: dict = Depends(get_current_user),
):
    validate_incident_location(data)
    connection = None
    cursor = None

    try:
        connection = get_db_connection()

        cursor = connection.cursor(
            dictionary=True
        )

        cursor.execute(
            """
            INSERT INTO reports (
                user_id,
                report_type,
                item_name,
                description,
                category,
                barangay,
                specific_location,
                date_lost_found,
                time_lost_found,
                latitude,
                longitude
            )
            VALUES (
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s
            )
            """,
            (
                user["id"],
                data.report_type,
                data.item_name.strip(),
                data.description.strip(),
                data.category.strip(),
                data.barangay,
                (
                    data.specific_location.strip()
                    if data.specific_location
                    else None
                ),
                data.date_lost_found,
                data.time_lost_found,
                data.latitude,
                data.longitude,
            ),
        )

        report_id = cursor.lastrowid

        connection.commit()

        cursor.execute(
            """
            SELECT *
            FROM reports
            WHERE id = %s
              AND user_id = %s
            """,
            (
                report_id,
                user["id"],
            ),
        )

        row = cursor.fetchone()

        return {
            "message": (
                "Report created successfully!"
            ),
            "report": report_response(row),
        }

    except HTTPException:
        rollback_db(connection)
        raise

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Failed to create report."
        )

        raise HTTPException(
            status_code=500,
            detail="Could not create report.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# LIST PUBLIC REPORTS
# ============================================================

@router.get("")
def list_reports(
    report_type: Literal[
        "lost", "found"
    ] | None = None,

    barangay: str | None = None,

    category: str | None = None,

    search: str | None = Query(
        default=None,
        max_length=150,
    ),

    limit: int = Query(
        default=20,
        ge=1,
        le=100,
    ),

    offset: int = Query(
        default=0,
        ge=0,
    ),
):
    if (
        barangay is not None
        and barangay not in BARANGAYS
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid barangay.",
        )

    connection = None
    cursor = None

    try:
        connection = get_db_connection()

        cursor = connection.cursor(
            dictionary=True
        )

        sql = """
            SELECT
                id,
                user_id,
                report_type,
                item_name,
                description,
                category,
                barangay,
                specific_location,
                date_lost_found,
                time_lost_found,
                latitude,
                longitude,
                image_url,
                status,
                created_at,
                updated_at
            FROM reports
            WHERE status = 'active'
        """

        params = []

        if report_type:
            sql += " AND report_type = %s"
            params.append(report_type)

        if barangay:
            sql += " AND barangay = %s"
            params.append(barangay)

        if category:
            sql += " AND category = %s"
            params.append(category)

        if search and search.strip():
            sql += """
                AND (
                    item_name LIKE %s
                    OR description LIKE %s
                    OR category LIKE %s
                    OR specific_location LIKE %s
                    OR barangay LIKE %s
                )
            """

            term = (
                f"%{search.strip()}%"
            )

            params.extend(
                [term] * 5
            )

        sql += """
            ORDER BY
                created_at DESC,
                id DESC
            LIMIT %s OFFSET %s
        """

        params.extend(
            [limit, offset]
        )

        cursor.execute(
            sql,
            tuple(params),
        )

        rows = cursor.fetchall()

        return {
            "reports": [
                report_response(row)
                for row in rows
            ],
            "limit": limit,
            "offset": offset,
        }

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "Failed to list reports."
        )

        raise HTTPException(
            status_code=500,
            detail="Could not retrieve reports.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# MY REPORTS
# ============================================================

@router.get("/my")
def get_my_reports(
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
                user_id,
                report_type,
                item_name,
                description,
                category,
                barangay,
                specific_location,
                date_lost_found,
                time_lost_found,
                latitude,
                longitude,
                image_url,
                status,
                created_at,
                updated_at
            FROM reports
            WHERE user_id = %s
            ORDER BY
                created_at DESC,
                id DESC
            """,
            (user["id"],),
        )

        rows = cursor.fetchall()

        return {
            "reports": [
                report_response(row)
                for row in rows
            ],
        }

    except Exception as exc:
        logger.exception(
            "Failed to retrieve user reports."
        )

        raise HTTPException(
            status_code=500,
            detail="Could not retrieve your reports.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# GET REPORT DETAILS
# ============================================================

@router.get("/{report_id}")
def get_report(report_id: int):
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
                user_id,
                report_type,
                item_name,
                description,
                category,
                barangay,
                specific_location,
                date_lost_found,
                time_lost_found,
                latitude,
                longitude,
                image_url,
                status,
                created_at,
                updated_at
            FROM reports
            WHERE id = %s
            """,
            (report_id,),
        )

        row = cursor.fetchone()

        if not row:
            raise HTTPException(
                status_code=404,
                detail="Report not found.",
            )

        return {
            "report": report_response(row)
        }

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "Failed to retrieve report details."
        )

        raise HTTPException(
            status_code=500,
            detail="Could not retrieve report.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# UPDATE REPORT
# ============================================================

@router.put("/{report_id}")
def update_report(
    report_id: int,
    data: ReportCreate,
    user: dict = Depends(get_current_user),
):
    validate_incident_location(data)
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
                status
            FROM reports
            WHERE id = %s
              AND user_id = %s
            FOR UPDATE
            """,
            (
                report_id,
                user["id"],
            ),
        )

        report = cursor.fetchone()

        if not report:
            raise HTTPException(
                status_code=404,
                detail=(
                    "Report not found or you do not "
                    "have permission to update it."
                ),
            )

        if report["status"] != "active":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Only active reports can be edited."
                ),
            )

        cursor.execute(
            """
            UPDATE reports
            SET
                report_type = %s,
                item_name = %s,
                description = %s,
                category = %s,
                barangay = %s,
                specific_location = %s,
                date_lost_found = %s,
                time_lost_found = %s,
                latitude = %s,
                longitude = %s
            WHERE id = %s
              AND user_id = %s
              AND status = 'active'
            """,
            (
                data.report_type,
                data.item_name.strip(),
                data.description.strip(),
                data.category.strip(),
                data.barangay,
                (
                    data.specific_location.strip()
                    if data.specific_location
                    else None
                ),
                data.date_lost_found,
                data.time_lost_found,
                data.latitude,
                data.longitude,
                report_id,
                user["id"],
            ),
        )

        connection.commit()

        cursor.execute(
            """
            SELECT *
            FROM reports
            WHERE id = %s
              AND user_id = %s
            """,
            (
                report_id,
                user["id"],
            ),
        )

        row = cursor.fetchone()

        return {
            "message": (
                "Report updated successfully!"
            ),
            "report": report_response(row),
        }

    except HTTPException:
        rollback_db(connection)
        raise

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Failed to update report."
        )

        raise HTTPException(
            status_code=500,
            detail="Could not update report.",
        ) from exc

    finally:
        close_db(cursor, connection)


# ============================================================
# UPLOAD REPORT PHOTO
# ============================================================

@router.post("/{report_id}/photo")
async def upload_report_photo(
    report_id: int,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    connection = None
    cursor = None

    saved_path = None
    database_updated = False
    previous_image_url = None

    try:
        # Check the declared content type first.
        if file.content_type not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Only JPG, PNG, and WEBP "
                    "images are allowed."
                ),
            )

        # Read only enough data to detect an oversized upload.
        contents = await file.read(
            MAX_IMAGE_SIZE + 1
        )

        if not contents:
            raise HTTPException(
                status_code=400,
                detail="The selected image is empty.",
            )

        if len(contents) > MAX_IMAGE_SIZE:
            raise HTTPException(
                status_code=400,
                detail="Image must not exceed 5 MB.",
            )

        # Validate the actual image and generate sanitized bytes.
        processed_bytes, extension = (
            process_uploaded_image(
                contents,
                file.content_type,
            )
        )

        # Verify report ownership.
        connection = get_db_connection()

        cursor = connection.cursor(
            dictionary=True
        )

        cursor.execute(
            """
            SELECT
                id,
                image_url,
                status
            FROM reports
            WHERE id = %s
              AND user_id = %s
            FOR UPDATE
            """,
            (
                report_id,
                user["id"],
            ),
        )

        report = cursor.fetchone()

        if not report:
            raise HTTPException(
                status_code=404,
                detail=(
                    "Report not found or you do not "
                    "have permission to upload a photo."
                ),
            )

        if report["status"] != "active":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Photos can only be changed "
                    "for active reports."
                ),
            )

        previous_image_url = report.get(
            "image_url"
        )

        filename = (
            f"{uuid4().hex}{extension}"
        )

        saved_path = (
            UPLOAD_DIR / filename
        )

        image_url = (
            f"/uploads/reports/{filename}"
        )

        # Exclusive creation prevents overwriting existing files.
        with saved_path.open("xb") as image_file:
            image_file.write(processed_bytes)
            image_file.flush()

        cursor.execute(
            """
            UPDATE reports
            SET image_url = %s
            WHERE id = %s
              AND user_id = %s
              AND status = 'active'
            """,
            (
                image_url,
                report_id,
                user["id"],
            ),
        )

        if cursor.rowcount != 1:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The report could not be updated."
                ),
            )

        connection.commit()
        database_updated = True

        # Delete the old image only after successful commit.
        if previous_image_url:
            remove_uploaded_image(
                previous_image_url
            )

        return {
            "message": (
                "Photo uploaded successfully!"
            ),
            "image_url": image_url,
        }

    except HTTPException:
        if not database_updated:
            rollback_db(connection)
            cleanup_saved_image(saved_path)
        raise

    except Exception as exc:
        if not database_updated:
            rollback_db(connection)
            cleanup_saved_image(saved_path)

        logger.exception(
            "Failed to upload report photo."
        )

        raise HTTPException(
            status_code=500,
            detail="Could not upload photo.",
        ) from exc

    finally:
        try:
            await file.close()
        except Exception:
            logger.exception(
                "Failed to close uploaded file."
            )

        close_db(cursor, connection)


# ============================================================
# DELETE REPORT
# ============================================================

@router.delete("/{report_id}")
def delete_report(
    report_id: int,
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
                image_url,
                status
            FROM reports
            WHERE id = %s
              AND user_id = %s
            FOR UPDATE
            """,
            (
                report_id,
                user["id"],
            ),
        )

        report = cursor.fetchone()

        if not report:
            raise HTTPException(
                status_code=404,
                detail=(
                    "Report not found or you do not "
                    "have permission to delete it."
                ),
            )

        if report["status"] != "active":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Only active reports can be deleted."
                ),
            )

        # Preserve reports with associated claim history.
        cursor.execute(
            """
            SELECT
                COUNT(*) AS claim_count
            FROM claim_requests
            WHERE report_id = %s
            """,
            (report_id,),
        )

        claim_result = cursor.fetchone()

        if claim_result["claim_count"] > 0:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This report has claim requests and "
                    "cannot be deleted. Its claim history "
                    "must be preserved."
                ),
            )

        cursor.execute(
            """
            DELETE FROM reports
            WHERE id = %s
              AND user_id = %s
              AND status = 'active'
            """,
            (
                report_id,
                user["id"],
            ),
        )

        if cursor.rowcount != 1:
            raise HTTPException(
                status_code=409,
                detail="Report could not be deleted.",
            )

        connection.commit()

        remove_uploaded_image(
            report.get("image_url")
        )

        return {
            "message": (
                "Report deleted successfully!"
            ),
            "deleted_report_id": report_id,
        }

    except HTTPException:
        rollback_db(connection)
        raise

    except Exception as exc:
        rollback_db(connection)

        logger.exception(
            "Failed to delete report."
        )

        raise HTTPException(
            status_code=500,
            detail="Could not delete report.",
        ) from exc

    finally:
        close_db(cursor, connection)