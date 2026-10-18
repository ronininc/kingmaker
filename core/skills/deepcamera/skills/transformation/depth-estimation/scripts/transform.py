#!/usr/bin/env python3
"""
Depth Estimation Privacy Skill — Monocular depth maps via Depth Anything v2.

Backend selection:
  macOS  → CoreML (.mlpackage via coremltools) — runs on Neural Engine
  Other  → ONNX Runtime (pre-exported .onnx from HuggingFace) — CUDA/TRT/DirectML/CPU
           Fallback → PyTorch (depth_anything_v2 pip package + HF weights) — CUDA/MPS/CPU

Implements the TransformSkillBase interface to provide real-time depth map
overlays on camera feeds. When used as a privacy skill, the depth-only mode
anonymizes the scene while preserving spatial layout and activity recognition.

Usage:
  python transform.py --model depth-anything-v2-small --device auto
  python transform.py --config config.json
"""

import sys
import os
import platform
import argparse
from pathlib import Path

# Import the base class from the same directory
_script_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(_script_dir))

from transform_base import TransformSkillBase, _log  # noqa: E402


COLORMAP_MAP = {
    "inferno": 1,   # cv2.COLORMAP_INFERNO
    "viridis": 16,  # cv2.COLORMAP_VIRIDIS
    "plasma": 13,   # cv2.COLORMAP_PLASMA
    "magma": 12,    # cv2.COLORMAP_MAGMA
    "jet": 2,       # cv2.COLORMAP_JET
    "turbo": 18,    # cv2.COLORMAP_TURBO
    "hot": 11,      # cv2.COLORMAP_HOT
    "cool": 8,      # cv2.COLORMAP_COOL
}

# CoreML model registry — mirrors apple/coreml-depth-anything-v2-small HF repo
COREML_VARIANTS = {
    "DepthAnythingV2SmallF16": {
        "precision": "float16",
        "size_mb": 49.8,
        "description": "Float16 — optimized for Neural Engine",
    },
    "DepthAnythingV2SmallF16INT8": {
        "precision": "float16_int8",
        "size_mb": 25.0,
        "description": "Float16 + INT8 quantization — smallest",
    },
    "DepthAnythingV2SmallF32": {
        "precision": "float32",
        "size_mb": 99.2,
        "description": "Float32 — highest precision",
    },
}

# Default CoreML variant (best balance of speed + quality on Neural Engine)
DEFAULT_COREML_VARIANT = "DepthAnythingV2SmallF16"

# HuggingFace repo for CoreML models
COREML_HF_REPO = "apple/coreml-depth-anything-v2-small"

# CoreML input size — MUST match model exactly (multiples of 14 for ViT)
COREML_INPUT_SIZE = (518, 392)  # width, height

# Where Aegis DepthVisionStudio stores downloaded models
MODELS_DIR = Path.home() / ".aegis-ai" / "models" / "feature-extraction"

# TensorRT engine cache directory (engines are GPU-specific)
TRT_CACHE_DIR = MODELS_DIR / "trt_engines"

# PyTorch model configs (fallback on non-macOS)
PYTORCH_CONFIGS = {
    "depth-anything-v2-small": {
        "encoder": "vits", "features": 64,
        "out_channels": [48, 96, 192, 384],
        "repo": "depth-anything/Depth-Anything-V2-Small",
        "filename": "depth_anything_v2_vits.pth",
    },
    "depth-anything-v2-base": {
        "encoder": "vitb", "features": 128,
        "out_channels": [96, 192, 384, 768],
        "repo": "depth-anything/Depth-Anything-V2-Base",
        "filename": "depth_anything_v2_vitb.pth",
    },
    "depth-anything-v2-large": {
        "encoder": "vitl", "features": 256,
        "out_channels": [256, 512, 1024, 1024],
        "repo": "depth-anything/Depth-Anything-V2-Large",
        "filename": "depth_anything_v2_vitl.pth",
    },
}

# ONNX model configs — pre-exported models from onnx-community on HuggingFace
ONNX_CONFIGS = {
    "depth-anything-v2-small": {
        "repo": "onnx-community/depth-anything-v2-small",
        "filename": "onnx/model.onnx",
        "input_size": (518, 518),  # H, W
    },
}


