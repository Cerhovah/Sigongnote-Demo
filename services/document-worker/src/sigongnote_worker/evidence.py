"""Complete, bounded evidence records, independent of the legacy screen excerpt."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

CHUNK_CHARACTERS = 1000
VERSION = "evidence-chunks-v1"


def chunk_text(text: str, limit: int = CHUNK_CHARACTERS):
    """Wire limits count UTF-16 units; never split a Unicode scalar or lose its offset."""
    start, units = 0, 0
    for index, char in enumerate(text):
        size = 2 if ord(char) > 0xFFFF else 1
        if units + size > limit:
            yield start, text[start:index]
            start, units = index, 0
        units += size
    if start < len(text):
        yield start, text[start:]


def _word_chunks(value: dict, locator: str):
    """Readable page text, with a bounded map back to every contributing word."""
    text, records, units, record_bytes = "", [], 0, 0
    offset, chunk_index, joined_words = 0, 0, 0

    def emit():
        boxes = [record["bbox"] for record in records if "bbox" in record]
        position = {"word_range": [records[0]["i"], records[-1]["i"] + 1],
                    "word_range_unit": "zero_based_end_exclusive", "words": records,
                    "chunk_index": chunk_index, "character_start": offset,
                    "character_end": offset + len(text), "character_unit": "unicode_code_point"}
        if boxes:
            position["bbox"] = [min(b[0] for b in boxes), min(b[1] for b in boxes),
                                max(b[2] for b in boxes), max(b[3] for b in boxes)]
        if "coordinate_space" in value:
            position["coordinate_space"] = value["coordinate_space"]
        return {"text": text, "locator": locator, "position": position}

    for index, word in enumerate(value["words"]):
        content = str(word.get("text", ""))
        if not content.strip():
            continue
        content = (" " if joined_words else "") + content
        joined_words += 1
        for _, part in chunk_text(content):
            size = len(part.encode("utf-16-le")) // 2
            record = {"i": index, **{key: word[key] for key in
                      ("bbox", "source", "coordinate_space") if key in word}}
            # Leave room for the range/union metadata and PostgreSQL jsonb spacing.
            record_size = len(json.dumps(record, ensure_ascii=False).encode("utf-8")) + 100
            if text and (units + size > CHUNK_CHARACTERS or record_bytes + record_size > 14 * 1024):
                yield emit()
                offset += len(text)
                text, records, units, record_bytes = "", [], 0, 0
                chunk_index += 1
            record["character_start"] = offset + len(text)
            record["character_end"] = offset + len(text) + len(part)
            records.append(record)
            text += part
            units += size
            record_bytes += record_size
    if text:
        yield emit()


def evidence_chunks(result: dict):
    """Keep every extracted character and its original location; never infer facts."""
    ordinal = 0

    def visit(value):
        if isinstance(value, dict):
            text, locator = value.get("text"), value.get("locator")
            words = value.get("words")
            if isinstance(words, list) and words:
                # Image results have their location on words; PDF pages have it on the page.
                word_locator = locator or str(words[0].get("locator", "")).split("/")[0]
                if word_locator:
                    yield from _word_chunks(value, str(word_locator))
            if "value" in value and locator and not value.get("formula"):
                text = (value["raw_numeric"] if value.get("kind") == "n" and
                        value.get("raw_numeric") is not None else value["value"])
            if value.get("formula") and locator:
                cached = value.get("raw_numeric", value.get("cached_value"))
                text = (f"저장된 수식값: {cached} (재계산 안 함)" if cached is not None
                        else "수식값 없음 (금액 확인 필요)")
            if text is not None and locator and str(text).strip():
                text = str(text)
                position = {k: value[k] for k in
                            ("bbox", "time_range_ms", "source", "coordinate_space") if k in value}
                for offset, part in chunk_text(text):
                    yield {"text": part,
                           "locator": str(locator), "position": {
                               **position, "character_start": offset,
                               "character_end": offset + len(part), "character_unit": "unicode_code_point"}}
            for key, child in value.items():
                if key == "words" and isinstance(words, list) and words and word_locator:
                    continue
                if isinstance(child, (dict, list)):
                    yield from visit(child)
        elif isinstance(value, list):
            for child in value:
                yield from visit(child)

    for item in visit(result):
        yield {"ordinal": ordinal, **item,
               "contentHash": hashlib.sha256(item["text"].encode("utf-8")).hexdigest()}
        ordinal += 1


def write_evidence(result: dict, target: Path) -> dict:
    count = 0
    with target.open("w", encoding="utf-8", newline="\n") as output:
        for chunk in evidence_chunks(result):
            output.write(json.dumps(chunk, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
    return {"schemaVersion": VERSION, "chunkCount": count,
            "parserVersion": result.get("parser_version", "unknown"),
            "sourceStatus": result["status"], "coverage": result.get("coverage", {}),
            "completeExtractedText": True}
