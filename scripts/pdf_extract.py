#!/usr/bin/env python3
"""One-shot PDF text extraction for the Content Library arXiv pipeline.

Usage: python pdf_extract.py /path/to/paper.pdf
Prints JSON to stdout: {"ok": true, "text": "...", "pages": N}
Runs in the media venv (~/venvs/media) which has PyMuPDF installed.
"""
import json
import sys


def main() -> None:
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: pdf_extract.py <pdf>"}))
        sys.exit(1)
    try:
        import fitz  # PyMuPDF
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"pymupdf not installed: {e}"}))
        sys.exit(1)
    try:
        doc = fitz.open(sys.argv[1])
        parts = []
        for page in doc:
            parts.append(page.get_text("text"))
        text = "\n".join(parts)
        # Cap defensively; the DB column is TEXT but 150k chars is plenty for
        # tagging + search, and keeps prompt slices cheap.
        if len(text) > 150_000:
            text = text[:150_000] + "\n[truncated]"
        print(json.dumps({"ok": True, "text": text, "pages": doc.page_count}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:500]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
