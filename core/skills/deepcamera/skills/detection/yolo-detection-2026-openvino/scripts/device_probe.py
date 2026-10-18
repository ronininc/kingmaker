#!/usr/bin/env python3
"""
OpenVINO Device Probe — enumerates available inference devices.

Outputs JSON to stdout for Aegis skill deployment verification.

Usage:
  python scripts/device_probe.py
  docker run --device /dev/dri --device /dev/bus/usb aegis-openvino-detect python3 scripts/device_probe.py
"""

import json
import sys


def probe_devices():
    """Enumerate OpenVINO devices and return info dict."""
    result = {
        "event": "device_probe",
        "available": False,
        "devices": [],
        "accelerator_found": False,
        "runtime": None,
        "error": None,
    }

    try:
        from openvino.runtime import Core
        core = Core()
        result["runtime"] = "openvino"

        devices = core.available_devices
        result["available"] = len(devices) > 0
        result["accelerator_found"] = any(d in devices for d in ["GPU", "MYRIAD"])

        for dev in devices:
            device_info = {
                "name": dev,
                "full_name": core.get_property(dev, "FULL_DEVICE_NAME"),
            }
            try:
                device_info["supported_properties"] = list(core.get_property(dev, "SUPPORTED_PROPERTIES"))
            except Exception:
                pass
            result["devices"].append(device_info)

    except ImportError:
        result["error"] = "openvino-runtime not installed"
    except Exception as e:
        result["error"] = f"Failed to probe devices: {str(e)}"

    # Check USB for NCS2
    try:
        import subprocess
        lsusb = subprocess.run(
            ["lsusb"], capture_output=True, text=True, timeout=5
        )
        ncs_lines = [
            line.strip() for line in lsusb.stdout.splitlines()
            if "03e7" in line.lower()  # Intel Movidius VID
            or "myriad" in line.lower()
            or "neural compute" in line.lower()
        ]
        if ncs_lines:
            result["usb_devices"] = ncs_lines
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return result


def main():
    result = probe_devices()
    print(json.dumps(result, indent=2))

    # Human-readable summary to stderr
    if result["available"]:
        sys.stderr.write(f"✓ OpenVINO devices found:\n")
        for dev in result["devices"]:
            sys.stderr.write(f"  [{dev['name']}] {dev.get('full_name', '')}\n")
        if result["accelerator_found"]:
            sys.stderr.write("✓ Hardware accelerator detected (GPU/NCS2)\n")
        else:
            sys.stderr.write("ℹ CPU-only mode (no GPU/NCS2 detected)\n")
    else:
        sys.stderr.write("✗ No OpenVINO devices found\n")
        if result["error"]:
            sys.stderr.write(f"  Error: {result['error']}\n")

    sys.exit(0 if result["available"] else 1)


if __name__ == "__main__":
    main()
