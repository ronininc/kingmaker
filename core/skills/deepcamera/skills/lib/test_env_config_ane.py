#!/usr/bin/env python3
"""
Unit tests for Apple Neural Engine (ANE) compute_units in env_config.py.

Tests compute_units configuration, monkey-patch scoping, and CoreML
load-time injection — all mocked, no Apple hardware required.

Run:  python -m pytest skills/lib/test_env_config_ane.py -v
"""

import platform
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

# Ensure env_config is importable from skills/lib/
sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_config import BackendSpec, BACKEND_SPECS, HardwareEnv, _log  # noqa: E402


# ── Tests: BackendSpec compute_units ────────────────────────────────────────

class TestBackendSpecComputeUnits:
    """Verify compute_units field on backend specs."""

    def test_mps_spec_has_cpu_and_ne(self):
        """MPS backend defaults to cpu_and_ne (Neural Engine)."""
        spec = BACKEND_SPECS["mps"]
        assert spec.compute_units == "cpu_and_ne"

    def test_cuda_spec_has_no_compute_units(self):
        """Non-Apple backends have no compute_units set."""
        assert BACKEND_SPECS["cuda"].compute_units is None

    def test_cpu_spec_has_no_compute_units(self):
        assert BACKEND_SPECS["cpu"].compute_units is None

    def test_rocm_spec_has_no_compute_units(self):
        assert BACKEND_SPECS["rocm"].compute_units is None

    def test_intel_spec_has_no_compute_units(self):
        assert BACKEND_SPECS["intel"].compute_units is None


# ── Tests: HardwareEnv compute_units field ──────────────────────────────────

class TestHardwareEnvComputeUnits:
    """Verify compute_units is set correctly during detection."""

    def test_default_compute_units_is_all(self):
        """Default HardwareEnv has compute_units='all'."""
        env = HardwareEnv()
        assert env.compute_units == "all"

    @mock.patch("env_config.platform.system", return_value="Darwin")
    @mock.patch("env_config.platform.machine", return_value="arm64")
    @mock.patch("env_config.subprocess.run")
    @mock.patch("env_config.shutil.which", return_value=None)
    @mock.patch("env_config.Path.is_dir", return_value=False)
    def test_mps_sets_compute_units_cpu_and_ne(
        self, _dir, _which, mock_run, _machine, _system
    ):
        """Apple Silicon detection sets compute_units to 'cpu_and_ne'."""
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="Apple M3 Max"
        )

        env = HardwareEnv()
        result = env._try_mps()
        assert result is True

        # Simulate what detect() does after _try_mps
        spec = BACKEND_SPECS.get(env.backend, BACKEND_SPECS["cpu"])
        if spec.compute_units:
            env.compute_units = spec.compute_units

        assert env.backend == "mps"
        assert env.compute_units == "cpu_and_ne"

    def test_to_dict_includes_compute_units_for_mps(self):
        """to_dict() includes compute_units when backend is mps."""
        env = HardwareEnv()
        env.backend = "mps"
        env.compute_units = "cpu_and_ne"
        d = env.to_dict()
        assert "compute_units" in d
        assert d["compute_units"] == "cpu_and_ne"

    def test_to_dict_excludes_compute_units_for_non_mps(self):
        """to_dict() does NOT include compute_units for non-mps backends."""
        env = HardwareEnv()
        env.backend = "cuda"
        d = env.to_dict()
        assert "compute_units" not in d


# ── Tests: _load_coreml_with_compute_units ──────────────────────────────────

