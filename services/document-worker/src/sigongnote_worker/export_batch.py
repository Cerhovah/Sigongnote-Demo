"""C37 local export publisher: immutable batch folder, recovery, internal PDF."""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import uuid
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

from .labor_ledger import ExportBlocked, build_labor_ledger

FILES = {"xlsx": "labor-ledger.xlsx", "sidecar": "evidence-sidecar.json",
         "pdf": "internal-packet.pdf", "manifest": "manifest.json"}
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def _encoded(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _font_path() -> Path:
    configured = os.getenv("SIGONGNOTE_PDF_FONT_PATH")
    candidates = [Path(configured)] if configured else [
        Path("C:/Windows/Fonts/malgun.ttf"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf")]
    for candidate in candidates:
        if candidate.is_file() and candidate.suffix.lower() == ".ttf":
            return candidate
    raise ExportBlocked("KOREAN_PDF_FONT_UNAVAILABLE")


def _clean(text: object) -> str:
    return "".join(character for character in str(text)
                   if character >= " " and character not in "\u2028\u2029")[:500]


def build_internal_pdf(snapshot: dict, batch_id: str, source_sha256: str) -> bytes:
    """Internal packet only; no external delivery or customer sharing claim."""
    font_name = "SigongnoteKorean"
    if font_name not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(font_name, str(_font_path())))
    output = io.BytesIO()
    pdf = Canvas(output, pagesize=A4, pageCompression=1)
    pdf.setTitle("시공노트 내부 공임 근거")
    pdf.setAuthor("Sigongnote")
    pdf.setSubject(f"internal export batch {batch_id}")
    pdf.setKeywords(f"sigongnote_generated=true;batch_id={batch_id};audience=internal")
    width, height = A4
    line_y = height - 52

    def line(value: object, size: int = 10) -> None:
        nonlocal line_y
        if line_y < 56:
            pdf.showPage()
            line_y = height - 52
        pdf.setFont(font_name, size)
        text = _clean(value)
        while text and pdfmetrics.stringWidth(text, font_name, size) > width - 92:
            text = text[:-1]
        pdf.drawString(46, line_y, text)
        line_y -= size + 8

    line("공임 정리 · 내부 검토용", 15)
    line(f"배치: {batch_id}")
    line(f"원본 SHA256: {source_sha256}")
    line("장부 표시와 실제 은행 이체 확인은 다릅니다.")
    for bundle in snapshot["bundles"]:
        line("")
        line(f"현장: {bundle['project_label']} / {bundle['work_type']}", 11)
        line(f"일자: {bundle['work_date']}  수량: {bundle['billing_quantity']}{bundle['unit']}")
        line(f"확인 금액: {bundle['amount_minor']}원  지급 근거: {bundle.get('payment_basis', 'unknown')}")
        for item in bundle["work_items"]:
            line(f"  {item['location']}: {item['description']}")
        line(f"원가 건: {bundle['charge_case_id']}")
    pdf.save()
    return output.getvalue()


def _child(root: Path, name: str) -> Path:
    candidate = root / name
    if candidate.resolve().parent != root.resolve():
        raise ExportBlocked("OUTPUT_PATH_ESCAPE")
    return candidate


def _verify_folder(folder: Path, expected_batch: str | None = None) -> dict:
    try:
        manifest = json.loads((folder / FILES["manifest"]).read_text(encoding="utf-8"))
        if (manifest.get("generated_by") != "sigongnote_export" or
                manifest.get("batch_id") != (expected_batch or manifest.get("batch_id"))):
            raise ExportBlocked("EXPORT_MANIFEST_MISMATCH")
        for kind, field in (("xlsx", "output_sha256"), ("sidecar", "sidecar_sha256"),
                            ("pdf", "pdf_sha256")):
            if _sha((folder / FILES[kind]).read_bytes()) != manifest[field]:
                raise ExportBlocked("EXPORT_ARTIFACT_HASH_MISMATCH")
        return manifest
    except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError) as exc:
        raise ExportBlocked("EXPORT_BATCH_INCOMPLETE") from exc


def _commit_directory(source: Path, destination: Path) -> None:
    os.replace(source, destination)


def publish_labor_batch(output_root: Path, batch_id: str, template_path: Path,
                        expected_source_sha256: str, header_fingerprint: str,
                        approved_snapshot: dict, expected_snapshot_sha256: str) -> tuple[Path, dict]:
    """Publish one set by atomic same-volume directory rename; retry returns same set."""
    if not _UUID.fullmatch(batch_id):
        raise ExportBlocked("INVALID_BATCH_ID")
    root = Path(output_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    final = _child(root, batch_id)
    if final.exists():
        previous = _verify_folder(final, batch_id)
        if (previous["source_sha256"] != expected_source_sha256 or
                previous["snapshot_sha256"] != expected_snapshot_sha256):
            raise ExportBlocked("BATCH_ID_CONFLICT")
        return final, previous
    xlsx, sidecar, manifest = build_labor_ledger(
        template_path, expected_source_sha256, header_fingerprint, approved_snapshot,
        expected_snapshot_sha256, batch_id)
    pdf = build_internal_pdf(approved_snapshot, batch_id, expected_source_sha256)
    manifest = {**manifest, "pdf_sha256": _sha(pdf), "audience": "internal",
                "artifact_names": {kind: FILES[kind] for kind in ("xlsx", "sidecar", "pdf")}}
    temp = _child(root, f".{batch_id}.tmp-{uuid.uuid4()}")
    temp.mkdir(exist_ok=False)
    for kind, data in (("xlsx", xlsx), ("sidecar", _encoded(sidecar)),
                       ("pdf", pdf), ("manifest", _encoded(manifest))):
        path = _child(temp, FILES[kind])
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    _verify_folder(temp, batch_id)
    if _sha(Path(template_path).read_bytes()) != expected_source_sha256:
        raise ExportBlocked("SOURCE_CHANGED_DURING_EXPORT")
    try:
        _commit_directory(temp, final)
    except (FileExistsError, PermissionError):
        if not final.exists():
            raise
        previous = _verify_folder(final, batch_id)
        if (previous["source_sha256"] != expected_source_sha256 or
                previous["snapshot_sha256"] != expected_snapshot_sha256):
            raise ExportBlocked("BATCH_ID_CONFLICT")
        return final, previous
    return final, _verify_folder(final, batch_id)


def recover_export_batches(output_root: Path, source_paths: dict[str, Path] | None = None) -> list[dict]:
    """Finalize only batches whose original source can be rechecked after a crash."""
    root = Path(output_root).resolve()
    if not root.is_dir():
        return []
    results = []
    for temp in root.iterdir():
        match = re.fullmatch(r"\.([0-9a-f-]{36})\.tmp-[0-9a-f-]{36}", temp.name)
        if not match or not temp.is_dir():
            continue
        _child(root, temp.name)
        batch_id = match.group(1)
        if not _UUID.fullmatch(batch_id):
            continue
        try:
            manifest = _verify_folder(temp, batch_id)
            final = _child(root, batch_id)
            if final.exists():
                current = _verify_folder(final, batch_id)
                status = "duplicate_temp" if (current["snapshot_sha256"] == manifest[
                    "snapshot_sha256"] and current["source_sha256"] == manifest[
                    "source_sha256"]) else "batch_conflict"
            elif not source_paths or batch_id not in source_paths:
                status = "needs_source_recheck"
            elif _sha(Path(source_paths[batch_id]).read_bytes()) != manifest["source_sha256"]:
                status = "source_changed"
            else:
                _commit_directory(temp, final)
                status = "recovered"
        except (ExportBlocked, OSError):
            status = "incomplete"
        results.append({"batch_id": batch_id, "status": status})
    return results
