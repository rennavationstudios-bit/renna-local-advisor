"""Offline pattern/integrity check. Does not certify arbitrary text is private-free."""
from pathlib import Path
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
IGNORED = {'.git', '.local', 'node_modules', '__pycache__'}
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

def main():
    findings = []
    files = inventory()
    for p in files:
        relative = p.relative_to(ROOT).as_posix()
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
