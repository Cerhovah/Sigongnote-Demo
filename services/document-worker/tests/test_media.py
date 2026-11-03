from __future__ import annotations

import io
import wave

import pytest
from PIL import Image

from sigongnote_worker.media import parse_audio, parse_image


class FakeOcr:
    def words(self, png, page, scale):
        assert png.startswith(b"\x89PNG")
        assert page == 1 and scale == 1
        return [{"text": "계획 80", "bbox": [1, 2, 3, 4], "confidence": 82,
                 "locator": "page:1/ocr:0", "source": "ocr_candidate"}]


class FakeStt:
    cost_type = "local"

    def transcribe_chunk(self, wav_bytes, start_ms, end_ms):
        assert wav_bytes.startswith(b"RIFF")
        return [{"text": "가명 내용", "start_ms": start_ms,
                 "end_ms": min(start_ms + 500, end_ms), "confidence": 0.7,
                 "speaker": "claimed speaker"}]


class PaidStt:
    cost_type = "paid"

    def transcribe_chunk(self, *_):
        pytest.fail("Paid engine was called")


def _wav(path, seconds=1):
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(8000)
        target.writeframes(b"\0\0" * 8000 * seconds)


@pytest.mark.media
def test_image_orientation_metadata_and_ocr_stay_candidates(tmp_path):
    path = tmp_path / "photo.jpg"
    photo = Image.new("RGB", (10, 5), "white")
    exif = Image.Exif()
    exif[274] = 6
    photo.save(path, exif=exif)
    original = path.read_bytes()
    parsed = parse_image(path, FakeOcr())
    assert parsed["status"] == "partial"
    assert parsed["metadata"]["source_dimensions"] == [10, 5]
    assert parsed["metadata"]["oriented_dimensions"] == [5, 10]
    assert parsed["words"][0]["locator"] == "image:0/ocr:0"
    assert parsed["words"][0]["source"] == "ocr_candidate"
    assert path.read_bytes() == original


@pytest.mark.media
def test_audio_span_has_unconfirmed_speaker_and_no_business_fact(tmp_path):
    path = tmp_path / "recording.wav"
    _wav(path)
    parsed = parse_audio(path, FakeStt())
    assert parsed["status"] == "partial"
    assert parsed["duration_ms"] == 1000
    assert parsed["segments"] == [{"text": "가명 내용", "time_range_ms": [0, 500],
                                   "confidence": 0.7, "speaker": "unconfirmed",
                                   "locator": "audio:0/chunk:0/segment:0", "source": "stt_candidate"}]
    assert not any(key in parsed for key in ("occurred", "accepted", "amount"))


@pytest.mark.media
def test_missing_or_paid_stt_never_fabricates_transcript(tmp_path):
    path = tmp_path / "recording.wav"
    _wav(path)
    missing = parse_audio(path)
    paid = parse_audio(path, PaidStt())
    assert missing["segments"] == paid["segments"] == []
    assert missing["issues"][0]["code"] == "stt_unavailable"
    assert paid["status"] == "budget_paused"
    assert paid["issues"][0]["code"] == "paid_stt_disabled"


@pytest.mark.media
def test_truncated_pcm_chunk_does_not_create_a_segment(tmp_path):
    path = tmp_path / "truncated.wav"
    _wav(path)
    path.write_bytes(path.read_bytes()[:-100])
    parsed = parse_audio(path, FakeStt())
    assert parsed["segments"] == []
    assert any(issue["code"] == "stt_chunk_failed" for issue in parsed["issues"])


@pytest.mark.media
def test_eps_magic_disguised_as_jpeg_is_rejected(tmp_path):
    path = tmp_path / "disguised.jpg"
    path.write_bytes(b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\nshowpage\n")
    parsed = parse_image(path, FakeOcr())
    assert parsed["status"] == "partial"
    assert parsed["words"] == []
    assert parsed["issues"] == [{"code": "image_decode_failed", "locator": "image:0"}]
