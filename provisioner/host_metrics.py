from __future__ import annotations

import shutil
import time


def _cpu_sample() -> tuple[int, int]:
    fields = [int(value) for value in open("/proc/stat", encoding="ascii").readline().split()[1:]]
    total = sum(fields)
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    return total, idle


def _cpu_percent() -> float:
    total1, idle1 = _cpu_sample()
    time.sleep(0.15)
    total2, idle2 = _cpu_sample()
    elapsed = total2 - total1
    return round(100 * (elapsed - (idle2 - idle1)) / elapsed, 1) if elapsed > 0 else 0.0


def _memory() -> tuple[int, int, int]:
    values: dict[str, int] = {}
    with open("/proc/meminfo", encoding="ascii") as handle:
        for line in handle:
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0]) * 1024
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", values.get("MemFree", 0))
    return total, max(0, total - available), available


def collect() -> dict:
    memory_total, memory_used, memory_available = _memory()
    disk = shutil.disk_usage("/")
    with open("/proc/uptime", encoding="ascii") as handle:
        uptime = int(float(handle.read().split()[0]))
    return {
        "system": {
            "cpu_percent": _cpu_percent(),
            "memory_total": memory_total,
            "memory_used": memory_used,
            "memory_available": memory_available,
        },
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "uptime_seconds": uptime,
        "generated_at": int(time.time()),
    }
