"""Local approved quote renderer. Reads one JSON request from stdin, never a path from a document."""
import json
import sys
from pathlib import Path
from .quote_pdf import publish_quote_pdf


def main():
    try:
        data = json.loads(sys.stdin.read(262145))
        result = publish_quote_pdf(Path(sys.argv[1]), data['snapshot'], data['approval_id'], data['snapshot_sha256'])
        print(json.dumps(result), flush=True)
    except Exception:
        print(json.dumps({'error': 'QUOTE_RENDER_FAILED'}), flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
