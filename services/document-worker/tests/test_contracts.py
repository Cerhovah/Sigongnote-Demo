import unittest
import json
from pathlib import Path
from jsonschema import FormatChecker
from sigongnote_worker.contracts import validate_wire, _schemas

class WireContractsTest(unittest.TestCase):
    def test_generated_formats_never_silently_lose_their_optional_validators(self):
        formats = set()

        def visit(value):
            if isinstance(value, dict):
                if isinstance(value.get("format"), str):
                    formats.add(value["format"])
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        visit(_schemas)
        self.assertTrue(formats)
        for kind in formats:
            with self.subTest(format=kind):
                self.assertIn(kind, FormatChecker().checkers)

    def test_restore_urls_keep_uri_validation_after_dependency_cleanup(self):
        payload = {"state": "recoverable", "ingestion_id": "11111111-1111-4111-8111-111111111111",
                   "revision_id": "22222222-2222-4222-8222-222222222222", "sha256": "a" * 64,
                   "byte_length": 1, "source_generation": 1, "verified_at": "2026-10-09T00:00:00Z",
                   "restore_url": "https://storage.invalid/original.pdf", "expires_in": 60}
        validate_wire("CaptureDurabilityResponse", payload)
        for url in ["relative/file.pdf", "https://invalid host/file"]:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "^INVALID_CONTRACT$"):
                validate_wire("CaptureDurabilityResponse", {**payload, "restore_url": url})

    def test_shared_typescript_python_vectors(self):
        path = Path(__file__).resolve().parents[3] / "fixtures/synthetic/contract-validation.json"
        for vector in json.loads(path.read_text(encoding="utf-8")):
            with self.subTest(label=vector["label"]):
                try:
                    validate_wire(vector["name"], vector["value"])
                    accepted = True
                except ValueError:
                    accepted = False
                self.assertEqual(accepted, vector["accepted"])

    def test_money_uses_strings_and_preserves_unknown(self):
        validate_wire("Money", {"currency": "KRW", "minor": "99999999999999999999", "knowledge": "known"})
        validate_wire("Money", {"currency": "KRW", "minor": None, "knowledge": "unknown"})
        for minor in [0, 0.1, "1e6", "100000000000000000000", None]:
            with self.subTest(minor=minor), self.assertRaisesRegex(ValueError, "^INVALID_CONTRACT$"):
                validate_wire("Money", {"currency": "KRW", "minor": minor, "knowledge": "known"})

    def test_dates_are_real_and_incomplete_dates_stay_incomplete(self):
        validate_wire("SourceDate", {"raw": "6.02", "precision": "unknown", "date": None, "inferred_components": []})
        for date in ["2026-02-29", "2026-02-30"]:
            with self.subTest(date=date), self.assertRaisesRegex(ValueError, "^INVALID_CONTRACT$"):
                validate_wire("SourceDate", {"raw": date, "precision": "day", "date": date, "inferred_components": []})

    def test_unknown_fields_and_names_are_not_permitted(self):
        with self.assertRaisesRegex(ValueError, "^INVALID_CONTRACT$"):
            validate_wire("Money", {"currency": "KRW", "minor": "0", "knowledge": "known", "approved": True})
        with self.assertRaisesRegex(ValueError, "^INVALID_CONTRACT$"):
            validate_wire("SQL", {})
