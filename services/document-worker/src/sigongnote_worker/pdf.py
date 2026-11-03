"""Page-grounded PDF extraction. OCR and repeated tables remain candidates only."""
from __future__ import annotations

import csv
import hashlib
import io
import os
import shutil
import subprocess
from pathlib import Path

import pdfplumber
from pypdf import PdfReader, PdfWriter
from pdfminer.pdfdocument import PDFPasswordIncorrect
from pdfplumber.utils.exceptions import PdfminerException

VERSION = "pdf-structure/1.2.0"
MAX_INPUT = 200 * 1024 * 1024
MAX_PAGES = 200
CHUNK_PAGES = 20
OCR_DPI = 150
MAX_RENDER_PIXELS = 20_000_000


def _bbox(values) -> list[float]:
    return [round(float(value), 2) for value in values]


def _tesseract_path() -> str | None:
    configured = os.getenv("SIGONGNOTE_TESSERACT")
    if configured:
        return configured if Path(configured).is_file() else None
    found = shutil.which("tesseract")
    if found:
        return found
    if os.name == "nt":
        fallback = Path(os.getenv("PROGRAMFILES", "C:/Program Files")) / "Tesseract-OCR/tesseract.exe"
        return str(fallback) if fallback.is_file() else None
    return None


def _tessdata_dir() -> str | None:
    configured = os.getenv("SIGONGNOTE_TESSDATA_DIR")
    if configured:
        return configured if Path(configured).is_dir() else None
    local = os.getenv("LOCALAPPDATA")
    if local:
        fallback = Path(local) / "Sigongnote/tessdata"
        if (fallback / "kor.traineddata").is_file() and (fallback / "eng.traineddata").is_file():
            return str(fallback)
    return None


