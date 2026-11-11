from pathlib import Path
import json
import sys
import time

root = Path(r'C:\MCP\ArtForge-AI-Cloud')
sys.argv = ['sleep-probe', '--base', 'https://artforge-mcp-gateway.obr432.workers.dev']
helpers = (root / 'worker/test/e2e.py').read_text().split('# ---------------------------------------------------------------- discovery')[0]
ns = {}
exec(compile(helpers, 'e2e-helpers', 'exec'), ns)
_, auth = ns['login']('controlled sleep test account')
token = auth['access_token']
result = ns['call'](token, 'artforge_create_design', {'prompt': 'بطاقة اختبار السكون', 'width': 400, 'height': 300})
old = ns['data_of'](result).get('documentId')
assert old, 'Cannot create pre-sleep document'
report = {'idleStartedUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'idleSeconds': 960, 'results': []}
print('Pre-sleep document created. Beginning 960 seconds with no engine requests.', flush=True)
time.sleep(960)

def check(name, ok, seconds=None):
    item = {'check': name, 'ok': bool(ok)}
    if seconds is not None:
        item['seconds'] = round(seconds, 2)
    report['results'].append(item)
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({seconds:.2f}s)' if seconds is not None else ''), flush=True)

start = time.monotonic()
status, listing = ns['rpc'](token, 'tools/list')
check('snapshot discovery after real idle', status == 200 and len(listing.get('result', {}).get('tools', [])) == 11, time.monotonic() - start)
start = time.monotonic()
status, init = ns['rpc'](token, 'initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'idle-test', 'version': '1'}})
check('initialize available during wake', status == 200 and 'result' in init, time.monotonic() - start)
start = time.monotonic()
for attempt in range(3):
    result = ns['call'](token, 'artforge_create_design', {'prompt': 'عودة الرسم بعد السكون', 'width': 500, 'height': 300})
    data = ns['data_of'](result)
    if data.get('success'):
        break
    if data.get('error', {}).get('code') != 'ENGINE_WAKING':
        break
    report['results'].append({'check': 'explicit ENGINE_WAKING response', 'ok': True})
    time.sleep(60)
check('drawing resumes after idle', data.get('success'), time.monotonic() - start)
old_response = ns['call'](token, 'artforge_tool_op', {'op': 'document.info', 'params': {'documentId': old}})
old_data = ns['data_of'](old_response)
text = json.dumps(old_data).upper()
missing = old_response.get('result', {}).get('isError') and any(s in text for s in ('DOCUMENT_NOT_FOUND', 'NOT FOUND', 'NOT_FOUND', 'UNKNOWN DOCUMENT'))
check('pre-sleep ephemeral document removed by real restart', missing)
report['passed'] = sum(r['ok'] for r in report['results'])
report['total'] = len(report['results'])
(root / 'evidence/render-real-sleep.json').write_text(json.dumps(report, indent=2), encoding='utf8')
print('SUMMARY', report['passed'], '/', report['total'], flush=True)
