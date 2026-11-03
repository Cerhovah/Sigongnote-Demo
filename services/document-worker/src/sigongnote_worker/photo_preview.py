"""Read-only preview. Original bytes/EXIF remain in original storage, never in this derivative."""
import base64
import io
import json
import sys
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 40_000_000

def preview(raw: bytes) -> dict:
    with Image.open(io.BytesIO(raw)) as original:
        if original.format not in ("JPEG", "PNG"):
            raise ValueError("UNSUPPORTED_PHOTO")
        original.load()
        exif = original.getexif()
        observed = exif.get_ifd(34665).get(36867) or exif.get(36867) or exif.get(306)
        # EXIF wall-clock text has no implied timezone or claim of a confirmed work date.
        date_hint = str(observed)[:19] if observed else None
        corrected = ImageOps.exif_transpose(original).convert("RGB")
        width, height = corrected.size
        corrected.thumbnail((480, 480))
        output = io.BytesIO()
        corrected.save(output, "JPEG", quality=80)
        return {"base64": base64.b64encode(output.getvalue()).decode("ascii"), "mime": "image/jpeg", "width": width, "height": height, "exif_date_hint": date_hint}

if __name__ == "__main__":
    raw = sys.stdin.buffer.read(20_971_521)
    if len(raw) > 20_971_520:
        raise ValueError("PHOTO_TOO_LARGE")
    print(json.dumps(preview(raw)))
