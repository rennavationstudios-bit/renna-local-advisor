"""Validate this source kit offline, without starting a worker or installing it."""
from pathlib import Path
import ast
import json
import subprocess
import sys
import tomllib

ROOT=Path(__file__).resolve().parents[1]

def main():
    counts={'javascriptSyntax':0,'pythonSyntax':0,'json':0,'toml':0,'guardedLaunchers':0}
    failures=[]
    files=[p for p in ROOT.rglob('*') if p.is_file() and not any(x in {'.git','.local','node_modules','__pycache__'} for x in p.relative_to(ROOT).parts)]
    for p in files:
        relative=p.relative_to(ROOT).as_posix()
        try:
            if p.suffix=='.mjs' or p.name.endswith('.mjs.txt'):
                result=subprocess.run(['node','--check','--input-type=module'],input=p.read_bytes(),capture_output=True,timeout=30)
                if result.returncode: raise ValueError('JavaScript syntax check failed')
                counts['javascriptSyntax']+=1
            elif p.suffix=='.py':
                ast.parse(p.read_text(encoding='utf-8'),filename=relative)
                counts['pythonSyntax']+=1
            elif p.suffix=='.json':
                json.loads(p.read_text(encoding='utf-8'))
                counts['json']+=1
            elif p.suffix=='.toml':
                tomllib.loads(p.read_text(encoding='utf-8'))
                counts['toml']+=1
        except Exception:
            failures.append({'path':relative,'check':'syntax-or-parse'})
    for name in ('advisor-local.mjs','advisor-local-mcp.mjs'):
        p=ROOT/'reference-runtime/bin'/name
        try:
            result=subprocess.run(['node',str(p)],input=b'',capture_output=True,timeout=20)
            if result.returncode==0 or b'SOURCE_REFERENCE_ONLY' not in result.stderr:
                raise ValueError('Expected source guard missing')
            counts['guardedLaunchers']+=1
        except Exception:
            failures.append({'path':p.relative_to(ROOT).as_posix(),'check':'source-launch-guard'})
    print(json.dumps({'checks':counts,'failures':failures},indent=2))
    return bool(failures)

if __name__=='__main__':
    sys.exit(main())
