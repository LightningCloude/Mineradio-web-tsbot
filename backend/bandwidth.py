from __future__ import annotations

import time
from collections.abc import Callable, Iterable


def copy_chunks_with_rate_limit(
    chunks: Iterable[bytes],
    write: Callable[[bytes], object],
    bytes_per_second: int,
    *,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], object] = time.sleep,
) -> int:
    """Write a stream with an average byte-rate ceiling and no busy waiting."""
    rate = max(1, int(bytes_per_second))
    started_at = clock()
    transferred = 0
    for chunk in chunks:
        if not chunk:
            continue
        write(chunk)
        transferred += len(chunk)
        wait_for = transferred / rate - (clock() - started_at)
        if wait_for > 0:
            sleep(wait_for)
    return transferred
