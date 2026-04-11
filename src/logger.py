import logging
import os
from dotenv import load_dotenv

load_dotenv()


def setup_logger()  -> logging.Logger:
    """Setup ClassRec logger - controlled by DEBUG env variable"""

    log_level = logging.DEBUG if os.getenv("DEBUG") == "true" else logging.WARNING

    logging.basicConfig(
        level=log_level,
        format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
        datefmt= '%H:%M:%S'
    )
    # silence noisy third party libraries
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)
    logging.getLogger("faster_whisper").setLevel(logging.WARNING)
    return logging.getLogger('ClassRec')

logger = setup_logger()



