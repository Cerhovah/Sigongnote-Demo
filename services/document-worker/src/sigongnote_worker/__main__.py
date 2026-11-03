"""Private line-delimited parser. No network or source writes; errors omit content."""
import hashlib
import json
import re
import sys
from pathlib import Path

from .hwp import parse_hwp
from .spreadsheet import parse_spreadsheet
from .pdf import parse_pdf
from .media import parse_image
from .evidence import write_evidence, chunk_text


def parse_document(path: Path, pdf_start_page: int = 1, pdf_page_limit: int | None = None) -> dict:
    suffix = path.suffix.lower()
    if suffix in (".hwp", ".hwpx"):
        return parse_hwp(path)
    if suffix in (".xls", ".xlsx"):
        return parse_spreadsheet(path)
    if suffix == ".pdf":
        return parse_pdf(path, start_page=pdf_start_page, page_limit=pdf_page_limit)
    if suffix in (".jpg", ".jpeg", ".png", ".webp"):
        return parse_image(path)
    raw = path.read_bytes()
    result = {"source_sha256": hashlib.sha256(raw).hexdigest(),
              "parser_version": "local-text/1", "status": "unsupported", "spans": [],
              "issues": [{"code": "format_not_readable_locally"}]}
    if suffix in (".txt", ".csv"):
        for encoding in ("utf-8-sig", "cp949"):
            try:
                value = raw.decode(encoding)
                result.update(status="complete", issues=[], spans=[
                    {"locator": f"line:{i + 1}", "text": text}
                    for i, text in enumerate(value.splitlines()) if text.strip()])
                break
            except UnicodeDecodeError:
                continue
    if suffix in (".txt", ".csv"):
        if result["status"] == "unsupported":
            result["issues"] = [{"code": "text_encoding_unsupported"}]
        elif not result["spans"]:
            result.update(status="partial", issues=[{"code": "empty_document"}])
        result["coverage"] = {"lines_read": len(result["spans"])}
    return result


def excerpt(result: dict) -> dict:
    spans = []
    truncated = False
    byte_budget = 2 * 1024 * 1024

    def visit(value):
        nonlocal truncated, byte_budget
        if isinstance(value, dict):
            text = value.get("text")
            locator = value.get("locator")
            if "value" in value and locator and not value.get("formula"):
                text = value.get("raw_numeric") if value.get("kind") == "n" and value.get("raw_numeric") is not None else value["value"]
            if value.get("formula") and locator:
                cached = value.get("raw_numeric") if value.get("raw_numeric") is not None else value.get("cached_value")
                text = (f"저장된 수식값: {cached} (재계산 안 함)" if cached is not None
                        else "수식값 없음 (금액 확인 필요)")
            if text is not None and locator and str(text).strip():
                candidate = {"text": next(chunk_text(str(text)))[1], "locator": next(chunk_text(str(locator), 300))[1]}
                cost = len(json.dumps(candidate, ensure_ascii=False).encode("utf-8")) + 4
                if len(spans) < 1000 and cost <= byte_budget:
                    spans.append(candidate)
                    byte_budget -= cost
                    truncated |= len(str(text)) > len(candidate["text"])
                else:
                    truncated = True
            if "words" in value and locator:
                words = " ".join(str(w.get("text", "")) for w in value["words"])
                for offset in range(0, len(words), 1000):
                    visit({"text": words[offset:offset + 1000], "locator": locator})
            for key, child in value.items():
                if (key != "words" or not locator) and isinstance(child, (dict, list)):
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(result)
    return {"status": result["status"], "sourceHash": result["source_sha256"],
            "parserVersion": result.get("parser_version", "unknown") + "/excerpt-v3", "spans": spans,
            "excerptTruncated": truncated, "coverage": result.get("coverage", {}),
            "issues": list(dict.fromkeys(i["code"] for i in result.get("issues", [])))[:40]}


def main():
    for line in sys.stdin:
        command = None
        try:
            command = json.loads(line)
            if command.get("action") == "audio_prepare":
                from .long_audio import prepare_audio
                response = prepare_audio(Path(command["path"]), Path(command["directory"]), command.get("overlap_ms", 0))
                print(json.dumps(response, ensure_ascii=False), flush=True)
                continue
            result = parse_document(Path(command["path"]), command.get("pdf_start_page", 1), command.get("pdf_page_limit"))
            Path(command["output"]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            if result["status"] == "distributable":
                result["status"] = "unsupported"
            response = excerpt(result)
            if command.get("evidence_output"):
                response["evidence"] = write_evidence(result, Path(command["evidence_output"]))
        except Exception as error:
            try:
                digest = hashlib.sha256(Path(command["path"]).read_bytes()).hexdigest()
            except Exception:
                digest = ""
            # Only bounded machine codes are returned; exception messages may contain source text.
            code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z][A-Z0-9_]{2,79}", str(error)) else "parser_failed"
            status = "encrypted" if code == "SPREADSHEET_PASSWORD_REQUIRED" else "failed"
            response = {"status": status, "sourceHash": digest, "parserVersion": "parse-failure/2",
                        "excerptTruncated": False, "issues": [code], "spans": [], "coverage": {}}
            if isinstance(command, dict) and command.get("evidence_output"):
                response["evidence"] = write_evidence({"status": status, "parser_version": "parse-failure/2"}, Path(command["evidence_output"]))
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
