import hashlib
import io
from PIL import Image
from sigongnote_worker.photo_preview import preview

def test_orientation_metadata_without_mutating_original():
    image = Image.new("RGB", (100, 200), "white")
    exif = Image.Exif()
    exif[274] = 6
    exif[306] = "2026:10:04 09:10:00"
    exif[270] = "private source metadata"
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif)
    raw = out.getvalue()
    digest = hashlib.sha256(raw).hexdigest()
    result = preview(raw)
    assert (result["width"], result["height"]) == (200, 100)
    assert result["exif_date_hint"] == "2026:10:04 09:10:00"
    import base64
    derivative = Image.open(io.BytesIO(base64.b64decode(result["base64"])))
    assert not derivative.getexif()
    assert hashlib.sha256(raw).hexdigest() == digest

def test_no_exif_remains_unknown():
    out = io.BytesIO()
    Image.new("RGB", (40, 20), "gray").save(out, "PNG")
    assert preview(out.getvalue())["exif_date_hint"] is None
