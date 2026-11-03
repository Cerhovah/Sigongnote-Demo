"""C41 customer copy uses only the approved allowlist and cannot self-learn."""
from __future__ import annotations

import hashlib
import json

import pdfplumber
import pytest

from sigongnote_worker.labor_ledger import ExportBlocked
from sigongnote_worker.quote_pdf import publish_quote_pdf, render_quote_pdf

APPROVAL = "22222222-2222-4222-8222-222222222222"
SNAPSHOT = {
    "quote_id": "11111111-1111-4111-8111-111111111111",
    "revision_id": "33333333-3333-4333-8333-333333333333",
    "kind": "amendment", "trade_pack_id": "wet-trade", "vat_mode": "exclusive",
    "supply_minor": "1250000", "vat_minor": "125000", "total_minor": "1375000",
    "exclusions": ["철거 제외"],
    "scope_lines": [{"id": "44444444-4444-4444-8444-444444444444",
                     "display_name": "타일 시공", "quantity_value": "35", "unit_code": "m2",
                     "operation": "replace", "supply_minor": "1250000",
                     "previous_quantity_value": "30", "resulting_quantity_value": "35"}],
}


def snapshot_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def test_customer_quote_pdf_is_allowlisted_and_atomic(tmp_path):
    digest = snapshot_hash(SNAPSHOT)
    manifest = publish_quote_pdf(tmp_path, SNAPSHOT, APPROVAL, digest)
    assert manifest["audience"] == "customer" and not manifest["delivery_verified"]
    assert publish_quote_pdf(tmp_path, SNAPSHOT, APPROVAL, digest) == manifest
    pdf = tmp_path / APPROVAL / "quote.pdf"
    assert pdf.read_bytes().startswith(b"%PDF-")
    with pdfplumber.open(pdf) as document:
        text = "\n".join(page.extract_text() or "" for page in document.pages)
    for value in ("변경 견적서", "타일 시공", "30", "35", "1,250,000", "철거 제외"):
        assert value in text
    assert "원가" not in text and "마진" not in text and "자재상" not in text
    with pytest.raises(ExportBlocked, match="QUOTE_SNAPSHOT_MISMATCH"):
        render_quote_pdf({**SNAPSHOT, "internal_cost": "1000000"}, APPROVAL, digest)
    pdf.write_bytes(b"tampered")
    with pytest.raises(ExportBlocked, match="QUOTE_OUTPUT_CONFLICT"):
        publish_quote_pdf(tmp_path, SNAPSHOT, APPROVAL, digest)
