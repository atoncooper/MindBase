#!/usr/bin/env python3
"""Local OpenAI-compatible ASR server backed by faster-whisper.

Spawned and managed by the Rust desktop app (`whisper_server.rs`) when the
local ASR mode is selected in API 设置; killed on app exit. Speaks just
enough of the OpenAI audio API for `AsrClient`'s OpenAI-compatible mode:

  GET  /health                  -> {"server": "mindbase-whisper", ...}
  GET  /v1/models               -> {"data": [{"id": "<model>"}]}
  POST /v1/audio/transcriptions -> multipart(file[, model]) -> {"text": ...}

The whisper model loads in a background thread at startup, downloading its
weights from HuggingFace on first use into the app data dir (`--hf-home`).
huggingface.co is probed before importing faster-whisper; when unreachable
(mainland networks) the hf-mirror.com mirror is used instead. The HTTP
server itself is ready immediately - transcription requests wait (bounded)
for the model to finish loading, and fail with a clear message if loading
failed.

Requests are serialized with a lock: CPU-bound decoding must not run
concurrently (thread contention would only slow every request down).

Usage:
  python whisper_server.py --host 127.0.0.1 --port 8765 --model small \
      [--hf-home DIR] [--device cpu] [--compute-type int8] [--beam-size 1]

Progress lines are written to stderr so the Rust side can stream them into
the app log. The transcript text of a request is the JSON body, never
stdout.
"""

import argparse
import io
import os
import sys
import threading
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

HF_MIRROR = "https://hf-mirror.com"
SERVER_MARKER = "mindbase-whisper"
# Upper bound a transcription request waits for the model to finish
# downloading/loading (aligned with the Rust ingestion deadline of 600s).
MODEL_READY_TIMEOUT = 600.0


def log(message: str) -> None:
    print("[whisper] %s" % message, file=sys.stderr, flush=True)


class ModelState:
    """Model lifecycle shared between the loader thread and endpoints."""

    def __init__(self, name, hf_home, device, compute_type, beam_size, display_name=None):
        self.name = name
        # /health reports a human-friendly model id: the logical name passed
        # by the Rust launcher when given (the --model arg may be a snapshot
        # directory whose basename is a commit hash), else the basename of a
        # directory path, else the raw name.
        if display_name:
            self.display = display_name
        elif os.path.isdir(name):
            self.display = os.path.basename(name.rstrip("/\\")) or name
        else:
            self.display = name
        self.hf_home = hf_home
        self.device = device
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.model = None
        self.error = None
        self.ready = threading.Event()
        self.lock = threading.Lock()

    def load(self):
        """Load (and if needed download) the model, retrying indefinitely.

        Downloads from the HF CDN drop mid-way often enough (IncompleteRead /
        ReadTimeout) that a fixed attempt count kept failing on flaky links;
        partial files resume, so a periodic retry always converges. The
        server stays up meanwhile - requests just wait on the ready event."""
        self._pick_hf_endpoint()
        attempt = 0
        while True:
            attempt += 1
            try:
                started = time.time()
                # Imported only after the HF env is decided: huggingface_hub
                # reads HF_ENDPOINT at import time.
                from faster_whisper import WhisperModel

                self.model = WhisperModel(
                    self.name,
                    device=self.device,
                    compute_type=self.compute_type,
                    download_root=self.hf_home or None,
                )
                log("模型就绪：%s（加载耗时 %.1fs，第 %d 次尝试）" % (self.display, time.time() - started, attempt))
                self.error = None
                self.ready.set()
                break
            except Exception as exc:  # noqa: BLE001
                self.error = str(exc)
                self.model = None
                log(
                    "模型加载失败（第 %d 次）：%s；30 秒后自动重试（已下载部分会断点续传）"
                    % (attempt, exc)
                )
                time.sleep(30)

    def _pick_hf_endpoint(self):
        """Domestic-first endpoint choice, mirroring the app's other
        provisioning (PyPI mirrors first). The HF main site often answers
        while its us-east CDN stalls mid-download on mainland networks, so
        default to the hf-mirror.com mirror (which proxies the file
        downloads too) unless the user set HF_ENDPOINT themselves.
        Xet is disabled under the mirror: it can fall back to the same
        foreign CDN the mirror exists to avoid. The mirror is also excluded
        from any system proxy: a proxy with an overseas exit makes
        hf-mirror redirect back to the origin, defeating the mirror."""
        if os.environ.get("HF_ENDPOINT"):
            return
        os.environ["HF_ENDPOINT"] = HF_MIRROR
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
        os.environ["NO_PROXY"] = "hf-mirror.com,.hf-mirror.com"
        os.environ["no_proxy"] = "hf-mirror.com,.hf-mirror.com"
        log("未设置 HF_ENDPOINT，默认使用镜像 %s（如需直连官方源请在环境变量中设置）" % HF_MIRROR)

    def wait_ready(self):
        if not self.ready.wait(timeout=MODEL_READY_TIMEOUT):
            raise RuntimeError("模型仍在加载/下载中，请稍后重试")
        if self.error is not None:
            raise RuntimeError("模型不可用：%s" % self.error)

    def transcribe_bytes(self, data: bytes) -> str:
        self.wait_ready()
        with self.lock:
            segments, _info = self.model.transcribe(
                io.BytesIO(data),
                beam_size=self.beam_size,
                vad_filter=True,
                # Whisper 的中文训练语料混有大量繁体（港台字幕等），小模型
                # （small 及以下）解码时尤其容易输出繁体。固定 zh 跳过语种
                # 检测，并用简体前缀做条件引导，把输出锚定在简体上。
                language="zh",
                initial_prompt="以下是普通话的句子。",
            )
            text = "".join(segment.text for segment in segments).strip()
        return text


