#!/usr/bin/env python3
"""Resident transcription service for the Content Library ingestion worker.

FastAPI on 127.0.0.1:3147. Loads faster-whisper large-v3-turbo once and keeps
it warm. GPU (float16) when CUDA is available, otherwise CPU int8 flagged as
"degraded" so /api/health can surface the truth instead of pretending.

Run: /home/gcruise/venvs/media/bin/python scripts/whisper_server.py
"""

import ctypes
import glob
import os
import threading
import time

from fastapi import FastAPI
from pydantic import BaseModel

import ctranslate2


def _preload_cuda_libs() -> None:
    """Preload cuBLAS/cuDNN from the pip nvidia-* wheels so CTranslate2's
    dlopen("libcublas.so.12") resolves even though the venv's lib dirs are
    not on LD_LIBRARY_PATH. dlopen by soname reuses already-loaded images,
    so loading them here by absolute path is sufficient."""
    import site

    candidates: list[str] = []
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        candidates += glob.glob(os.path.join(sp, "nvidia", "*", "lib", "lib*.so*"))
    # Load order matters a little: cublasLt before cublas, cudnn core first.
    for pattern in ("libcublasLt.so", "libcublas.so", "libcudnn.so", "libcudnn_ops.so", "libcudnn_cnn.so"):
        for lib in sorted(c for c in candidates if pattern in os.path.basename(c)):
            try:
                ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass  # optional component; the assert-on-use below stays honest


_preload_cuda_libs()

# Blackwell (RTX 5080) needs CTranslate2 >= 4.5.0. Crash loudly, not subtly.
_ct2 = tuple(int(p) for p in ctranslate2.__version__.split(".")[:2])
assert _ct2 >= (4, 5), f"CTranslate2 {ctranslate2.__version__} too old for Blackwell; need >= 4.5.0"

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
PORT = int(os.environ.get("WHISPER_PORT", "3147"))

app = FastAPI()

state = {
    "ready": False,
    "loading": True,
    "device": None,
    "compute_type": None,
    "degraded": False,
    "error": None,
    "model": MODEL_NAME,
}
_model = None
_lock = threading.Lock()  # serial jobs; one GPU, one queue


def _load_model():
    global _model
    try:
        from faster_whisper import WhisperModel

        device = "cuda"
        compute = "float16"
        try:
            _model = WhisperModel(MODEL_NAME, device=device, compute_type=compute)
        except Exception as gpu_err:  # CUDA missing/broken: honest CPU fallback
            device = "cpu"
            compute = "int8"
            state["degraded"] = True
            state["error"] = f"GPU path failed, running CPU int8: {gpu_err}"
            _model = WhisperModel(MODEL_NAME, device=device, compute_type=compute)
        state["device"] = device
        state["compute_type"] = compute
        state["ready"] = True
    except Exception as err:
        state["error"] = str(err)
    finally:
        state["loading"] = False


threading.Thread(target=_load_model, daemon=True).start()


class TranscribeRequest(BaseModel):
    path: str  # absolute path to an audio file (16k mono wav preferred)
    language: str | None = None
    words: bool = False  # word-level timestamps (Edit Bay animated captions)


@app.get("/health")
def health():
    return state


def _fallback_to_cpu(reason: str) -> bool:
    """GPU inference failed at runtime (e.g. missing CUDA libs). Reload the
    model on CPU int8 and flag degraded so /health tells the truth."""
    global _model
    try:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
        state["device"] = "cpu"
        state["compute_type"] = "int8"
        state["degraded"] = True
        state["error"] = f"GPU inference failed, running CPU int8: {reason[:300]}"
        return True
    except Exception as err:
        state["error"] = f"GPU failed and CPU fallback failed: {err}"
        state["ready"] = False
        return False


@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    if not state["ready"]:
        return {"ok": False, "error": state["error"] or "model still loading"}
    if not os.path.isfile(req.path):
        return {"ok": False, "error": f"file not found: {req.path}"}
    started = time.time()

    def _run():
        segments, info = _model.transcribe(
            req.path,
            language=req.language,
            vad_filter=True,
            beam_size=5,
            word_timestamps=req.words,
        )
        out = []
        for s in segments:
            seg = {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            if req.words and s.words:
                seg["words"] = [
                    {"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word}
                    for w in s.words
                ]
            out.append(seg)
        return out, info

    with _lock:
        try:
            segs, info = _run()
        except Exception as err:
            # Runtime CUDA/lib failures: retry once on CPU rather than dying.
            if state["device"] == "cuda" and _fallback_to_cpu(str(err)):
                try:
                    segs, info = _run()
                except Exception as err2:
                    return {"ok": False, "error": str(err2)}
            else:
                return {"ok": False, "error": str(err)}
    text = " ".join(s["text"] for s in segs).strip()
    return {
        "ok": True,
        "text": text,
        "segments": segs,
        "language": info.language,
        "duration_s": round(info.duration, 2),
        "elapsed_s": round(time.time() - started, 2),
        "degraded": state["degraded"],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
