# Pre-compiled YOLO 2026 Nano models for Google Coral Edge TPU

Place compiled `.tflite` files here. They are committed to the repository
so `deploy.bat` and `deploy.sh` can use them without needing a Linux machine.

## Files Expected

| File | Size | Notes |
|------|------|-------|
| `yolo26n_int8_edgetpu.tflite` | ~3–4 MB | Edge TPU compiled (primary) |
| `yolo26n_int8.tflite` | ~3–4 MB | CPU fallback |

## How to Compile

The `edgetpu_compiler` only runs on x86_64 Linux. Use the included Docker
setup to compile from any OS (Windows, macOS, Linux):

```bash
# From the yolo-detection-2026-coral-tpu/ root:
bash docker/compile.sh
```

Or with Docker Compose:
```bash
docker compose -f docker/docker-compose.yml run --rm coral-compiler
```

See `docker/README.md` for full instructions.

## After Compiling

```bash
git add models/*.tflite
git commit -m "feat(coral-tpu): add compiled yolo26n edgetpu model (320x320 INT8)"
git push
```

## Alternative: CPU Fallback

If no EdgeTPU model is present, `deploy.bat` / `deploy.sh` will download
`ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite` as a functional
fallback. This is SSD MobileNet (not YOLO 2026), but confirms the TPU
pipeline works before the YOLO model is compiled.