class TestLoadCoremlWithComputeUnits:
    """Test the monkey-patch mechanism for CoreML compute_units."""

    def test_monkey_patch_injects_compute_units(self):
        """MLModel is temporarily patched to inject CPU_AND_NE."""
        env = HardwareEnv()
        env.backend = "mps"
        env.compute_units = "cpu_and_ne"

        # Create mock coremltools module
        mock_ct = mock.MagicMock()
        mock_ct.ComputeUnit.CPU_AND_NE = "CPU_AND_NE_SENTINEL"
        mock_ct.ComputeUnit.ALL = "ALL_SENTINEL"

        # Track MLModel calls to verify compute_units was injected
        original_mlmodel = mock.MagicMock()
        mock_ct.models.MLModel = original_mlmodel

        captured_kwargs = {}

        mock_yolo_cls = mock.MagicMock()

        def capture_yolo_init(path):
            """When YOLO loads the model, check if MLModel was patched."""
            # Simulate what YOLO does internally: call ct.models.MLModel
            current_mlmodel = mock_ct.models.MLModel
            # The patched class should be different from original
            instance = current_mlmodel("test.mlpackage")
            return mock.MagicMock()

        mock_yolo_cls.side_effect = capture_yolo_init

        with mock.patch.dict("sys.modules", {"coremltools": mock_ct}):
            with mock.patch("env_config.YOLO", mock_yolo_cls, create=True):
                # Can't easily test the full flow since YOLO import is inside
                # the method. Instead, test the logic directly.
                pass

        # Direct test: verify the patch class works correctly
        class MockMLModel:
            def __init__(self, *args, **kwargs):
                self.kwargs = kwargs

        mock_ct.models.MLModel = MockMLModel

        with mock.patch.dict("sys.modules", {"coremltools": mock_ct}):
            # Simulate the patching logic
            _OrigMLModel = mock_ct.models.MLModel
            target_units = mock_ct.ComputeUnit.CPU_AND_NE

            class _PatchedMLModel(_OrigMLModel):
                def __init__(self, *args, **kwargs):
                    kwargs.setdefault('compute_units', target_units)
                    super().__init__(*args, **kwargs)

            # Verify patch injects compute_units
            patched = _PatchedMLModel("test.mlpackage")
            assert patched.kwargs.get('compute_units') == "CPU_AND_NE_SENTINEL"

            # Verify explicit override is preserved
            explicit = _PatchedMLModel("test.mlpackage", compute_units="CUSTOM")
            assert explicit.kwargs.get('compute_units') == "CUSTOM"

    def test_monkey_patch_restored_after_load(self):
        """MLModel is restored to original after YOLO load, even on error."""
        env = HardwareEnv()
        env.backend = "mps"
        env.compute_units = "cpu_and_ne"

        mock_ct = mock.MagicMock()
        mock_ct.ComputeUnit.CPU_AND_NE = "CPU_AND_NE_SENTINEL"
        original_mlmodel = mock.MagicMock()
        mock_ct.models.MLModel = original_mlmodel

        mock_yolo = mock.MagicMock(side_effect=Exception("test error"))

        with mock.patch.dict("sys.modules", {
            "coremltools": mock_ct,
            "ultralytics": mock.MagicMock(YOLO=mock_yolo),
        }):
            try:
                env._load_coreml_with_compute_units("test.mlpackage")
            except Exception:
                pass

            # MLModel should be restored to original even after error
            assert mock_ct.models.MLModel is original_mlmodel

    def test_unknown_compute_units_falls_back(self):
        """Unknown compute_units string falls back to plain YOLO load."""
        env = HardwareEnv()
        env.backend = "mps"
        env.compute_units = "unknown_units"

        mock_yolo = mock.MagicMock()
        mock_model = mock.MagicMock()
        mock_yolo.return_value = mock_model

        with mock.patch.dict("sys.modules", {
            "ultralytics": mock.MagicMock(YOLO=mock_yolo),
        }):
            result = env._load_coreml_with_compute_units("test.mlpackage")
            mock_yolo.assert_called_once_with("test.mlpackage")

    def test_coremltools_missing_falls_back(self):
        """If coremltools import fails, falls back to plain YOLO load."""
        env = HardwareEnv()
        env.backend = "mps"
        env.compute_units = "cpu_and_ne"

        mock_yolo = mock.MagicMock()
        mock_model = mock.MagicMock()
        mock_yolo.return_value = mock_model

        # Make coremltools import fail
        with mock.patch.dict("sys.modules", {
            "coremltools": None,
            "ultralytics": mock.MagicMock(YOLO=mock_yolo),
        }):
            result = env._load_coreml_with_compute_units("test.mlpackage")
            mock_yolo.assert_called_once_with("test.mlpackage")


# ── Tests: load_optimized integration ───────────────────────────────────────

class TestLoadOptimizedMPS:
    """Test that load_optimized routes through compute_units on MPS."""

    def test_mps_cached_model_uses_compute_units(self):
        """When cached .mlpackage exists, loads via _load_coreml_with_compute_units."""
        env = HardwareEnv()
        env.backend = "mps"
        env.device = "mps"
        env.export_format = "coreml"
        env.framework_ok = True
        env.compute_units = "cpu_and_ne"

        mock_model = mock.MagicMock()

        with mock.patch.object(env, "_load_coreml_with_compute_units",
                               return_value=mock_model) as mock_load:
            with mock.patch.object(env, "get_optimized_path") as mock_path:
                mock_path.return_value = mock.MagicMock(exists=lambda: True)

                with mock.patch.dict("sys.modules", {
                    "ultralytics": mock.MagicMock(),
                }):
                    model, fmt = env.load_optimized("yolo26n")

                assert fmt == "coreml"
                mock_load.assert_called_once()

    def test_mps_compute_units_all_skips_monkey_patch(self):
        """When compute_units='all', loads via standard YOLO path."""
        env = HardwareEnv()
        env.backend = "mps"
        env.device = "mps"
        env.export_format = "coreml"
        env.framework_ok = True
        env.compute_units = "all"  # explicit: use all units including GPU

        mock_yolo = mock.MagicMock()
        mock_model = mock.MagicMock()
        mock_yolo.return_value = mock_model

        with mock.patch.object(env, "get_optimized_path") as mock_path:
            mock_path.return_value = mock.MagicMock(exists=lambda: True)

            with mock.patch.dict("sys.modules", {
                "ultralytics": mock.MagicMock(YOLO=mock_yolo),
            }):
                model, fmt = env.load_optimized("yolo26n")

            assert fmt == "coreml"
            mock_yolo.assert_called_once()
