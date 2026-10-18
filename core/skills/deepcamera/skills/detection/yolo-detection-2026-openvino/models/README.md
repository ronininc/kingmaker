# Pre-exported YOLO 2026 Nano model for OpenVINO
#
# Place your exported model directory here:
#   yolo26n_openvino_model/
#     ├── yolo26n.xml
#     └── yolo26n.bin
#
# To export your own:
#   python -c "from ultralytics import YOLO; YOLO('yolo26n.pt').export(format='openvino', imgsz=640, half=True)"
#
# Or use the Colab script: scripts/compile_model_colab.py
#
# Note: Unlike Edge TPU compilation, OpenVINO export runs on ANY platform.
# If no model is found, detect.py will auto-download yolo26n.pt and export at runtime.
