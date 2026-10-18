# ─── OpenVINO Detection — Runtime Image ───────────────────────────────────────
# Uses official Intel OpenVINO runtime image (includes GPU drivers).
# Built locally on user's machine.
#
# Build:  docker build -t aegis-openvino-detect .
# Run:    docker run -i --rm --device /dev/dri --device /dev/bus/usb \
#           -v /tmp/aegis_detection:/tmp/aegis_detection \
#           aegis-openvino-detect

FROM openvino/ubuntu22_runtime:latest

USER root

# ─── System dependencies ─────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pip \
        usbutils \
        libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# ─── Python dependencies ─────────────────────────────────────────────────────
COPY requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir -r /app/requirements.txt

# ─── Application code ────────────────────────────────────────────────────────
COPY scripts/ /app/scripts/
COPY models/ /app/models/

WORKDIR /app

# ─── Shared volume for frame exchange ────────────────────────────────────────
VOLUME ["/tmp/aegis_detection"]

ENV PYTHONUNBUFFERED=1

# ─── Entry point ─────────────────────────────────────────────────────────────
ENTRYPOINT ["python3", "scripts/detect.py"]
