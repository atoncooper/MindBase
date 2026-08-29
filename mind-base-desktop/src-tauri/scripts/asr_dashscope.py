#!/usr/bin/env python3
"""DashScope ASR worker — scheduled by the Rust desktop app.

Why a Python script instead of the hand-rolled Rust implementation:
the official DashScope SDK (`OssUtils.upload`) correctly handles the
getPolicy / OSS PostObject handshake (accessid/host/dir/callback, field
naming and encoding), which the Rust side kept failing with HTTP 403. This
script mirrors `app/services/asr.py` (the verified backend implementation):

  1. upload the local audio to DashScope's temp OSS via the official SDK;
  2. submit an async Transcription task over HTTP;
  3. poll `GET /tasks/{task_id}` until SUCCEEDED/FAILED;
  4. download the result JSON from `output.results[].transcription_url`;
  5. join `transcripts[].text` and print it on stdout.

Only the official `dashscope` package is required for the upload step; the
transcription uses the standard library (urllib) so no extra deps are needed.

Usage:
    python asr_dashscope.py --file <audio> --api-key <key> \
        [--base-url <url>] [--model <model>]

The transcript text is written to stdout (a trailing newline). Any error is
written to stderr and the process exits non-zero.
"""

import argparse
import json
import os
import sys
import time
import urllib.request

# Force UTF-8 for stdout/stderr so the Rust caller reads non-ASCII cleanly.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

DEFAULT_BASE = "https://dashscope.aliyuncs.com/api/v1"
DEFAULT_MODEL = "paraformer-v2"
POLL_INTERVAL = 1.5
DEFAULT_TIMEOUT = 600


def _get_output_value(output, key, default=None):
    if not isinstance(output, dict):
        return default
    return output.get(key, default)


