#!/usr/bin/env python3
"""
Unit tests for ROCm GPU detection in env_config.py.

Tests amd-smi parsing, rocm-smi fallback, provider verification,
and multi-GPU selection — all mocked, no ROCm hardware required.

Run:  python -m pytest skills/lib/test_env_config_rocm.py -v
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

# Ensure env_config is importable from skills/lib/
sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_config import HardwareEnv, _log  # noqa: E402


# ── Sample amd-smi JSON (dual-GPU: discrete R9700 + iGPU) ─────────────────

AMD_SMI_DUAL_GPU = json.dumps([
    {
        "asic": {
            "market_name": "AMD Radeon AI PRO R9700",
            "vendor_id": "0x1002",
            "target_graphics_version": "gfx1201",
        },
        "vram": {
            "size": {"value": 32624, "unit": "MB"},
        },
    },
    {
        "asic": {
            "market_name": "AMD Radeon Graphics",
            "vendor_id": "0x1002",
            "target_graphics_version": "gfx1036",
        },
        "vram": {
            "size": {"value": 2048, "unit": "MB"},
        },
    },
])

AMD_SMI_SINGLE_GPU = json.dumps([
    {
        "asic": {
            "market_name": "AMD Radeon RX 7900 XTX",
            "target_graphics_version": "gfx1100",
        },
        "vram": {
            "size": {"value": 24576, "unit": "MB"},
        },
    },
])

# Wrapped in gpu_data key (some amd-smi versions do this)
AMD_SMI_WRAPPED = json.dumps({
    "gpu_data": json.loads(AMD_SMI_SINGLE_GPU),
})

ROCM_SMI_PRODUCTNAME = "device,Card Series\ncard0,AMD Radeon RX 7900 XTX\n"
ROCM_SMI_MEMINFO = "GPU,vram Total Memory (B)\n25769803776,25769803776\n"


# ── Helpers ────────────────────────────────────────────────────────────────

def _make_run_result(stdout="", returncode=0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr="")


def _mock_which(available_tools):
    """Return a shutil.which mock that only finds tools in available_tools."""
    def _which(name):
        return f"/usr/bin/{name}" if name in available_tools else None
    return _which


# ── Tests: _try_rocm ──────────────────────────────────────────────────────

class TestTryRocmAmdSmi:
    """amd-smi primary strategy."""

    @mock.patch("env_config.shutil.which", _mock_which({"amd-smi"}))
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_dual_gpu_picks_discrete(self, mock_run, _mock_dir):
        """With 2 GPUs, picks the R9700 (32 GB) over iGPU (2 GB)."""
        mock_run.return_value = _make_run_result(AMD_SMI_DUAL_GPU)

        mock_torch = mock.MagicMock()
        mock_torch.cuda.is_available.return_value = True
        with mock.patch.dict("sys.modules", {"torch": mock_torch}):
            env = HardwareEnv()
            result = env._try_rocm()

        assert result is True
        assert env.backend == "rocm"
        assert env.device == "cuda"
        assert env.gpu_name == "AMD Radeon AI PRO R9700"
        assert env.gpu_memory_mb == 32624
        assert env.detection_details["amd_smi"]["gpu_index"] == 0
        assert env.detection_details["amd_smi"]["gfx_version"] == "gfx1201"
        assert env.detection_details["amd_smi"]["total_gpus"] == 2

    @mock.patch("env_config.shutil.which", _mock_which({"amd-smi"}))
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_dual_gpu_sets_env_vars(self, mock_run, _mock_dir):
        """Multi-GPU: HIP_VISIBLE_DEVICES and ROCR_VISIBLE_DEVICES are set."""
        mock_run.return_value = _make_run_result(AMD_SMI_DUAL_GPU)

        # Clean env
        for var in ("HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"):
            os.environ.pop(var, None)

        env = HardwareEnv()
        env._try_rocm()

        assert os.environ.get("HIP_VISIBLE_DEVICES") == "0"
        assert os.environ.get("ROCR_VISIBLE_DEVICES") == "0"

        # Cleanup
        os.environ.pop("HIP_VISIBLE_DEVICES", None)
        os.environ.pop("ROCR_VISIBLE_DEVICES", None)

    @mock.patch("env_config.shutil.which", _mock_which({"amd-smi"}))
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_single_gpu_no_env_vars(self, mock_run, _mock_dir):
        """Single GPU: HIP_VISIBLE_DEVICES NOT set."""
        mock_run.return_value = _make_run_result(AMD_SMI_SINGLE_GPU)

        for var in ("HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"):
            os.environ.pop(var, None)

        env = HardwareEnv()
        env._try_rocm()

        assert env.gpu_name == "AMD Radeon RX 7900 XTX"
        assert env.gpu_memory_mb == 24576
        assert "HIP_VISIBLE_DEVICES" not in os.environ

    @mock.patch("env_config.shutil.which", _mock_which({"amd-smi"}))
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_wrapped_gpu_data_format(self, mock_run, _mock_dir):
        """amd-smi returning {\"gpu_data\": [...]} wrapper."""
        mock_run.return_value = _make_run_result(AMD_SMI_WRAPPED)

        env = HardwareEnv()
        env._try_rocm()

        assert env.gpu_name == "AMD Radeon RX 7900 XTX"
        assert env.gpu_memory_mb == 24576

    @mock.patch("env_config.shutil.which", _mock_which({"amd-smi"}))
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_amd_smi_failure_returns_true_with_defaults(self, mock_run, _mock_dir):
        """amd-smi fails → still returns True (ROCm detected), empty gpu_name."""
        mock_run.return_value = _make_run_result("", returncode=1)

        env = HardwareEnv()
        result = env._try_rocm()

        assert result is True
        assert env.backend == "rocm"
        assert env.gpu_name == ""  # No name parsed, but backend detected

    @mock.patch("env_config.shutil.which", _mock_which({"amd-smi"}))
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_no_pytorch_rocm_falls_back_to_cpu_device(self, mock_run, _mock_dir):
        """When torch.cuda.is_available() is False, device stays 'cpu'."""
        mock_run.return_value = _make_run_result(AMD_SMI_SINGLE_GPU)

        mock_torch = mock.MagicMock()
        mock_torch.cuda.is_available.return_value = False
        with mock.patch.dict("sys.modules", {"torch": mock_torch}):
            env = HardwareEnv()
            env._try_rocm()

        assert env.backend == "rocm"
        assert env.device == "cpu"  # No PyTorch-ROCm → CPU fallback
        assert env.gpu_name == "AMD Radeon RX 7900 XTX"  # GPU still detected


class TestTryRocmFallback:
    """rocm-smi fallback (amd-smi not available)."""

    @mock.patch("env_config.shutil.which", _mock_which({"rocm-smi"}))
    @mock.patch("env_config.Path.is_dir", return_value=False)
    @mock.patch("env_config.subprocess.run")
    def test_rocm_smi_parses_name_and_vram(self, mock_run, _mock_dir):
        """Legacy rocm-smi fallback parses product name and VRAM."""
        def side_effect(cmd, **kwargs):
            if "--showproductname" in cmd:
                return _make_run_result(ROCM_SMI_PRODUCTNAME)
            elif "--showmeminfo" in cmd:
                return _make_run_result(ROCM_SMI_MEMINFO)
            return _make_run_result("", returncode=1)

        mock_run.side_effect = side_effect

        env = HardwareEnv()
        result = env._try_rocm()

        assert result is True
        # NOTE: rocm-smi --showproductname CSV puts device ID in col 0 ("card0"),
        # which is why amd-smi is the preferred strategy.  This is the known
        # limitation documented in the original bug report.
        assert env.gpu_name == "card0"
        # 25769803776 / (1024*1024) = 24576
        assert env.gpu_memory_mb == 24576

    @mock.patch("env_config.shutil.which", _mock_which(set()))
    @mock.patch("env_config.Path.is_dir", return_value=True)
    def test_only_opt_rocm_dir(self, _mock_dir):
        """Only /opt/rocm exists — detects ROCm with no GPU info."""
        env = HardwareEnv()
        result = env._try_rocm()

        assert result is True
        assert env.backend == "rocm"
        assert env.gpu_name == ""

    @mock.patch("env_config.shutil.which", _mock_which(set()))
    @mock.patch("env_config.Path.is_dir", return_value=False)
    def test_no_rocm_at_all(self, _mock_dir):
        """No amd-smi, no rocm-smi, no /opt/rocm → returns False."""
        env = HardwareEnv()
        result = env._try_rocm()

        assert result is False
        assert env.backend == "cpu"  # unchanged default


# ── Tests: _check_rocm_runtime ────────────────────────────────────────────

class TestCheckRocmRuntime:
    """Verify ONNX Runtime provider check."""

    def test_rocm_provider_present(self):
        """ROCmExecutionProvider in list → returns True."""
        env = HardwareEnv()
        with mock.patch.dict("sys.modules", {"onnxruntime": mock.MagicMock()}):
            ort = sys.modules["onnxruntime"]
            ort.get_available_providers.return_value = [
                "ROCmExecutionProvider", "CPUExecutionProvider",
            ]
            assert env._check_rocm_runtime() is True

    def test_migraphx_provider_present(self):
        """MIGraphXExecutionProvider also accepted."""
        env = HardwareEnv()
        with mock.patch.dict("sys.modules", {"onnxruntime": mock.MagicMock()}):
            ort = sys.modules["onnxruntime"]
            ort.get_available_providers.return_value = [
                "MIGraphXExecutionProvider", "CPUExecutionProvider",
            ]
            assert env._check_rocm_runtime() is True

    def test_cpu_only_raises(self):
        """CPU-only onnxruntime → raises ImportError."""
        env = HardwareEnv()
        with mock.patch.dict("sys.modules", {"onnxruntime": mock.MagicMock()}):
            ort = sys.modules["onnxruntime"]
            ort.get_available_providers.return_value = [
                "AzureExecutionProvider", "CPUExecutionProvider",
            ]
            with pytest.raises(ImportError, match="ROCmExecutionProvider not available"):
                env._check_rocm_runtime()

    def test_onnxruntime_missing_raises(self):
        """onnxruntime not installed → ImportError from import."""
        env = HardwareEnv()
        with mock.patch.dict("sys.modules", {"onnxruntime": None}):
            with pytest.raises((ImportError, ModuleNotFoundError)):
                env._check_rocm_runtime()


# ── Tests: _check_framework integration ───────────────────────────────────

class TestCheckFrameworkRocm:
    """_check_framework uses _check_rocm_runtime for ROCm backend."""

    def test_rocm_framework_ok_when_provider_present(self):
        env = HardwareEnv()
        env.backend = "rocm"
        with mock.patch.object(env, "_check_rocm_runtime", return_value=True):
            assert env._check_framework() is True

    def test_rocm_framework_not_ok_when_provider_missing(self):
        env = HardwareEnv()
        env.backend = "rocm"
        with mock.patch.object(env, "_check_rocm_runtime", side_effect=ImportError("no ROCm")):
            assert env._check_framework() is False
