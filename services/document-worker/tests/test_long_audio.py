import math
import struct
import wave
import av
from sigongnote_worker import long_audio


def wav(path, seconds):
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        second = b''.join(struct.pack('<h', round(math.sin(i * math.pi / 20) * 1000)) for i in range(16000))
        for _ in range(seconds):
            f.writeframes(second)


def test_m4a_real_container_and_original_unchanged(tmp_path):
    source = tmp_path / 'original.wav'
    wav(source, 2)
    m4a = tmp_path / 'original.m4a'
    with av.open(str(source)) as input_file, av.open(str(m4a), 'w', format='mp4') as output:
        stream = output.add_stream('aac', rate=16000)
        stream.layout = 'mono'
        for frame in input_file.decode(audio=0):
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)
    original = m4a.read_bytes()
    result = long_audio.prepare_audio(m4a, tmp_path)
    assert result['status'] == 'ready'
    assert result['codec'] == 'aac'
    assert 1900 <= result['durationMs'] <= 2200
    assert m4a.read_bytes() == original
    assert result['chunks'][0]['bytes'] < 25 * 1024 * 1024


def test_duration_split_and_limit(tmp_path, monkeypatch):
    source = tmp_path / 'long.wav'
    wav(source, 601)
    result = long_audio.prepare_audio(source, tmp_path)
    assert result['status'] == 'ready'
    assert [(c['startMs'], c['endMs']) for c in result['chunks']] == [(0, 600000), (599000, 601000)]
    assert all(c['bytes'] < 25 * 1024 * 1024 for c in result['chunks'])
    legacy = long_audio.prepare_audio(source, tmp_path, overlap_ms=0)
    assert legacy['chunks'][1]['startMs'] == 600000
    monkeypatch.setattr(long_audio, 'MAX_SAMPLES', 16000)
    assert long_audio.prepare_audio(source, tmp_path)['reason'] == 'audio_duration_limit'


def test_corrupt_playlist_is_not_followed(tmp_path):
    source = tmp_path / 'bad.m4a'
    source.write_text('#EXTM3U\n#EXTINF:1\nfile:///sensitive.wav\n')
    assert long_audio.prepare_audio(source, tmp_path)['status'] == 'corrupt'
