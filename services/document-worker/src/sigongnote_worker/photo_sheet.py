"""A4 photo sheets. Read originals, create bounded derivatives; never edit source files."""
import base64
import hashlib
import io
import json
import math
import sys
from pathlib import Path
from xml.sax.saxutils import escape
from PIL import Image, ImageOps
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph
from .export_batch import _font_path

Image.MAX_IMAGE_PIXELS = 40_000_000


def render(snapshot, source_dir):
    if set(snapshot) != {'title', 'project_id', 'project_name', 'context_id', 'layout', 'grayscale', 'photos'}:
        raise ValueError('INVALID_PHOTO_SHEET')
    layout = snapshot['layout']
    photos = snapshot['photos']
    if layout not in (2, 4) or type(snapshot['grayscale']) is not bool or not 1 <= len(photos) <= 20:
        raise ValueError('INVALID_PHOTO_SHEET')
    for field, limit in [('title', 120), ('project_name', 200)]:
        if not isinstance(snapshot[field], str) or len(snapshot[field]) > limit:
            raise ValueError('INVALID_PHOTO_TEXT')
    font = 'SigongnotePhoto'
    if font not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(font, str(_font_path())))
    style = ParagraphStyle('caption', fontName=font, fontSize=10, leading=14, wordWrap='CJK')
    heading = ParagraphStyle('heading', parent=style, fontSize=13, leading=17)
    out = io.BytesIO()
    pdf = Canvas(out, pagesize=A4, pageCompression=1, invariant=1)
    pdf.setTitle('사진대지')
    pdf.setAuthor('시공노트')
    pdf.setSubject('현장 사진 기록')
    pdf.setKeywords('sigongnote_generated=true;template=photo-a4-v1')
    width, height = A4
    pages = math.ceil(len(photos) / layout)
    cols = 2 if layout == 4 else 1
    cell_w = (width - 64) / cols
    header = Paragraph(escape(snapshot['title']) + '<br/>' + escape(snapshot['project_name']), heading)
    _, header_h = header.wrap(width - 64, height)
    cell_h = (height - 92 - header_h) / 2
    for page in range(pages):
        header.drawOn(pdf, 32, height - 28 - header_h)
        for slot, photo in enumerate(photos[page * layout:(page + 1) * layout]):
            if set(photo) != {'revision_id', 'caption', 'location', 'taken_date', 'rotation', 'sha256'}:
                raise ValueError('INVALID_PHOTO_ITEM')
            if photo['rotation'] not in (0, 90, 180, 270):
                raise ValueError('INVALID_ROTATION')
            for field, limit in [('caption', 180), ('location', 100)]:
                if not isinstance(photo[field], str) or len(photo[field]) > limit:
                    raise ValueError('INVALID_PHOTO_TEXT')
            if photo['taken_date'] is not None:
                from datetime import date
                date.fromisoformat(photo['taken_date'])
            ordinal = page * layout + slot
            path = Path(source_dir) / f'{ordinal}.image'
            if path.stat().st_size > 20 * 1024 * 1024:
                raise ValueError('PHOTO_LIMIT')
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != photo['sha256']:
                raise ValueError('PHOTO_HASH')
            with Image.open(io.BytesIO(raw)) as original:
                if original.format not in ('JPEG', 'PNG'):
                    raise ValueError('PHOTO_FORMAT')
                rgba = ImageOps.exif_transpose(original).convert('RGBA')
                white = Image.new('RGBA', rgba.size, 'white')
                image = Image.alpha_composite(white, rgba).convert('L' if snapshot['grayscale'] else 'RGB')
                if photo['rotation']:
                    image = image.rotate(-photo['rotation'], expand=True)
                edge = 1000 if layout == 2 else 700
                image.thumbnail((edge, edge))
            encoded = io.BytesIO()
            image.save(encoded, 'JPEG', quality=78)
            caption = Paragraph(f'{ordinal + 1}. {escape(photo["caption"] or "설명 없음")}<br/>위치: {escape(photo["location"] or "확인 전")}<br/>촬영일: {escape(photo["taken_date"] or "확인 전")}', style)
            _, text_h = caption.wrap(cell_w - 20, cell_h)
            image_h = cell_h - text_h - 26
            if image_h < 70:
                raise ValueError('TEXT_OVERFLOW')
            x = 32 + (slot % cols) * cell_w
            y = height - 42 - header_h - (slot // cols + 1) * cell_h
            pdf.setStrokeColorRGB(.65, .65, .65)
            pdf.rect(x, y, cell_w, cell_h)
            pdf.drawImage(ImageReader(encoded), x + 10, y + text_h + 16, cell_w - 20, image_h, preserveAspectRatio=True, anchor='c')
            caption.drawOn(pdf, x + 10, y + 8)
        pdf.setFont(font, 9)
        pdf.drawRightString(width - 32, 22, f'{page + 1} / {pages}')
        pdf.showPage()
    pdf.save()
    content = out.getvalue()
    if len(content) > 5 * 1024 * 1024:
        raise ValueError('PHOTO_LIMIT')
    return content, pages


if __name__ == '__main__':
    value = json.loads(sys.stdin.buffer.read(131073))
    pdf, pages = render(value, sys.argv[1])
    print(json.dumps({'pdf': base64.b64encode(pdf).decode('ascii'), 'pages': pages}))
