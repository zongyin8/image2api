from __future__ import annotations

import os
import shutil
import time
from pathlib import Path


DATA_DIR = Path(os.getenv("PROVISION_DATA_DIR", "/var/lib/image2api-provisioner"))


def snapshot_file(path: Path, prefix: str = "snapshot") -> None:
    if not path.is_file():
        return
    target_dir = DATA_DIR / "snapshots"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{prefix}.{int(time.time())}.json"
    shutil.copy2(path, target)
    snapshots = sorted(target_dir.glob(f"{prefix}.*.json"), key=lambda item: item.stat().st_mtime)
    for stale in snapshots[:-20]:
        stale.unlink(missing_ok=True)
