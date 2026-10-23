
import logging
import time
from contextlib import contextmanager

logger = logging.getLogger("aura.performance")


@contextmanager
def measure_latency(operation: str):
    """Log the execution time of a backend operation in milliseconds."""
    start = time.perf_counter()
    status = "success"

    try:
        yield
    except Exception:
        status = "error"
        raise
    finally:
        duration_ms = (time.perf_counter() - start) * 1000
        logger.info(
            "latency operation=%s duration_ms=%.2f status=%s",
            operation,
            duration_ms,
            status,
        )
