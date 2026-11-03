import io
import sys
from pypdf import PdfReader

data = sys.stdin.buffer.read(5242881)
if not 1 <= len(data) <= 5242880:
    raise ValueError('PDF_LIMIT')
pages = len(PdfReader(io.BytesIO(data)).pages)
if not 1 <= pages <= 100:
    raise ValueError('PDF_PAGES')
print(pages)
