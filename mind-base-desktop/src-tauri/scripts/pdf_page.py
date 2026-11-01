"""pdf_page.py — render one PDF page to PNG base64 for the file previewer.

Protocol: argv = <pdf path> <page (1-based)> <dpi>; exactly one JSON line on stdout:
    {"ok": true, "base64": "...", "page": 3, "pageCount": 12, "mime": "image/png"}
    {"ok": false, "error": "..."}

Uses pymupdf (imported as fitz), provisioned by the app's python runtime helper.
"""
import base64
import json
import sys

MIN_DPI = 72
MAX_DPI = 200
DEFAULT_DPI = 144


def clamp_dpi(value):
    return max(MIN_DPI, min(MAX_DPI, value))


def render(path, page_number, dpi):
    # pymupdf 1.24+ 提供 pymupdf 模块名；旧版回退 fitz（fitz 名会打印弃用警告）。
    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover - 兼容旧版 pymupdf
        import fitz

    document = fitz.open(path)
    try:
        page_count = document.page_count
        if page_number < 1 or page_number > page_count:
            raise ValueError("页码超出范围（有效范围 1-{0}）".format(page_count))
        page = document.load_page(page_number - 1)
        zoom = clamp_dpi(dpi) / 72.0
        pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        png = pixmap.tobytes("png")
        return {
            "ok": True,
            "base64": base64.b64encode(png).decode("ascii"),
            "page": page_number,
            "pageCount": page_count,
            "mime": "image/png",
        }
    finally:
        document.close()


def main(argv):
    if len(argv) < 4:
        raise ValueError("参数不足：需要 PDF 路径、页码与 DPI")
    page_number = int(argv[2])
    dpi = int(argv[3]) if argv[3].strip() else DEFAULT_DPI
    if page_number < 1:
        raise ValueError("页码必须从 1 开始")
    return render(argv[1], page_number, dpi)


if __name__ == "__main__":
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        exit_payload = main(sys.argv)
    except Exception as error:  # noqa: BLE001 — the protocol reports errors as JSON
        exit_payload = {"ok": False, "error": str(error)}
    print(json.dumps(exit_payload, ensure_ascii=False))
