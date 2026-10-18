#!/usr/bin/env python3
"""
Unit tests for NVIDIA CUDA GPU detection in env_config.py.

Tests nvidia-smi detection (PATH and Windows well-known paths),
WMI fallback, and edge cases — all mocked, no NVIDIA hardware required.

Run:  python -m pytest skills/lib/test_env_config_cuda.py -v
"""

import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

# Ensure env_config is importable from skills/lib/
sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_config import HardwareEnv, _log  # noqa: E402


# ── Sample nvidia-smi output ─────────────────────────────────────────────

NVIDIA_SMI_RTX4070 = "NVIDIA GeForce RTX 4070, 8188, 581.83\n"
NVIDIA_SMI_RTX4090 = "NVIDIA GeForce RTX 4090, 24564, 575.51\n"
NVIDIA_SMI_MULTI_GPU = (
    "NVIDIA GeForce RTX 4090, 24564, 575.51\n"
    "NVIDIA GeForce RTX 4070, 8188, 581.83\n"
)

# ── Sample WMI/WMIC output ───────────────────────────────────────────────

WMI_NVIDIA_OUTPUT = (
    "Node,AdapterRAM,DriverVersion,Name\r\n"
    "DESKTOP-ABC,8589934592,31.0.15.8183,NVIDIA GeForce RTX 4070\r\n"
)

WMI_NVIDIA_AND_INTEL = (
    "Node,AdapterRAM,DriverVersion,Name\r\n"
    "DESKTOP-ABC,1073741824,31.0.101.4502,Intel(R) UHD Graphics 770\r\n"
    "DESKTOP-ABC,8589934592,31.0.15.8183,NVIDIA GeForce RTX 4070\r\n"
)

WMI_INTEL_ONLY = (
    "Node,AdapterRAM,DriverVersion,Name\r\n"
    "DESKTOP-ABC,1073741824,31.0.101.4502,Intel(R) UHD Graphics 770\r\n"
)


# ── Helpers ────────────────────────────────────────────────────────────────

def _make_run_result(stdout="", returncode=0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr="")


def _mock_which(available_tools):
    """Return a shutil.which mock that only finds tools in available_tools."""
    def _which(name):
        return f"/usr/bin/{name}" if name in available_tools else None
    return _which


# ── Tests: _try_cuda via nvidia-smi ──────────────────────────────────────

class TestTryCudaNvidiaSmi:
    """nvidia-smi primary detection strategy."""

    @mock.patch("env_config.platform.system", return_value="Linux")
    @mock.patch("env_config.shutil.which", return_value="/usr/bin/nvidia-smi")
    @mock.patch("env_config.subprocess.run")
    def test_nvidia_smi_on_path_linux(self, mock_run, _which, _system):
        """nvidia-smi found on PATH → detects GPU correctly."""
        mock_run.return_value = _make_run_result(NVIDIA_SMI_RTX4070)

        env = HardwareEnv()
        result = env._try_cuda()

        assert result is True
        assert env.backend == "cuda"
        assert env.device == "cuda"
        assert env.gpu_name == "NVIDIA GeForce RTX 4070"
        assert env.gpu_memory_mb == 8188
        assert env.driver_version == "581.83"
        assert "nvidia_smi" in env.detection_details

    @mock.patch("env_config.platform.system", return_value="Windows")
    @mock.patch("env_config.shutil.which", return_value="C:\\Windows\\System32\\nvidia-smi.exe")
    @mock.patch("env_config.subprocess.run")
    def test_nvidia_smi_on_path_windows(self, mock_run, _which, _system):
        """nvidia-smi found on PATH (Windows) → detects GPU correctly."""
        mock_run.return_value = _make_run_result(NVIDIA_SMI_RTX4070)

        env = HardwareEnv()
        result = env._try_cuda()

        assert result is True
        assert env.backend == "cuda"
        assert env.gpu_name == "NVIDIA GeForce RTX 4070"
        assert env.gpu_memory_mb == 8188

    @mock.patch("env_config.platform.system", return_value="Linux")
    @mock.patch("env_config.shutil.which", return_value="/usr/bin/nvidia-smi")
    @mock.patch("env_config.subprocess.run")
    def test_multi_gpu_picks_first(self, mock_run, _which, _system):
        """Multi-GPU: picks the first GPU from nvidia-smi output."""
        mock_run.return_value = _make_run_result(NVIDIA_SMI_MULTI_GPU)

        env = HardwareEnv()
        env._try_cuda()

        assert env.gpu_name == "NVIDIA GeForce RTX 4090"
        assert env.gpu_memory_mb == 24564

    @mock.patch("env_config.platform.system", return_value="Linux")
    @mock.patch("env_config.shutil.which", return_value="/usr/bin/nvidia-smi")
    @mock.patch("env_config.subprocess.run")
    def test_nvidia_smi_error_returns_false(self, mock_run, _which, _system):
        """nvidia-smi returns non-zero → returns False."""
        mock_run.return_value = _make_run_result("", returncode=1)

        env = HardwareEnv()
        result = env._try_cuda()

        assert result is False
        assert env.backend == "cpu"

    @mock.patch("env_config.platform.system", return_value="Linux")
    @mock.patch("env_config.shutil.which", return_value="/usr/bin/nvidia-smi")
    @mock.patch("env_config.subprocess.run")
    def test_nvidia_smi_timeout(self, mock_run, _which, _system):
        """nvidia-smi times out → returns False (no crash)."""
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=10)

        env = HardwareEnv()
        result = env._try_cuda()

        assert result is False

    @mock.patch("env_config.platform.system", return_value="Linux")
    @mock.patch("env_config.shutil.which", return_value=None)
    def test_no_nvidia_smi_no_windows(self, _which, _system):
        """No nvidia-smi, not Windows → returns False immediately."""
        env = HardwareEnv()
        result = env._try_cuda()

        assert result is False
        assert env.backend == "cpu"


