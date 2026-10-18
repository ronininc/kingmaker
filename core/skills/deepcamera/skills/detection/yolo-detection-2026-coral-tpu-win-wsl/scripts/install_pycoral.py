import sys
import subprocess
import json

def emit(event_dict):
    print(json.dumps(event_dict), flush=True)

def main():
    py_major = sys.version_info.major
    py_minor = sys.version_info.minor

    emit({"event": "progress", "stage": "build", "message": f"Detected Python {py_major}.{py_minor} — selecting appropriate PyCoral wheel..."})

    if py_major == 3 and py_minor <= 9:
        emit({"event": "progress", "stage": "build", "message": "Installing official Google pycoral 2.0 (Python <=3.9)..."})
        url = "https://google-coral.github.io/py-repo/"
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--extra-index-url", url, "pycoral~=2.0"])
        except subprocess.CalledProcessError:
            print("WARNING: Official pycoral install failed.")
            sys.exit(1)

    elif py_major == 3 and py_minor == 10:
        emit({"event": "progress", "stage": "build", "message": "Installing community pycoral for Python 3.10 (feranick/pycoral)..."})
        url = "https://github.com/feranick/pycoral/releases/download/2.0.0TF2.11.1-1/pycoral-2.0.0-cp310-cp310-win_amd64.whl"
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", url])
        except subprocess.CalledProcessError:
            print("ERROR: Failed to install community wheel for Python 3.10")
            sys.exit(1)

    elif py_major == 3 and py_minor == 11:
        emit({"event": "progress", "stage": "build", "message": "Installing community pycoral for Python 3.11 (feranick/pycoral)..."})
        url = "https://github.com/feranick/pycoral/releases/download/2.0.0TF2.11.1-1/pycoral-2.0.0-cp311-cp311-win_amd64.whl"
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", url])
        except subprocess.CalledProcessError:
            print("ERROR: Failed to install community wheel for Python 3.11")
            sys.exit(1)

    else:
        emit({
            "event": "error", 
            "stage": "build", 
            "message": f"No pre-compiled PyCoral Windows wheels for Python {py_major}.{py_minor}. Please downgrade to Python 3.9, 3.10, or 3.11."
        })
        print(f"ERROR: Unsupported Python version {py_major}.{py_minor} for Edge TPU on Windows.")
        sys.exit(1)

if __name__ == "__main__":
    main()