class DepthEstimationSkill(TransformSkillBase):
    """
    Depth estimation using Depth Anything v2.

    Produces colorized depth maps that can be blended with the original frame
    (overlay mode), shown side-by-side, or displayed as depth-only anonymized view.
    """

    def __init__(self):
        super().__init__()
        self._tag = "DepthEstimation"
        self.model = None
        self.backend = None  # "coreml", "onnx", "tensorrt", or "pytorch"
        self.colormap_id = 1
        self.opacity = 0.5
        self.blend_mode = "depth_only"  # Default for privacy: depth_only anonymizes
        self._coreml_input_size = COREML_INPUT_SIZE
        # ONNX Runtime state
        self._ort_session = None
        self._ort_input_name = None
        self._ort_input_size = (518, 518)  # H, W default
        # TensorRT state (populated by _load_tensorrt)
        self._trt_context = None
        self._trt_input_name = None
        self._trt_output_name = None
        self._trt_input_tensor = None
        self._trt_output_tensor = None
        self._trt_stream = None

    def parse_extra_args(self, parser: argparse.ArgumentParser):
        parser.add_argument("--model", type=str, default="depth-anything-v2-small",
                            choices=["depth-anything-v2-small", "depth-anything-v2-base",
                                     "depth-anything-v2-large"])
        parser.add_argument("--variant", type=str, default=DEFAULT_COREML_VARIANT,
                            help="CoreML variant ID (macOS only)")
        parser.add_argument("--colormap", type=str, default="viridis",
                            choices=list(COLORMAP_MAP.keys()))
        parser.add_argument("--blend-mode", type=str, default="depth_only",
                            choices=["overlay", "side_by_side", "depth_only"])
        parser.add_argument("--opacity", type=float, default=0.5)

    def load_model(self, config: dict) -> dict:
        model_name = config.get("model", "depth-anything-v2-small")
        self.colormap_id = COLORMAP_MAP.get(config.get("colormap", "viridis"), 16)
        self.opacity = config.get("opacity", 0.5)
        self.blend_mode = config.get("blend_mode", "depth_only")

        # Try CoreML first on macOS
        if platform.system() == "Darwin":
            try:
                info = self._load_coreml(config)
                return info
            except Exception as e:
                _log(f"CoreML load failed ({e}), falling back to PyTorch", self._tag)

        # Non-macOS: try ONNX Runtime first (lightest, fastest install)
        try:
            info = self._load_onnx(model_name, config)
            return info
        except Exception as e:
            _log(f"ONNX Runtime load failed ({e}), trying TensorRT...", self._tag)

        # Try TensorRT (fails fast if not installed)
        try:
            info = self._load_tensorrt(model_name, config)
            return info
        except Exception as e:
            _log(f"TensorRT unavailable ({e}), falling back to PyTorch", self._tag)

        # Fallback: PyTorch
        return self._load_pytorch(model_name, config)

    # ── CoreML backend (macOS) ────────────────────────────────────────

    def _load_coreml(self, config: dict) -> dict:
        """Load CoreML .mlpackage model — runs on Apple Neural Engine."""
        import coremltools as ct

        variant_id = config.get("variant", DEFAULT_COREML_VARIANT)
        model_path = MODELS_DIR / f"{variant_id}.mlpackage"

        # Auto-download from HuggingFace if not present
        if not model_path.exists():
            _log(f"CoreML model not found at {model_path}, downloading from HF...", self._tag)
            self._download_coreml_model(variant_id)

        if not model_path.exists():
            raise FileNotFoundError(f"CoreML model not found: {model_path}")

        _log(f"Loading CoreML model: {variant_id} (Neural Engine)", self._tag)
        self.model = ct.models.MLModel(str(model_path), compute_units=ct.ComputeUnit.ALL)
        self.backend = "coreml"

        _log(f"CoreML model loaded: {variant_id}", self._tag)
        return {
            "model": f"coreml-{variant_id}",
            "device": "neural_engine",
            "blend_mode": self.blend_mode,
            "colormap": config.get("colormap", "viridis"),
            "backend": "coreml",
        }

    def _download_coreml_model(self, variant_id: str):
        """Download CoreML .mlpackage from HuggingFace using huggingface_hub."""
        try:
            from huggingface_hub import snapshot_download

            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            mlpackage_name = f"{variant_id}.mlpackage"

            _log(f"Downloading {mlpackage_name} from {COREML_HF_REPO}...", self._tag)

            # Download only the specific variant's .mlpackage directory
            snapshot_download(
                COREML_HF_REPO,
                local_dir=str(MODELS_DIR),
                allow_patterns=[f"{mlpackage_name}/**"],
            )

            model_path = MODELS_DIR / mlpackage_name
            if model_path.exists():
                _log(f"Downloaded CoreML model: {model_path}", self._tag)
            else:
                _log(f"Download completed but model not found at {model_path}", self._tag)
        except Exception as e:
            _log(f"CoreML model download failed: {e}", self._tag)
            raise

    # ── ONNX Runtime backend (Windows/Linux — all GPUs) ────────────────

    @staticmethod
    def _add_nvidia_dll_paths():
        """Add pip-installed NVIDIA DLL directories to PATH so ORT finds cudnn, cublas, etc."""
        import site
        import glob

        for sp in site.getsitepackages():
            nvidia_dir = os.path.join(sp, "nvidia")
            if not os.path.isdir(nvidia_dir):
                continue
            for bin_dir in glob.glob(os.path.join(nvidia_dir, "*", "bin")):
                if bin_dir not in os.environ.get("PATH", ""):
                    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
                    # Python 3.8+ on Windows: also register via os.add_dll_directory
                    if hasattr(os, "add_dll_directory"):
                        try:
                            os.add_dll_directory(bin_dir)
                        except OSError:
                            pass
                    _log(f"Added NVIDIA DLL path: {bin_dir}", "DepthEstimation")


    def _load_onnx(self, model_name: str, config: dict) -> dict:
        """Load ONNX model with best available EP: CUDA → TRT → DirectML → CPU."""
        # Add pip-installed NVIDIA DLL dirs to PATH (cudnn, cublas, etc.)
        self._add_nvidia_dll_paths()

        import onnxruntime as ort
        from huggingface_hub import hf_hub_download

        onnx_cfg = ONNX_CONFIGS.get(model_name)
        if not onnx_cfg:
            raise ValueError(f"No ONNX config for model: {model_name}")

        # Check local models dir first (placed by deploy.bat or UI download)
        local_onnx = MODELS_DIR / f"{Path(onnx_cfg['filename']).stem}.onnx"
        if local_onnx.exists():
            model_path = str(local_onnx)
            _log(f"Found local ONNX model: {local_onnx}", self._tag)
        else:
            # Fall back to HuggingFace cache download
            _log(f"Downloading ONNX model: {onnx_cfg['repo']}...", self._tag)
            model_path = hf_hub_download(onnx_cfg["repo"], onnx_cfg["filename"])

        # Build EP cascade: prefer GPU, fall back to CPU
        available_eps = ort.get_available_providers()
        _log(f"Available ONNX EPs: {available_eps}", self._tag)

        ep_priority = [
            ("CUDAExecutionProvider", "cuda"),
            ("TensorrtExecutionProvider", "tensorrt"),
            ("DmlExecutionProvider", "directml"),
            ("CPUExecutionProvider", "cpu"),
        ]

        selected_eps = []
        device_name = "cpu"
        for ep_name, dev in ep_priority:
            if ep_name in available_eps:
                selected_eps.append(ep_name)
                if device_name == "cpu":
                    device_name = dev  # first non-CPU EP

        if not selected_eps:
            selected_eps = ["CPUExecutionProvider"]

        _log(f"Creating ONNX session with EPs: {selected_eps}", self._tag)
        sess_opts = ort.SessionOptions()
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        self._ort_session = ort.InferenceSession(
            model_path, sess_options=sess_opts, providers=selected_eps
        )
        self._ort_input_name = self._ort_session.get_inputs()[0].name
        self._ort_input_size = onnx_cfg["input_size"]
        self.backend = "onnx"

        active_ep = self._ort_session.get_providers()[0]
        _log(f"ONNX model loaded: {model_name} (EP={active_ep})", self._tag)
        return {
            "model": model_name,
            "device": device_name,
            "blend_mode": self.blend_mode,
            "colormap": config.get("colormap", "viridis"),
            "backend": "onnx",
            "execution_provider": active_ep,
        }

    # ── TensorRT backend (Windows/Linux NVIDIA) ───────────────────────

    def _load_tensorrt(self, model_name: str, config: dict) -> dict:
        """Load or build a TensorRT FP16 engine for fastest NVIDIA inference."""
        import torch
        import tensorrt as trt

        _log(f"Attempting TensorRT FP16 for {model_name}", self._tag)

        cfg = PYTORCH_CONFIGS.get(model_name)
        if not cfg:
            raise ValueError(f"Unknown model: {model_name}")

        gpu_tag = torch.cuda.get_device_name(0).replace(" ", "_").lower()
        engine_path = TRT_CACHE_DIR / f"{cfg['filename'].replace('.pth', '')}_fp16_{gpu_tag}.trt"

        if engine_path.exists():
            _log(f"Loading cached TRT engine: {engine_path}", self._tag)
            engine = self._deserialize_engine(engine_path)
        else:
            _log("No cached engine — building from ONNX (30-120s)...", self._tag)
            engine = self._build_trt_engine(cfg, engine_path)

        if engine is None:
            raise RuntimeError("TensorRT engine build/load failed")

        self._trt_context = engine.create_execution_context()
        self._trt_input_name = engine.get_tensor_name(0)
        self._trt_output_name = engine.get_tensor_name(1)

        input_shape = engine.get_tensor_shape(self._trt_input_name)
        fixed_shape = tuple(1 if d == -1 else d for d in input_shape)
        self._trt_context.set_input_shape(self._trt_input_name, fixed_shape)

        self._trt_input_tensor = torch.zeros(fixed_shape, dtype=torch.float32, device="cuda")
        actual_out_shape = self._trt_context.get_tensor_shape(self._trt_output_name)
        self._trt_output_tensor = torch.empty(list(actual_out_shape), dtype=torch.float32, device="cuda")

        self._trt_context.set_tensor_address(self._trt_input_name, self._trt_input_tensor.data_ptr())
        self._trt_context.set_tensor_address(self._trt_output_name, self._trt_output_tensor.data_ptr())
        self._trt_stream = torch.cuda.current_stream().cuda_stream

        self.backend = "tensorrt"
        _log(f"TensorRT FP16 engine ready: {engine_path.name}", self._tag)
        return {
            "model": model_name,
            "device": "cuda",
            "blend_mode": self.blend_mode,
            "colormap": config.get("colormap", "viridis"),
            "backend": "tensorrt",
        }

    def _build_trt_engine(self, cfg: dict, engine_path: Path):
        """Export PyTorch → ONNX → build TRT FP16 engine → serialize to disk."""
        import torch
        import tensorrt as trt
        from depth_anything_v2.dpt import DepthAnythingV2
        from huggingface_hub import hf_hub_download

        weights_path = hf_hub_download(cfg["repo"], cfg["filename"])
        pt_model = DepthAnythingV2(
            encoder=cfg["encoder"], features=cfg["features"],
            out_channels=cfg["out_channels"],
        )
        pt_model.load_state_dict(torch.load(weights_path, map_location="cuda", weights_only=True))
        pt_model.to("cuda").eval()

        dummy = torch.randn(1, 3, 518, 518, device="cuda")
        onnx_path = TRT_CACHE_DIR / f"{cfg['filename'].replace('.pth', '')}.onnx"
        TRT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

        _log(f"Exporting ONNX: {onnx_path.name}", self._tag)
        torch.onnx.export(
            pt_model, dummy, str(onnx_path),
            input_names=["input"], output_names=["depth"],
            dynamic_axes={"input": {0: "batch"}, "depth": {0: "batch"}},
            opset_version=17,
        )
        del pt_model
        torch.cuda.empty_cache()

        logger = trt.Logger(trt.Logger.WARNING)
        builder = trt.Builder(logger)
        network = builder.create_network(1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH))
        parser = trt.OnnxParser(network, logger)

        _log("Parsing ONNX for TensorRT...", self._tag)
        with open(str(onnx_path), "rb") as f:
            if not parser.parse(f.read()):
                for i in range(parser.num_errors):
                    _log(f"  ONNX parse error: {parser.get_error(i)}", self._tag)
                return None

        config = builder.create_builder_config()
        config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 1 << 30)

        inp = network.get_input(0)
        if any(d == -1 for d in inp.shape):
            profile = builder.create_optimization_profile()
            fixed = tuple(1 if d == -1 else d for d in inp.shape)
            profile.set_shape(inp.name, fixed, fixed, fixed)
            config.add_optimization_profile(profile)

        config.set_flag(trt.BuilderFlag.FP16)

        _log("Building TRT FP16 engine (30-120s)...", self._tag)
        serialized = builder.build_serialized_network(network, config)
        if serialized is None:
            _log("TRT engine build failed!", self._tag)
            return None

        engine_bytes = bytes(serialized)
        with open(str(engine_path), "wb") as f:
            f.write(engine_bytes)
        _log(f"Engine cached: {engine_path} ({len(engine_bytes) / 1e6:.1f} MB)", self._tag)

        try:
            onnx_path.unlink()
        except OSError:
            pass

        runtime = trt.Runtime(logger)
        return runtime.deserialize_cuda_engine(engine_bytes)

    @staticmethod
    def _deserialize_engine(engine_path: Path):
        """Load a previously serialized TRT engine from disk."""
        import tensorrt as trt
        logger = trt.Logger(trt.Logger.WARNING)
        runtime = trt.Runtime(logger)
        with open(str(engine_path), "rb") as f:
            return runtime.deserialize_cuda_engine(f.read())

    # ── PyTorch backend (fallback) ────────────────────────────────────

    def _load_pytorch(self, model_name: str, config: dict) -> dict:
        """Load PyTorch model — fallback for non-macOS or when CoreML is unavailable."""
        import torch
        from depth_anything_v2.dpt import DepthAnythingV2
        from huggingface_hub import hf_hub_download

        _log(f"Loading {model_name} on {self.device} (PyTorch)", self._tag)

        cfg = PYTORCH_CONFIGS.get(model_name)
        if not cfg:
            raise ValueError(f"Unknown model: {model_name}. Choose from: {list(PYTORCH_CONFIGS.keys())}")

        # Download weights from HuggingFace Hub (cached after first download)
        _log(f"Downloading weights from HF: {cfg['repo']}", self._tag)
        weights_path = hf_hub_download(cfg["repo"], cfg["filename"])

        # Build model from pip package
        self.model = DepthAnythingV2(
            encoder=cfg["encoder"],
            features=cfg["features"],
            out_channels=cfg["out_channels"],
        )
        self.model.load_state_dict(torch.load(weights_path, map_location=self.device, weights_only=True))
        self.model.to(self.device)
        self.model.eval()
        self.backend = "pytorch"

        _log(f"PyTorch model loaded: {model_name} on {self.device}", self._tag)
        return {
            "model": model_name,
            "device": self.device,
            "blend_mode": self.blend_mode,
            "colormap": config.get("colormap", "viridis"),
            "backend": "pytorch",
        }

    # ── Frame transform ───────────────────────────────────────────────

    def transform_frame(self, image, metadata: dict):
        import cv2
        import numpy as np

        if self.backend == "coreml":
            depth_colored = self._infer_coreml(image)
        elif self.backend == "onnx":
            depth_colored = self._infer_onnx(image)
        elif self.backend == "tensorrt":
            depth_colored = self._infer_tensorrt(image)
        else:
            depth_colored = self._infer_pytorch(image)

        if self.blend_mode == "overlay":
            output = cv2.addWeighted(image, 1 - self.opacity, depth_colored, self.opacity, 0)
        elif self.blend_mode == "side_by_side":
            output = np.hstack([image, depth_colored])
        else:  # depth_only — full anonymization
            output = depth_colored

        return output

    def _infer_coreml(self, image):
        """Run CoreML inference and return colorized depth map (BGR, original size)."""
        import cv2
        import numpy as np
        from PIL import Image

        original_h, original_w = image.shape[:2]
        input_w, input_h = self._coreml_input_size

        # BGR → RGB → resize to model input → PIL
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (input_w, input_h), interpolation=cv2.INTER_LINEAR)
        pil_image = Image.fromarray(resized, mode="RGB")

        # Inference
        prediction = self.model.predict({"image": pil_image})

        # Extract depth map (first output key)
        output_key = list(prediction.keys())[0]
        depth_map = prediction[output_key]

        # Convert PIL Image to numpy if needed
        if isinstance(depth_map, Image.Image):
            depth_map = np.array(depth_map)

        depth_map = np.array(depth_map)
        if depth_map.ndim > 2:
            depth_map = np.squeeze(depth_map)

        # Normalize → uint8 → colormap → resize back
        depth_norm = (depth_map - depth_map.min()) / (depth_map.max() - depth_map.min() + 1e-8)
        depth_uint8 = (depth_norm * 255).astype(np.uint8)
        depth_colored = cv2.applyColorMap(depth_uint8, self.colormap_id)
        depth_colored = cv2.resize(depth_colored, (original_w, original_h))

        return depth_colored

    def _infer_pytorch(self, image):
        """Run PyTorch inference and return colorized depth map (BGR, original size)."""
        import torch
        import cv2
        import numpy as np

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        with torch.no_grad():
            depth = self.model.infer_image(rgb)

        d_min, d_max = depth.min(), depth.max()
        depth_norm = ((depth - d_min) / (d_max - d_min + 1e-8) * 255).astype(np.uint8)
        depth_colored = cv2.applyColorMap(depth_norm, self.colormap_id)

        return depth_colored

    def _infer_onnx(self, image):
        """Run ONNX Runtime inference and return colorized depth map."""
        import cv2
        import numpy as np

        original_h, original_w = image.shape[:2]
        input_h, input_w = self._ort_input_size

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (input_w, input_h), interpolation=cv2.INTER_LINEAR)
        img_float = resized.astype(np.float32) / 255.0

        # ImageNet normalization
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        img_float = (img_float - mean) / std

        # HWC → NCHW
        img_nchw = np.transpose(img_float, (2, 0, 1))[np.newaxis].astype(np.float32)

        # Run inference
        outputs = self._ort_session.run(None, {self._ort_input_name: img_nchw})
        depth = outputs[0]
        depth = np.squeeze(depth)

        # Normalize → uint8 → colormap → resize back
        d_min, d_max = depth.min(), depth.max()
        depth_norm = ((depth - d_min) / (d_max - d_min + 1e-8) * 255).astype(np.uint8)
        depth_colored = cv2.applyColorMap(depth_norm, self.colormap_id)
        depth_colored = cv2.resize(depth_colored, (original_w, original_h))

        return depth_colored

    def _infer_tensorrt(self, image):
        """Run TensorRT FP16 inference and return colorized depth map."""
        import torch
        import cv2
        import numpy as np

        original_h, original_w = image.shape[:2]
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        resized = cv2.resize(rgb, (518, 518), interpolation=cv2.INTER_LINEAR)
        img_float = resized.astype(np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        img_float = (img_float - mean) / std
        img_nchw = np.transpose(img_float, (2, 0, 1))[np.newaxis]

        self._trt_input_tensor.copy_(torch.from_numpy(img_nchw))
        self._trt_context.execute_async_v3(self._trt_stream)
        torch.cuda.synchronize()

        depth = self._trt_output_tensor.cpu().numpy()
        depth = np.squeeze(depth)

        d_min, d_max = depth.min(), depth.max()
        depth_norm = ((depth - d_min) / (d_max - d_min + 1e-8) * 255).astype(np.uint8)
        depth_colored = cv2.applyColorMap(depth_norm, self.colormap_id)
        depth_colored = cv2.resize(depth_colored, (original_w, original_h))

        return depth_colored

    # ── Config updates ────────────────────────────────────────────────

    def on_config_update(self, config: dict):
        """Handle live config updates from Aegis."""
        if "colormap" in config:
            self.colormap_id = COLORMAP_MAP.get(config["colormap"], self.colormap_id)
            _log(f"Colormap updated: {config['colormap']}", self._tag)
        if "opacity" in config:
            self.opacity = float(config["opacity"])
            _log(f"Opacity updated: {self.opacity}", self._tag)
        if "blend_mode" in config:
            self.blend_mode = config["blend_mode"]
            _log(f"Blend mode updated: {self.blend_mode}", self._tag)




if __name__ == "__main__":
    DepthEstimationSkill().run()
