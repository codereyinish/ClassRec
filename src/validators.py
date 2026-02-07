# validators.py
"""
File validation dependencies for FastAPI
"""
from fastapi import UploadFile, HTTPException, File
import magic
from typing import Tuple

# Constants right here!
ALLOWED_FORMATS = {
    "audio/mpeg": "MP3",
    "audio/wav": "WAV",
    "audio/x-wav": "WAV",
    "audio/mp4": "M4A",
    "audio/x-m4a": "M4A",
    "audio/flac": "FLAC",
    "audio/webm": "WebM",
    "audio/ogg": "OGG"
}

MAX_FILE_SIZE_MB = 25


def get_supported_formats() -> str:
    return ", ".join(sorted(set(ALLOWED_FORMATS.values())))

async def validate_audio_file(
        file: UploadFile = File(...)
) -> Tuple[bytes, str, float]:
    """
    FastAPI Dependency: Validate uploaded audio file.

    This runs automatically before the endpoint when used with Depends().

    Args:
        file: Uploaded file from request

    Returns:
        tuple: (file_contents, mime_type, file_size_mb)

    Raises:
        HTTPException: If file is invalid
    """
    # Read file contents
    contents = await file.read()

    # Detect actual file type
    try:
        mime = magic.from_buffer(contents, mime=True)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not detect file type: {str(e)}"
        )
    #Get correct extension from MIME type
    correct_ext = ALLOWED_FORMATS[mime]

    # Check if it's audio at all
    if not mime.startswith("audio/"):
        supported = get_supported_formats()

        if mime.startswith("video/"):
            raise HTTPException(
                status_code=400,
                detail=f"Video file detected! '{file.filename}' is a video ({mime}). "
                       f"Please upload audio only. Supported: {supported}"
            )
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid file type! '{file.filename}' is {mime}. "
                       f"Expected audio file. Supported: {supported}"
            )

    # Check if supported audio format
    if mime not in ALLOWED_FORMATS:
        supported = get_supported_formats()
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio format! '{file.filename}' is {mime}. "
                   f"Supported formats: {supported}"
        )

    # Check file size
    file_size_mb = len(contents) / (1024 * 1024)
    if file_size_mb > MAX_FILE_SIZE_MB:
        raise HTTPException(
            status_code=400,
            detail=f"File too large: {file_size_mb:.1f}MB. Maximum is {MAX_FILE_SIZE_MB}MB"
        )

    # Return validated data
    return contents, mime, file_size_mb, correct_ext