def _request(url, payload=None, api_key=None, extra_headers=None, timeout=30):
    """urllib wrapper returning parsed JSON."""
    headers = {"Accept": "application/json; charset=utf-8"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    if extra_headers:
        headers.update(extra_headers)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    if not raw.strip():
        return {}
    return json.loads(raw)


def submit_task(base_url, oss_url, api_key, model):
    """Submit an async Transcription task; return the task id or raise."""
    url = base_url + "/services/audio/asr/transcription"
    payload = {
        "model": model,
        "input": {"file_urls": [oss_url]},
        "parameters": {"language_hints": ["zh", "en"]},
    }
    data = _request(
        url,
        payload=payload,
        api_key=api_key,
        extra_headers={"X-DashScope-Async": "enable"},
        timeout=30,
    )
    task_id = data.get("task_id")
    if not task_id:
        output = data.get("output")
        if isinstance(output, dict):
            task_id = output.get("task_id")
    if not task_id:
        raise RuntimeError("ASR 提交失败：未返回 task_id (%r)" % (data,))
    return task_id


def fetch_task(base_url, task_id, api_key):
    """Fetch the task output dict (unwrapped from the `output` envelope)."""
    data = _request(base_url + "/tasks/" + task_id, api_key=api_key, timeout=30)
    if isinstance(data, dict) and isinstance(data.get("output"), dict):
        return data["output"]
    return data if isinstance(data, dict) else None


def download_transcription(url):
    """Download the result JSON and join transcripts[].text."""
    data = _request(url, timeout=30)
    texts = []
    for item in data.get("transcripts", []) or []:
        t = (item.get("text") or "").strip()
        if t:
            texts.append(t)
            continue
        for s in item.get("sentences", []) or []:
            st = (s.get("text") or "").strip()
            if st:
                texts.append(st)
    if not texts and isinstance(data.get("text"), str):
        st = data["text"].strip()
        if st:
            texts.append(st)
    return "\n".join(texts).strip()


def transcribe_restful(base_url, oss_url, api_key, model, timeout=DEFAULT_TIMEOUT):
    """Submit + poll + fetch the transcript for an oss:// url."""
    task_id = submit_task(base_url, oss_url, api_key, model)
    sys.stderr.write("[asr-progress] 异步转写任务已提交：%s\n" % (task_id,))
    start = time.time()
    last_progress = 0
    output = None
    while True:
        if time.time() - start > timeout:
            raise RuntimeError("转写任务超时")
        output = fetch_task(base_url, task_id, api_key)
        if not output:
            time.sleep(POLL_INTERVAL)
            continue
        status = _get_output_value(output, "task_status")
        elapsed = int(time.time() - start)
        if elapsed - last_progress >= 15:
            sys.stderr.write("[asr-progress] 转写中 %ds（%s）\n" % (elapsed, status))
            last_progress = elapsed
        if status in ("SUCCEEDED", "FAILED"):
            break
        time.sleep(POLL_INTERVAL)

    if _get_output_value(output, "task_status") == "FAILED":
        message = (
            _get_output_value(output, "message")
            or _get_output_value(output, "status_message")
            or "未知错误"
        )
        raise RuntimeError("转写失败：%s" % (message,))
    sys.stderr.write("[asr-progress] 转写完成，获取结果\n")
    for item in _get_output_value(output, "results", []) or []:
        if item.get("subtask_status") == "SUCCEEDED" and item.get("transcription_url"):
            return download_transcription(item["transcription_url"])
    raise RuntimeError("未返回有效转写结果")


def _clean_pip_script_residue():
    """Remove leftover `*.deleteme` files pip left in the Scripts dir — the
    classic cause of 'Could not install packages ... .deleteme' on Windows."""
    import glob

    scripts = os.path.join(sys.prefix, "Scripts")
    removed = 0
    for pattern in ("*.deleteme", "*.exe.deleteme"):
        for path in glob.glob(os.path.join(scripts, pattern)):
            try:
                os.remove(path)
                removed += 1
            except OSError:
                pass
    return removed


def _pip_install(py, extra_args):
    import subprocess

    cmd = [py, "-m", "pip", "install", "--quiet"] + extra_args + ["dashscope"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=300)
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
    if r.returncode == 0:
        return True, ""
    return False, (r.stderr or b"").decode("utf-8", "replace")[:800]


def _ensure_dashscope():
    """Import dashscope; if missing, auto-install it via pip."""
    try:
        import dashscope  # noqa: F401
        return
    except ImportError:
        pass
    sys.stderr.write("检测到未安装 dashscope，正在自动安装（pip install dashscope）...\n")

    removed = _clean_pip_script_residue()
    if removed:
        sys.stderr.write("已清理 pip 残留文件 %d 个。\n" % removed)

    candidates = [sys.executable, "python", "py"]
    last_err = ""
    for py in candidates:
        # Strategy 1: plain install.
        ok, err = _pip_install(py, [])
        if ok:
            last_err = ""
            break
        last_err = err
        # Strategy 2: ignore installed (skips broken existing packages that
        # block the Scripts-dir rewrite, e.g. a stale pygmentize.exe).
        ok, err = _pip_install(py, ["--ignore-installed"])
        if ok:
            last_err = ""
            break
        last_err = err
    else:
        raise RuntimeError(
            "未能自动安装 dashscope。请手动执行以下修复后重试：\n"
            "  1) 删除 pip 损坏残留：\n"
            "     del \"%s\"\n"
            "     del \"%s\"\n"
            "  2) 重新安装：\n"
            "     \"%s\" -m pip install --ignore-installed dashscope\n"
            "  失败原因：%s"
            % (
                os.path.join(sys.prefix, "Scripts", "pygmentize.exe"),
                os.path.join(sys.prefix, "Scripts", "pygmentize.exe.deleteme"),
                sys.executable,
                last_err or "未知",
            )
        )

    import importlib

    try:
        importlib.import_module("dashscope")
        sys.stderr.write("dashscope 安装成功。\n")
    except ImportError as exc:  # noqa: BLE001
        raise RuntimeError("dashscope 已安装但无法导入：%s" % (exc,))


def upload_to_oss(file_path, api_key, model):
    """Upload a local file to DashScope's temp OSS using the official SDK."""
    _ensure_dashscope()
    from dashscope.utils.oss_utils import OssUtils
    return OssUtils.upload(model=model, file_path=file_path, api_key=api_key)


def main():
    ap = argparse.ArgumentParser(description="DashScope ASR worker")
    ap.add_argument("--file", required=True, help="local audio file path")
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    args = ap.parse_args()

    if not os.path.exists(args.file):
        sys.stderr.write("音频文件不存在：%s\n" % (args.file,))
        return 2

    base = args.base_url.rstrip("/")
    try:
        oss_url = upload_to_oss(args.file, args.api_key, args.model)
        sys.stderr.write("[asr-progress] 上传完成：%s\n" % (oss_url,))
        text = transcribe_restful(base, oss_url, args.api_key, args.model, args.timeout)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("ASR 脚本失败：%s\n" % (exc,))
        return 1

    print(text, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
