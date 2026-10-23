"""Offline pattern/integrity check. Does not certify arbitrary text is private-free."""
from pathlib import Path
import hashlib
import json
import re
import struct
import sys
import zlib

ROOT = Path(__file__).resolve().parents[1]
IGNORED = {'.git', '.local', 'node_modules', '__pycache__'}
IMAGE_PATHS = {
    'assets/images/renna-local-advisor-banner.png',
    'assets/images/local-worker-architecture.png',
    'assets/images/scoped-workflow.png',
}
RULES = {
    'ipv4-literal': re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])'),
    'absolute-windows-path': re.compile(r'\b[A-Za-z]:[/\\]'),
    'user-home-path': re.compile(r'/(?:Users|home)/[A-Za-z0-9_.-]+'),
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'provider-key': re.compile(r'\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{24,}|AKIA[A-Z0-9]{16})\b'),
    'credential-url': re.compile(r'https?://[^\s/]+:[^\s/]+@'),
}

def inventory():
    files = []
    for p in ROOT.rglob('*'):
        relative = p.relative_to(ROOT)
        if any(part in IGNORED for part in relative.parts):
            continue
        if p.is_symlink():
            raise ValueError('symlink is not publishable: '+relative.as_posix())
        if p.is_file():
            files.append(p)
    return files

def approved_png(data, expected_hash):
    """Accept byte-approved PNGs; preserve checked provenance, reject text/EXIF."""
    if not isinstance(expected_hash, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_hash):
        return False
    if hashlib.sha256(data).hexdigest() != expected_hash or len(data) > 12_000_000:
        return False
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return False
    offset, first, image_data = 8, True, False
    allowed = {b'IHDR', b'PLTE', b'IDAT', b'IEND', b'sRGB', b'gAMA', b'cHRM', b'tRNS', b'bKGD', b'pHYs', b'iCCP', b'caBX'}
    while offset + 12 <= len(data):
        length = struct.unpack('>I', data[offset:offset+4])[0]
        kind = data[offset+4:offset+8]
        end = offset + 12 + length
        if end > len(data) or kind not in allowed:
            return False
        payload = data[offset+8:offset+8+length]
        checksum = struct.unpack('>I', data[offset+8+length:end])[0]
        if zlib.crc32(kind + payload) & 0xffffffff != checksum:
            return False
        if kind == b'caBX':
            # Keep the generator's C2PA content credentials. Inspect readable
            # claim text for the same privacy patterns; never emit its values.
            claim_text = payload.decode('utf-8', errors='ignore')
            if any(rule.search(claim_text) for rule in RULES.values()):
                return False
        if first:
            if kind != b'IHDR' or length != 13:
                return False
            width, height = struct.unpack('>II', payload[:8])
            if not (1 <= width <= 4096 and 1 <= height <= 4096):
                return False
            first = False
        elif kind == b'IHDR':
            return False
        image_data |= kind == b'IDAT'
        if kind == b'IEND':
            return length == 0 and end == len(data) and image_data
        offset = end
    return False

def main():
    findings = []
    files = inventory()
    image_manifest = ROOT/'assets/images/manifest.json'
    approved = {}
    if image_manifest.is_file():
        approved = json.loads(image_manifest.read_text(encoding='utf-8')).get('images', {})
        if set(approved) != IMAGE_PATHS:
            findings.append({'file':'assets/images/manifest.json','rule':'unexpected-image-allowlist'})
        for relative in IMAGE_PATHS:
            if not (ROOT/relative).is_file():
                findings.append({'file':relative,'rule':'approved-image-missing'})
    for p in files:
        relative = p.relative_to(ROOT).as_posix()
        if relative in IMAGE_PATHS:
            if not approved_png(p.read_bytes(), approved.get(relative)):
                findings.append({'file':relative,'rule':'image-hash-format-or-metadata'})
            continue
        try:
            text = p.read_text(encoding='utf-8')
        except (UnicodeError, OSError):
            findings.append({'file':relative,'rule':'non-text-file'})
            continue
        for rule, regex in RULES.items():
            for m in regex.finditer(text):
                findings.append({'file':relative,'line':text.count('\n',0,m.start())+1,'rule':rule})
    manifest = json.loads((ROOT/'SOURCE-MANIFEST.json').read_text())
    for item in manifest['files']:
        p = ROOT/item['path']
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != item['sha256']:
            findings.append({'file':item['path'],'rule':'source-hash-mismatch'})
    # Values are intentionally never included in diagnostics.
    print(json.dumps({'filesChecked':len(files),'findings':findings},indent=2))
    return 1 if findings else 0

if __name__ == '__main__':
    sys.exit(main())
