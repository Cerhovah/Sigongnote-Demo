import hashlib
import io
import json
from PIL import Image, ImageDraw
from pypdf import PdfReader
import pytest
from sigongnote_worker.photo_sheet import render


def fixture(tmp_path, layout=4, gray=False):
    photos = []
    for i in range(5):
        image = Image.new('RGB', (600 if i % 2 else 300, 400 if i % 2 else 700), '#df7050')
        draw = ImageDraw.Draw(image)
        draw.rectangle((25, 25, 200, 200), fill='#235bbb')
        draw.text((35, 35), f'TEST PHOTO {i+1}', fill='white')
        path = tmp_path / f'{i}.image'
        exif = Image.Exif()
        exif[274] = 6 if i == 0 else 1
        exif[34853] = {1: 'N'}
        image.save(path, 'JPEG', exif=exif)
        photos.append(dict(revision_id=f'test-{i}', caption=('창틀 보완 위치를 확인하고 다음 작업을 기록합니다. ' * 7)[:180], location='동측 2층 안쪽 창문 ' * 6, taken_date=None, rotation=90 if i == 1 else 0, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    return dict(title='합성 검증용 사진대지', project_id='synthetic', project_name='합성 햇살 현장', context_id=None, layout=layout, grayscale=gray, photos=photos)


@pytest.mark.parametrize('layout,gray', [(2, False), (4, False), (4, True)])
def test_layout_long_korean_rotation_unknown_and_original_hash(tmp_path, layout, gray):
    snapshot = fixture(tmp_path, layout, gray)
    pdf, pages = render(snapshot, tmp_path)
    book = PdfReader(io.BytesIO(pdf))
    assert pages == len(book.pages) == (3 if layout == 2 else 2)
    text = '\n'.join(page.extract_text() for page in book.pages)
    assert text.count('촬영일: 확인 전') == 5
    assert text.replace('\n', '').count('창틀 보완 위치') >= 30
    assert 'revision_id' not in text and 'synthetic' not in text
    for page in book.pages:
        for image in page.images:
            if gray:
                assert image.image.mode == 'L'
    for i, photo in enumerate(snapshot['photos']):
        assert hashlib.sha256((tmp_path / f'{i}.image').read_bytes()).hexdigest() == photo['sha256']


def test_tampered_source_never_renders(tmp_path):
    snapshot = fixture(tmp_path)
    (tmp_path / '0.image').write_bytes(b'changed test source')
    with pytest.raises(ValueError, match='PHOTO_HASH'):
        render(snapshot, tmp_path)


def test_twenty_textured_color_photos_fit_native_limit(tmp_path):
    snapshot = fixture(tmp_path)
    raw = io.BytesIO()
    Image.effect_noise((1800, 1200), 90).convert('RGB').save(raw, 'JPEG', quality=95)
    photos = []
    for i in range(20):
        (tmp_path / f'{i}.image').write_bytes(raw.getvalue())
        photos.append(dict(snapshot['photos'][0], revision_id=f'test-{i}', sha256=hashlib.sha256(raw.getvalue()).hexdigest()))
    snapshot['photos'] = photos
    for layout in (2, 4):
        snapshot['layout'] = layout
        pdf, pages = render(snapshot, tmp_path)
        assert len(pdf) < 5242880 and pages == 20 // layout
