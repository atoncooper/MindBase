"""ocr_extract.py — local OCR text extraction for 文件入库 (RapidOCR).

Usage:
    python ocr_extract.py <path> <model_dir> <device>

`model_dir` holds a downloaded bundle (det.onnx / rec.onnx / cls.onnx, see
`ocr_server.rs`); `device` is one of auto / cpu / cuda (auto picks GPU when
the installed onnxruntime exposes a GPU execution provider).

Prints exactly one JSON object on stdout:
    {"ok": true,  "title": "...", "text": "...", "ext": "pdf"}
    {"ok": false, "error": "..."}

Two extraction modes:
  - images (jpg / jpeg / png / bmp / webp): one OCR pass over the picture;
  - pdf: per page, the text layer is used when present, pages without one are
    rendered to bitmaps and OCR'd (scanned-document fallback).

Anything on stderr is diagnostics only — the Rust caller reads stdout and
must never mix the two streams.
"""

import json
import os
import sys

MAX_CHARS = 2_000_000  # keep in sync with doc_extract.py
TITLE_MAX_CHARS = 120
# A page with fewer characters than this is treated as having no usable text
# layer and gets OCR'd (covers scanned pages and header-only pages).
PAGE_TEXT_MIN_CHARS = 32
IMAGE_EXTS = {"jpg", "jpeg", "png", "bmp", "webp"}
PDF_EXTS = {"pdf"}


class ScriptError(Exception):
    """Fatal extraction problem; the message is user-facing."""


def _ocr_engine(model_dir, device):
    """Build a RapidOCR engine from the local bundle, preferring GPU when asked.

    auto/cuda try the GPU execution providers the installed onnxruntime
    actually exposes (CUDA for onnxruntime-gpu, DML for onnxruntime-directml);
    any failure at engine construction degrades to CPU instead of failing the
    whole extraction.
    """
    for name in ("det.onnx", "rec.onnx", "cls.onnx"):
        if not os.path.isfile(os.path.join(model_dir, name)):
            raise ScriptError(
                f"本地 OCR 模型不完整（缺 {name}）：请在「API 设置 → 本地 OCR 模型」卡片重新下载"
            )
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as exc:
        raise ScriptError("缺少 OCR 依赖（rapidocr-onnxruntime），请重启应用让其自动安装") from exc

    kwargs = {
        "det_model_path": os.path.join(model_dir, "det.onnx"),
        "rec_model_path": os.path.join(model_dir, "rec.onnx"),
        "cls_model_path": os.path.join(model_dir, "cls.onnx"),
    }

    def gpu_providers():
        try:
            import onnxruntime

            return set(onnxruntime.get_available_providers())
        except Exception:  # noqa: BLE001 — probing must never kill extraction
            return set()

    providers = gpu_providers()
    attempts = [kwargs.copy()]
    if device == "cuda" or (device == "auto" and "CUDAExecutionProvider" in providers):
        gpu = kwargs.copy()
        gpu.update({"det_use_cuda": True, "rec_use_cuda": True, "cls_use_cuda": True})
        attempts.insert(0, gpu)
    elif device == "auto" and "DmlExecutionProvider" in providers:
        dml = kwargs.copy()
        dml.update({"det_use_dml": True, "rec_use_dml": True, "cls_use_dml": True})
        attempts.insert(0, dml)

    last_err = None
    for attempt in attempts:
        try:
            return RapidOCR(**attempt)
        except Exception as exc:  # noqa: BLE001 — GPU setup can fail late
            last_err = exc
            if attempt is attempts[-1]:
                break
            print(f"[ocr] GPU 初始化失败，回退 CPU：{exc}", file=sys.stderr)
    raise ScriptError(f"OCR 引擎初始化失败：{last_err}")


