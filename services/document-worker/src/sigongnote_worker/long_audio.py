"""Bounded, network-free decode. Original bytes and timestamps stay independent of STT."""
import hashlib
import wave
from pathlib import Path
import av
from .media import MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, AUDIO_CHUNK_SECONDS

RATE = 16000
CHUNK_SAMPLES = RATE * AUDIO_CHUNK_SECONDS  # mono PCM16: 19.2 MB, below 25 MB
MAX_SAMPLES = RATE * MAX_AUDIO_SECONDS


def prepare_audio(path: Path, directory: Path, overlap_ms: int = 1000) -> dict:
    if path.stat().st_size > MAX_AUDIO_BYTES:
        return {"status": "limit", "reason": "audio_size_limit"}
    with path.open("rb") as original:
        digest = hashlib.file_digest(original, "sha256").hexdigest()
    if overlap_ms not in (0, 1000):
        raise ValueError("Invalid audio overlap")
    chunks, pending, total, tail = [], bytearray(), 0, b""

    def flush():
        nonlocal pending, tail
        index = len(chunks)
        target = directory / f"chunk-{index}.wav"
        with wave.open(str(target), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(RATE)
            output.writeframes(tail + pending)
        samples = len(pending) // 2
        with target.open("rb") as decoded:
            derived_hash = hashlib.file_digest(decoded, "sha256").hexdigest()
        chunks.append({"index": index, "startMs": index * 600000 - len(tail) * 1000 // (2 * RATE),
                       "endMs": index * 600000 + samples * 1000 // RATE,
                       "sha256": derived_hash,
                       "bytes": target.stat().st_size})
        tail = bytes(pending[-overlap_ms * RATE * 2 // 1000:]) if overlap_ms else b""
        pending = bytearray()

    try:
        with av.open(str(path), options={"protocol_whitelist": "file", "format_whitelist": "wav,mov,mp3,ogg,flac,aac,amr"}) as source:
            if len(source.streams.audio) != 1 or len(source.streams.video):
                return {"status": "unsupported", "reason": "audio_streams_unsupported"}
            stream = source.streams.audio[0]
            codec, channels = stream.codec_context.name, stream.codec_context.channels
            if not 1 <= channels <= 8 or not 8000 <= stream.codec_context.sample_rate <= 192000:
                return {"status": "unsupported", "reason": "audio_streams_unsupported"}
            converter = av.AudioResampler(format="s16", layout="mono", rate=RATE)
            expected_time = None
            for frame in source.decode(stream):
                if frame.time is not None:
                    if expected_time is not None and abs(frame.time - expected_time) > 0.1:
                        return {"status": "unsupported", "reason": "audio_timeline_gap"}
                    expected_time = frame.time + frame.samples / frame.sample_rate
                for converted in converter.resample(frame):
                    raw = bytes(converted.planes[0])[:converted.samples * 2]
                    total += converted.samples
                    if total > MAX_SAMPLES:
                        return {"status": "limit", "reason": "audio_duration_limit"}
                    pending.extend(raw)
                    while len(pending) >= CHUNK_SAMPLES * 2:
                        rest = pending[CHUNK_SAMPLES * 2:]
                        pending = pending[:CHUNK_SAMPLES * 2]
                        flush()
                        pending = rest
            for converted in converter.resample(None):
                total += converted.samples
                pending.extend(bytes(converted.planes[0])[:converted.samples * 2])
            if total > MAX_SAMPLES:
                return {"status": "limit", "reason": "audio_duration_limit"}
            while len(pending) >= CHUNK_SAMPLES * 2:
                rest = pending[CHUNK_SAMPLES * 2:]
                pending = pending[:CHUNK_SAMPLES * 2]
                flush()
                pending = rest
            if pending:
                flush()
            if not total:
                return {"status": "corrupt", "reason": "audio_empty"}
            return {"status": "ready", "sourceHash": digest, "durationMs": total * 1000 // RATE,
                    "codec": codec, "channels": channels, "chunks": chunks,
                    "decoderVersion": f"pyav/{av.__version__}/mono16k-" + ("overlap-v2" if overlap_ms else "v1")}
    except (av.FFmpegError, ValueError, OSError):
        return {"status": "corrupt", "reason": "audio_decode_failed"}
