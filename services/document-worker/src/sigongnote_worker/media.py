"""Permissioned local media adapters; recognition output is unverified evidence.

The collector decides which files may reach this worker. Neither adapter makes
an occurrence, acceptance, quality, quantity, or payment decision.
"""
from __future__ import annotations

import hashlib
import io
import math
import wave
from pathlib import Path
from typing import Protocol

from PIL import Image, ImageOps, UnidentifiedImageError

from .pdf import LocalTesseract

VERSION = "media-evidence/1.0.0"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_AUDIO_BYTES = 200 * 1024 * 1024
MAX_AUDIO_SECONDS = 7200
AUDIO_CHUNK_SECONDS = 600


class SttEngine(Protocol):
    cost_type: str

    def transcribe_chunk(self, wav_bytes: bytes, start_ms: int, end_ms: int) -> list[dict]: ...


def _base(path: Path, kind: str) -> dict:
    return {"source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "format": kind, "parser_version": VERSION, "status": "partial",
            "supported_scope": "image OCR candidates" if kind == "image" else "PCM WAV time-range transcript candidates",
            "issues": []}


def parse_image(path: str | Path, ocr: LocalTesseract | None = None) -> dict:
    path = Path(path)
    if path.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("IMAGE_INPUT_LIMIT")
    result = _base(path, "image")
    result["words"] = []
    try:
        # Never dispatch untrusted content to Pillow plugins such as EPS,
        # which may invoke an external interpreter during image loading.
        with Image.open(path, formats=("JPEG", "PNG", "WEBP")) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                result["issues"].append({"code": "image_pixel_limit", "locator": "image:0"})
                return result
            exif = image.getexif()
            result["metadata"] = {"source_format": image.format,
                                  "source_dimensions": [image.width, image.height],
                                  "source_orientation": exif.get(274),
                                  "source_datetime_unverified": exif.get(36867)}
            if getattr(image, "n_frames", 1) > 1:
                result["issues"].append({"code": "additional_frames_unread", "locator": "image:0"})
            oriented = ImageOps.exif_transpose(image)
            result["metadata"]["oriented_dimensions"] = [oriented.width, oriented.height]
            buffer = io.BytesIO()
            oriented.convert("RGB").save(buffer, format="PNG")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        result["issues"].append({"code": "image_decode_failed", "locator": "image:0"})
        return result
    try:
        words = (ocr or LocalTesseract()).words(buffer.getvalue(), 1, 1.0)
        if len(words) > 5000:
            raise RuntimeError("OCR_WORD_LIMIT")
        result["words"] = [{**word, "locator": f"image:0/ocr:{index}",
                            "source": "ocr_candidate"} for index, word in enumerate(words)]
        result["issues"].append({"code": "ocr_unverified", "locator": "image:0"})
    except (RuntimeError, OSError) as exc:
        code = str(exc) if isinstance(exc, RuntimeError) and str(exc).isupper() else "ocr_failed"
        result["issues"].append({"code": code, "locator": "image:0"})
    return result


def _chunk_bytes(source: wave.Wave_read, frames: int, channels: int,
                 sample_width: int, frame_rate: int) -> bytes:
    pcm = source.readframes(frames)
    if len(pcm) != frames * channels * sample_width:
        raise ValueError("TRUNCATED_AUDIO_FRAMES")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(sample_width)
        target.setframerate(frame_rate)
        target.writeframes(pcm)
    return buffer.getvalue()


def parse_audio(path: str | Path, engine: SttEngine | None = None) -> dict:
    path = Path(path)
    if path.stat().st_size > MAX_AUDIO_BYTES:
        raise ValueError("AUDIO_INPUT_LIMIT")
    result = _base(path, "audio")
    result["segments"] = []
    result["chunks"] = []
    try:
        with wave.open(str(path), "rb") as source:
            frame_rate = source.getframerate()
            frames = source.getnframes()
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            if not frame_rate or source.getcomptype() != "NONE":
                raise wave.Error("UNSUPPORTED_AUDIO_CODEC")
            duration_ms = math.ceil(frames * 1000 / frame_rate)
            result["duration_ms"] = duration_ms
            result["channels_observed"] = channels
            result["speaker_status"] = "unconfirmed"
            if not frames or duration_ms > MAX_AUDIO_SECONDS * 1000:
                result["issues"].append({"code": "audio_duration_limit_or_empty", "locator": "audio:0"})
                return result
            if engine is None:
                result["issues"].append({"code": "stt_unavailable", "locator": "audio:0"})
                return result
            if getattr(engine, "cost_type", "unknown") != "local":
                result["status"] = "budget_paused"
                result["issues"].append({"code": "paid_stt_disabled", "locator": "audio:0"})
                return result
            chunk_frames = frame_rate * AUDIO_CHUNK_SECONDS
            for index, start_frame in enumerate(range(0, frames, chunk_frames)):
                end_frame = min(start_frame + chunk_frames, frames)
                start_ms = start_frame * 1000 // frame_rate
                end_ms = math.ceil(end_frame * 1000 / frame_rate)
                locator = f"audio:0/chunk:{index}"
                chunk = {"locator": locator, "time_range_ms": [start_ms, end_ms],
                         "status": "partial"}
                result["chunks"].append(chunk)
                try:
                    recording = _chunk_bytes(source, end_frame - start_frame,
                                             channels, sample_width, frame_rate)
                    candidates = engine.transcribe_chunk(recording, start_ms, end_ms)
                    if not isinstance(candidates, list) or len(candidates) > 10_000:
                        raise ValueError("STT_SEGMENT_LIMIT")
                    for candidate in candidates:
                        text = str(candidate.get("text", "")).strip()
                        begin = candidate.get("start_ms")
                        end = candidate.get("end_ms")
                        if not text:
                            continue
                        if not isinstance(begin, int) or not isinstance(end, int) or not (start_ms <= begin < end <= end_ms):
                            raise ValueError("INVALID_STT_RANGE")
                        confidence = candidate.get("confidence")
                        if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
                            confidence = None
                        result["segments"].append({"text": text,
                                                   "time_range_ms": [begin, end],
                                                   "confidence": confidence,
                                                   "speaker": "unconfirmed",
                                                   "locator": f"{locator}/segment:{len(result['segments'])}",
                                                   "source": "stt_candidate"})
                except (ValueError, RuntimeError, OSError):
                    result["issues"].append({"code": "stt_chunk_failed", "locator": locator})
            result["issues"].append({"code": "transcript_unverified", "locator": "audio:0"})
    except (wave.Error, EOFError, OSError):
        result["issues"].append({"code": "unsupported_or_corrupt_audio", "locator": "audio:0"})
    return result