def _ocr_image_data(engine, data):
    """OCR one RGB numpy image (h, w, 3); returns the recognized lines."""
    import numpy as np

    rgb = np.asarray(data)
    # RapidOCR follows the cv2 convention: ndarray input is BGR.
    bgr = rgb[..., ::-1]
    result, _ = engine(bgr)
    lines = []
    for item in result or []:
        try:
            _box, text, score = item
        except (TypeError, ValueError):
            continue
        text = str(text).strip()
        if text and float(score) >= 0.5:
            lines.append(text)
    return lines


def _ocr_image_file(engine, path):
    from PIL import Image

    try:
        with Image.open(path) as image:
            rgb = image.convert("RGB")
    except Exception as exc:  # noqa: BLE001 — corrupt images are user data
        raise ScriptError(f"无法读取图片：{exc}") from exc
    return _ocr_image_data(engine, __import__("numpy").array(rgb))


def ocr_pdf(engine, path):
    """Extract text from a PDF, OCR-ing pages without a usable text layer."""
    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz  # legacy shim, pymupdf < 1.26
        except ImportError as exc:
            raise ScriptError("缺少 PDF 解析依赖（pymupdf），请重启应用让其自动安装") from exc
    try:
        doc = fitz.open(path)
    except Exception as exc:
        raise ScriptError(f"无法打开 PDF：{exc}") from exc

    import numpy as np

    pages = []
    ocr_page_count = 0
    try:
        meta_title = ""
        try:
            meta_title = (doc.metadata or {}).get("title") or ""
        except Exception:
            pass
        for page in doc:
            text = page.get_text("text").strip()
            if len(text) >= PAGE_TEXT_MIN_CHARS:
                pages.append(text)
                continue
            # No usable text layer: render ~2x zoom and OCR the bitmap.
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, 3
            )
            lines = _ocr_image_data(engine, rgb)
            ocr_page_count += 1
            pages.append("\n".join(lines))
    finally:
        doc.close()

    body = "\n\n".join(part.strip() for part in pages if part and part.strip())
    if not body.strip():
        raise ScriptError("该 PDF 经 OCR 后仍未识别到文字")
    if ocr_page_count:
        print(f"[ocr] {os.path.basename(path)}: OCR 页数 {ocr_page_count}", file=sys.stderr)
    title = meta_title.strip() or ""
    if not title:
        for line in body.splitlines():
            stripped = line.strip()
            if stripped:
                title = stripped[:TITLE_MAX_CHARS]
                break
    return title or os.path.splitext(os.path.basename(path))[0][:TITLE_MAX_CHARS], body


def ocr_image(engine, path):
    lines = _ocr_image_file(engine, path)
    text = "\n".join(lines).strip()
    if not text:
        raise ScriptError("图片中未识别到文字")
    title = lines[0][:TITLE_MAX_CHARS] if lines else ""
    return title or os.path.splitext(os.path.basename(path))[0][:TITLE_MAX_CHARS], text


def main():
    # Windows pipes default to the console codepage; always emit UTF-8.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — older/odd stdio wrappers
        pass
    if len(sys.argv) != 4:
        print(json.dumps({"ok": False, "error": "参数错误：需要 <path> <model_dir> <device>"}, ensure_ascii=False))
        return 2
    path, model_dir, device = sys.argv[1], sys.argv[2], sys.argv[3].strip().lower() or "auto"
    try:
        if not os.path.isfile(path):
            raise ScriptError(f"文件不存在：{path}")
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        if ext in IMAGE_EXTS:
            engine = _ocr_engine(model_dir, device)
            title, text = ocr_image(engine, path)
        elif ext in PDF_EXTS:
            engine = _ocr_engine(model_dir, device)
            title, text = ocr_pdf(engine, path)
        else:
            raise ScriptError(f"OCR 不支持的文件类型：{ext or '(无扩展名)'}")
        text = text[:MAX_CHARS]
        if not text.strip():
            raise ScriptError("未提取到任何文本内容")
        print(json.dumps({"ok": True, "title": title, "text": text, "ext": ext}, ensure_ascii=False))
        return 0
    except ScriptError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    except Exception as exc:  # noqa: BLE001 — the boundary must never crash raw
        print(json.dumps({"ok": False, "error": f"OCR 解析失败：{exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