# ── Tests: Windows well-known path search ────────────────────────────────

class TestTryCudaWindowsPaths:
    """Windows: nvidia-smi not on PATH but found at well-known location."""

    @mock.patch("env_config.platform.system", return_value="Windows")
    @mock.patch("env_config.shutil.which", return_value=None)
    @mock.patch("env_config.subprocess.run")
    @mock.patch("env_config.Path.is_file")
    def test_found_in_nvsmi_dir(self, mock_is_file, mock_run, _which, _system):
        """nvidia-smi found at Program Files\\NVIDIA Corporation\\NVSMI."""
        # First candidate matches
        mock_is_file.return_value = True
        mock_run.return_value = _make_run_result(NVIDIA_SMI_RTX4070)

        env = HardwareEnv()
        result = env._try_cuda()

        assert result is True
        assert env.backend == "cuda"
        assert env.gpu_name == "NVIDIA GeForce RTX 4070"

    @mock.patch("env_config.platform.system", return_value="Windows")
    @mock.patch("env_config.shutil.which", return_value=None)
    @mock.patch("env_config.subprocess.run")
    @mock.patch("env_config.Path.is_file")
    def test_not_found_falls_to_wmi(self, mock_is_file, mock_run, _which, _system):
        """nvidia-smi not found at any well-known path → tries WMI."""
        mock_is_file.return_value = False
        mock_run.return_value = _make_run_result(WMI_NVIDIA_OUTPUT)

        env = HardwareEnv()
        result = env._try_cuda()

        assert result is True
        assert env.backend == "cuda"
        assert "wmi" in env.detection_details


# ── Tests: _try_cuda_wmi ─────────────────────────────────────────────────

class TestTryCudaWmi:
    """Windows WMI fallback detection."""

    @mock.patch("env_config.subprocess.run")
    def test_wmi_detects_nvidia(self, mock_run):
        """WMI finds NVIDIA GPU → backend=cuda."""
        mock_run.return_value = _make_run_result(WMI_NVIDIA_OUTPUT)

        env = HardwareEnv()
        result = env._try_cuda_wmi()

        assert result is True
        assert env.backend == "cuda"
        assert env.device == "cuda"
        assert env.gpu_name == "NVIDIA GeForce RTX 4070"
        # 8589934592 / (1024*1024) = 8192
        assert env.gpu_memory_mb == 8192
        assert env.driver_version == "31.0.15.8183"
        assert "wmi" in env.detection_details

    @mock.patch("env_config.subprocess.run")
    def test_wmi_nvidia_with_intel_igpu(self, mock_run):
        """WMI returns Intel iGPU + NVIDIA GPU → picks NVIDIA."""
        mock_run.return_value = _make_run_result(WMI_NVIDIA_AND_INTEL)

        env = HardwareEnv()
        result = env._try_cuda_wmi()

        assert result is True
        assert env.gpu_name == "NVIDIA GeForce RTX 4070"

    @mock.patch("env_config.subprocess.run")
    def test_wmi_intel_only_returns_false(self, mock_run):
        """WMI returns only Intel → returns False."""
        mock_run.return_value = _make_run_result(WMI_INTEL_ONLY)

        env = HardwareEnv()
        result = env._try_cuda_wmi()

        assert result is False
        assert env.backend == "cpu"

    @mock.patch("env_config.subprocess.run")
    def test_wmi_error_returns_false(self, mock_run):
        """wmic returns non-zero → returns False."""
        mock_run.return_value = _make_run_result("", returncode=1)

        env = HardwareEnv()
        result = env._try_cuda_wmi()

        assert result is False

    @mock.patch("env_config.subprocess.run")
    def test_wmi_not_found(self, mock_run):
        """wmic not found → returns False (no crash)."""
        mock_run.side_effect = FileNotFoundError("wmic not found")

        env = HardwareEnv()
        result = env._try_cuda_wmi()

        assert result is False

    @mock.patch("env_config.subprocess.run")
    def test_wmi_timeout(self, mock_run):
        """wmic times out → returns False (no crash)."""
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="wmic", timeout=10)

        env = HardwareEnv()
        result = env._try_cuda_wmi()

        assert result is False


# ── Tests: Full detect() integration ──────────────────────────────────────

class TestDetectCudaIntegration:
    """End-to-end HardwareEnv.detect() with NVIDIA GPU."""

    @mock.patch("env_config.platform.system", return_value="Windows")
    @mock.patch("env_config.shutil.which", return_value="C:\\Windows\\System32\\nvidia-smi.exe")
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_detect_sets_cuda_backend_and_format(
        self, mock_run, _dir, _which, _system
    ):
        """Full detect() → cuda backend with engine export format."""
        mock_run.return_value = _make_run_result(NVIDIA_SMI_RTX4070)

        env = HardwareEnv.detect()

        assert env.backend == "cuda"
        assert env.device == "cuda"
        assert env.export_format == "engine"
        assert env.gpu_name == "NVIDIA GeForce RTX 4070"

    @mock.patch("env_config.platform.system", return_value="Windows")
    @mock.patch("env_config.shutil.which", return_value=None)
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.Path.is_file", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_detect_wmi_fallback_on_windows(
        self, mock_run, _is_file, _dir, _which, _system
    ):
        """No nvidia-smi → WMI fallback detects GPU on Windows."""
        mock_run.return_value = _make_run_result(WMI_NVIDIA_OUTPUT)

        env = HardwareEnv.detect()

        assert env.backend == "cuda"
        assert env.gpu_name == "NVIDIA GeForce RTX 4070"
