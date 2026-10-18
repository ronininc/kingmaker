#!/usr/bin/env python3
"""
Coral TPU Device Probe — tests Edge TPU delegate availability.

Uses ai-edge-litert (LiteRT) to check if libedgetpu is installed and
an Edge TPU device is accessible. Outputs JSON to stdout for Aegis
skill deployment verification.

Usage:
  python scripts/tpu_probe.py
"""

import json
import sys
from pathlib import Path

# ─── Windows DLL search path fix (MUST happen before any native import) ───────
# Python 3.8+ no longer searches PATH for DLLs loaded by native C extensions.
_LIB_DIR = Path(__file__).parent.parent / "lib"
if sys.platform == "win32" and _LIB_DIR.exists():
    import os
    os.add_dll_directory(str(_LIB_DIR))

def _edgetpu_lib_name():
    """Return the platform-specific libedgetpu shared library name."""
    import platform
    from pathlib import Path
    system = platform.system()
    if system == "Linux":
        return "libedgetpu.so.1"
    elif system == "Darwin":
        return "libedgetpu.1.dylib"
    elif system == "Windows":
        local_dll = _LIB_DIR / "edgetpu.dll"
        if local_dll.exists():
            return str(local_dll.resolve())
        return "edgetpu.dll"
    return "libedgetpu.so.1"


def probe_tpus():
    """Test Edge TPU delegate loading and return probe info dict."""
    result = {
        "event": "tpu_probe",
        "available": False,
        "count": 0,
        "devices": [],
        "runtime": None,
        "error": None,
    }

    # Check ai-edge-litert availability
    try:
        from ai_edge_litert import interpreter as litert
        result["runtime"] = "ai-edge-litert"
    except ImportError:
        result["runtime"] = None
        result["error"] = "ai-edge-litert not installed. Run: pip install ai-edge-litert"
        return result

    # Try loading Edge TPU delegate
    edgetpu_lib = _edgetpu_lib_name()
    try:
        delegate = litert.load_delegate(edgetpu_lib)
        result["available"] = True
        result["count"] = 1
        result["devices"].append({
            "index": 0,
            "type": "usb",
            "delegate": edgetpu_lib,
        })
    except (ValueError, OSError) as e:
        error_str = str(e)
        if "libedgetpu" in error_str.lower() or "not found" in error_str.lower():
            result["error"] = f"libedgetpu not installed: {error_str}"
        else:
            result["error"] = f"Edge TPU not accessible: {error_str}"

    # Check USB devices for additional context (Linux only)
    try:
        import subprocess
        lsusb = subprocess.run(
            ["lsusb"], capture_output=True, text=True, timeout=5
        )
        coral_lines = [
            line.strip() for line in lsusb.stdout.splitlines()
            if "1a6e" in line.lower() or "18d1" in line.lower()  # Global Unichip / Google
            or "coral" in line.lower() or "edge tpu" in line.lower()
        ]
        if coral_lines:
            result["usb_devices"] = coral_lines
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass  # lsusb not available (macOS, Windows)

    return result


def main():
    result = probe_tpus()
    print(json.dumps(result, indent=2))

    # Human-readable summary to stderr
    if result["available"]:
        sys.stderr.write(f"✓ Found {result['count']} Edge TPU device(s)\n")
        for dev in result["devices"]:
            sys.stderr.write(f"  [{dev['index']}] {dev['type']} via {dev.get('delegate', '?')}\n")
    else:
        sys.stderr.write("✗ No Edge TPU detected\n")
        if result["error"]:
            sys.stderr.write(f"  Error: {result['error']}\n")

    # Exit code: 0 if TPU found, 1 if not
    sys.exit(0 if result["available"] else 1)


if __name__ == "__main__":
    main()