STATE = None  # assigned in main(); endpoints read it.


def build_app():
    from fastapi import FastAPI, File, Form, UploadFile
    from fastapi.responses import JSONResponse

    app = FastAPI(title="MindBase local ASR")

    @app.get("/health")
    def health():
        return {
            "server": SERVER_MARKER,
            "model": STATE.display,
            "modelReady": STATE.model is not None and STATE.error is None,
            "error": STATE.error,
        }

    @app.get("/v1/models")
    def models():
        return {"data": [{"id": STATE.display, "object": "model", "owned_by": "local"}]}

    @app.post("/v1/audio/transcriptions")
    def transcribe(file: UploadFile = File(...), model: str = Form(default="")):
        data = file.file.read()
        if not data:
            return JSONResponse(
                status_code=400,
                content={"error": {"message": "空音频文件", "type": "invalid_request_error"}},
            )
        if model and model not in (STATE.name, STATE.display):
            log("请求模型 %s 与服务模型 %s 不一致，按服务模型处理" % (model, STATE.display))
        started = time.time()
        try:
            text = STATE.transcribe_bytes(data)
        except RuntimeError as exc:
            return JSONResponse(
                status_code=503,
                content={"error": {"message": str(exc), "type": "model_not_ready"}},
            )
        log("转写完成：%.1fs，%d 字节 -> %d 字符" % (time.time() - started, len(data), len(text)))
        return {"text": text}

    return app


def main():
    global STATE
    ap = argparse.ArgumentParser(description="MindBase local ASR server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", default="small")
    ap.add_argument("--model-name", default="",
                    help="logical model id reported by /health (the --model "
                         "arg may be a snapshot dir with a hash basename)")
    ap.add_argument("--hf-home", default="")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--beam-size", type=int, default=1)
    args = ap.parse_args()

    if args.hf_home:
        os.environ.setdefault("HF_HOME", args.hf_home)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    STATE = ModelState(
        args.model, args.hf_home, args.device, args.compute_type, args.beam_size,
        display_name=args.model_name or None,
    )
    threading.Thread(target=STATE.load, daemon=True).start()

    import uvicorn

    app = build_app()
    log(
        "本地 ASR 服务启动：http://%s:%d（模型 %s 后台加载中，首次会自动下载）"
        % (args.host, args.port, args.model)
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