class LocalTesseract:
    """Offline OCR; no PDF or image bytes are sent to a service."""

    def __init__(self, executable: str | None = None, tessdata_dir: str | None = None):
        self.executable = executable or _tesseract_path()
        self.tessdata_dir = tessdata_dir or _tessdata_dir()

    def words(self, png: bytes, page: int, scale: float) -> list[dict]:
        if not self.executable:
            raise RuntimeError("OCR_ENGINE_UNAVAILABLE")
        command = [self.executable, "stdin", "stdout", "-l", "kor+eng"]
        if self.tessdata_dir:
            command.extend(["--tessdata-dir", self.tessdata_dir])
        # Explicit output switches avoid relying on the installation's configs/tsv
        # when tessdata is held in an app-private user directory.
        command.extend(["-c", "tessedit_create_tsv=1", "-c", "tessedit_create_txt=0"])
        try:
            process = subprocess.run(command, input=png, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, timeout=60, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError("OCR_EXECUTION_FAILED") from exc
        if process.returncode:
            raise RuntimeError("OCR_ENGINE_FAILED")
        words = []
        for row in csv.DictReader(io.StringIO(process.stdout.decode("utf-8-sig")), delimiter="\t"):
            text = row.get("text", "").strip()
            if not text:
                continue
            try:
                x = float(row["left"]) * scale
                y = float(row["top"]) * scale
                width = float(row["width"]) * scale
                height = float(row["height"]) * scale
                confidence = float(row["conf"])
            except (KeyError, ValueError):
                continue
            words.append({"text": text, "bbox": _bbox((x, y, x + width, y + height)),
                          "confidence": confidence, "locator": f"page:{page}/ocr:{len(words)}",
                          "source": "ocr_candidate"})
        return words


def _ocr_page(page, number: int, engine: LocalTesseract) -> list[dict]:
    scale = OCR_DPI / 72
    if page.width * page.height * scale * scale > MAX_RENDER_PIXELS:
        raise RuntimeError("OCR_RENDER_LIMIT")
    image = page.to_image(resolution=OCR_DPI).original
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    words = engine.words(stream.getvalue(), number, 1 / scale)
    # pdfplumber coordinates use the rotated display page's top-left origin.
    # to_image renders the CropBox, so its local OCR points need the CropBox
    # offset. Rotation is already applied by both pdfplumber and the renderer.
    x_origin, y_origin = page.cropbox[:2]
    for word in words:
        x0, y0, x1, y1 = word["bbox"]
        word["bbox"] = _bbox((x0 + x_origin, y0 + y_origin,
                              x1 + x_origin, y1 + y_origin))
        word["coordinate_space"] = "rotated_page_top_left_points"
    return words


def _table(page, table, number: int, index: int) -> dict:
    locator = f"page:{number}/table:{index}"
    matrix = table.extract()
    cells = []
    for row_index, row in enumerate(table.rows):
        for col_index, bounds in enumerate(row.cells):
            if bounds is None:
                continue
            text = matrix[row_index][col_index] if row_index < len(matrix) and col_index < len(matrix[row_index]) else None
            cells.append({"row": row_index, "col": col_index, "text": text,
                          "bbox": _bbox(bounds),
                          "locator": f"{locator}/cell:{row_index},{col_index}"})
    fingerprint = hashlib.sha256(repr(matrix).encode("utf-8")).hexdigest()
    return {"locator": locator, "bbox": _bbox(table.bbox), "rows": len(table.rows),
            "cols": max((len(row.cells) for row in table.rows), default=0),
            "cells": cells, "representation_fingerprint": fingerprint,
            "repeated_representation_of": None, "aggregation_safe": False}


def _images(page, number: int) -> list[dict]:
    return [{"locator": f"page:{number}/image:{index}",
             "bbox": _bbox((image["x0"], image["top"], image["x1"], image["bottom"]))}
            for index, image in enumerate(page.images)]


def _parse_page(page, number: int, chunk: int, engine: LocalTesseract,
                repeated: dict[str, str], coverage: dict, issues: list[dict]) -> dict:
    locator = f"page:{number}"
    entry = {"number": number, "locator": locator, "chunk": chunk,
             "width": round(page.width, 2), "height": round(page.height, 2),
             "rotation": page.rotation, "cropbox": _bbox(page.cropbox),
             "coordinate_space": "rotated_page_top_left_points",
             "words": [], "tables": [], "images": _images(page, number),
             "status": "complete", "text_source": "embedded"}
    try:
        if len(page.chars) > 100_000:
            raise RuntimeError("PDF_PAGE_TEXT_LIMIT")
        for word in page.extract_words():
            if len(entry["words"]) >= 100_000:
                raise RuntimeError("PDF_PAGE_WORD_LIMIT")
            entry["words"].append({"text": word["text"],
                                   "bbox": _bbox((word["x0"], word["top"], word["x1"], word["bottom"])),
                                   "locator": f"{locator}/word:{len(entry['words'])}",
                                   "source": "embedded"})
        if entry["words"]:
            tables = page.find_tables()
            if len(tables) > 100:
                raise RuntimeError("PDF_PAGE_TABLE_LIMIT")
            for index, table in enumerate(tables):
                item = _table(page, table, number, index)
                previous = repeated.setdefault(item["representation_fingerprint"], item["locator"])
                if previous != item["locator"]:
                    item["repeated_representation_of"] = previous
                entry["tables"].append(item)
            # A readable text layer does not prove that a large image
            # region has no additional text or quantities.
            if any((image["bbox"][2] - image["bbox"][0]) *
                   (image["bbox"][3] - image["bbox"][1]) >
                   page.width * page.height * 0.2 for image in entry["images"]):
                entry["status"] = "partial"
                issues.append({"code": "image_region_unread",
                               "locator": locator})
        else:
            entry["text_source"] = "ocr_candidate"
            coverage["pages_ocr_attempted"] += 1
            entry["words"] = _ocr_page(page, number, engine)
            coverage["pages_ocr_read"] += 1
            entry["status"] = "partial"  # OCR is not verified source text.
            if not entry["words"]:
                raise RuntimeError("OCR_EMPTY")
        coverage["pages_read"] += 1
    except Exception as exc:
        entry["status"] = "partial"
        code = (str(exc) if isinstance(exc, RuntimeError) and
                str(exc).isupper() and str(exc).replace("_", "").isalpha()
                else type(exc).__name__)
        issues.append({"code": code, "locator": locator})
    return entry


def parse_pdf(path: str | Path, ocr: LocalTesseract | None = None,
              start_page: int = 1, page_limit: int | None = None) -> dict:
    limit = MAX_PAGES if page_limit is None else page_limit
    if type(start_page) is not int or start_page < 1 or type(limit) is not int or not 1 <= limit <= MAX_PAGES:
        raise ValueError("INVALID_PDF_PAGE_RANGE")
    path = Path(path)
    with path.open("rb") as source:
        signature = source.read(5)
    if path.stat().st_size > MAX_INPUT or signature != b"%PDF-":
        raise ValueError("INVALID_PDF_ENVELOPE")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    result = {"source_sha256": digest,
              "format": "pdf", "parser_version": VERSION, "status": "failed",
              "supported_scope": "page text coordinates, ruled tables, image-only OCR candidates",
              "pages": [], "issues": [], "coverage": {"pages_seen": 0, "pages_read": 0,
                                               "pages_ocr_attempted": 0, "pages_ocr_read": 0,
                                               "page_start": start_page, "pages_processed": start_page - 1,
                                               "pages_partial": 0},
              "chunk_pages": CHUNK_PAGES}
    page_offset = 0
    original_count = None
    try:
        document = pdfplumber.open(str(path))
        # Some older Korean print-to-PDF files have a catalog reference that
        # pdfminer cannot resolve, despite a readable page tree. Recover only
        # in memory, preserve the original hash, and mark the result partial.
        if not document.doc.catalog:
            document.close()
            reader = PdfReader(str(path), strict=False)
            original_count = len(reader.pages)
            if original_count and start_page > original_count:
                raise ValueError("INVALID_PDF_PAGE_RANGE")
            buffer = io.BytesIO()
            writer = PdfWriter()
            for index in range(start_page - 1, min(original_count, start_page - 1 + limit)):
                writer.add_page(reader.pages[index])
            writer.write(buffer)
            buffer.seek(0)
            document = pdfplumber.open(buffer)
            page_offset = start_page - 1
            result["issues"].append({"code": "pdf_structure_recovered", "locator": "document"})
    except PDFPasswordIncorrect:
        result["status"] = "encrypted"
        result["issues"].append({"code": "password_required", "locator": "document"})
        return result
    except PdfminerException as exc:
        if isinstance(exc.__cause__ or exc.__context__, PDFPasswordIncorrect):
            result["status"] = "encrypted"
            result["issues"].append({"code": "password_required", "locator": "document"})
            return result
        raise
    with document:
        count = original_count if original_count is not None else len(document.pages)
        result["coverage"]["pages_seen"] = count
        if count and start_page > count:
            raise ValueError("INVALID_PDF_PAGE_RANGE")
        end_page = min(count, start_page - 1 + limit)
        if end_page < count:
            result["status"] = "partial"
            result["issues"].append({"code": "page_limit_exceeded", "locator": "document"})
            result["coverage"]["next_page"] = end_page + 1
        if count == 0:
            result["issues"].append({"code": "empty_pdf", "locator": "document"})
            return result
        repeated: dict[str, str] = {}
        engine = ocr or LocalTesseract()
        for start in range(start_page - 1, end_page, CHUNK_PAGES):
            for number in range(start + 1, min(start + CHUNK_PAGES, end_page) + 1):
                page = document.pages[number - 1 - page_offset]
                entry = _parse_page(page, number, start // CHUNK_PAGES, engine,
                                    repeated, result["coverage"], result["issues"])
                result["pages"].append(entry)
                result["coverage"]["pages_processed"] = number
                result["coverage"]["pages_partial"] += int(entry["status"] != "complete")
                page.close()
    result["status"] = "partial" if result["issues"] or any(page["status"] != "complete" for page in result["pages"]) else "complete"
    return result
