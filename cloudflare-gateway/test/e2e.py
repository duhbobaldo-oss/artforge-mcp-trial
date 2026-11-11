"""End-to-end check of the ArtForge MCP gateway, as an OAuth MCP client would use it.

Local:  python -I test/e2e.py --base http://localhost:8787 [--origin http://127.0.0.1:PORT]
Remote: python -I test/e2e.py --base https://artforge-mcp-gateway.<account>.workers.dev 
Prints PASS/FAIL lines and writes a JSON summary next to --out. Never prints tokens or codes.
"""
import argparse, base64, hashlib, html, json, re, secrets, sys, time, urllib.parse
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler, HTTPSHandler, HTTPHandler

p = argparse.ArgumentParser()
p.add_argument('--base', required=True)
p.add_argument('--origin', help='engine origin URL, to probe direct unauthenticated access')
p.add_argument('--secret', action='append', default=[], help='values that must never appear in responses')
p.add_argument('--out', default='e2e-result.json')
p.add_argument('--skip-cimd', action='store_true')
p.add_argument('--auth-only', action='store_true')
p.add_argument('--generation-only', action='store_true')
args = p.parse_args()
BASE = args.base.rstrip('/')
RESOURCE = BASE + '/mcp'
results, seen, test_clients = [], [], []

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = build_opener(NoRedirect, HTTPHandler, HTTPSHandler)

def http(method, url, body=None, headers=None, form=None):
    h = {'User-Agent': 'ArtForge-gateway-test/1.0', **(headers or {})}  # Cloudflare blocks the default Python-urllib UA (1010)
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form, doseq=True).encode(); h['Content-Type'] = 'application/x-www-form-urlencoded'
    elif body is not None:
        data = json.dumps(body).encode(); h.setdefault('Content-Type', 'application/json')
    req = Request(url, data=data, headers=h, method=method)
    try:
        r = opener.open(req, timeout=180); status, hdrs, raw = r.status, r.headers, r.read()
    except HTTPError as e:
        status, hdrs, raw = e.code, e.headers, e.read()
    text = raw.decode('utf-8', 'replace')
    if not url.endswith('/token'):  # the token endpoint legitimately returns the client's own tokens
        seen.append(text); seen.append(str(dict(hdrs)))
    return status, hdrs, text

def check(name, ok, detail=''):
    results.append({'check': name, 'ok': bool(ok), 'detail': str(detail)[:400]})
    print(('PASS ' if ok else 'FAIL ') + name + (f' :: {str(detail)[:200]}' if detail else ''), flush=True)

def eventually(probe, ok, timeout=90, step=6):
    # Workers KV is eventually consistent (~60 s). Returns (passed, seconds_until_consistent, last_value).
    t0 = time.time(); v = probe()
    while not ok(v) and time.time() - t0 < timeout:
        time.sleep(step); v = probe()
    return ok(v), round(time.time() - t0), v

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()

def register(redirect):
    st, _, t = http('POST', BASE + '/register', {'client_name': 'ArtForge e2e', 'redirect_uris': [redirect],
        'token_endpoint_auth_method': 'none', 'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code']})
    client = json.loads(t) if t.startswith('{') else {}
    if client.get('client_id'): test_clients.append(client['client_id'])
    return st, client

def authorize_page(client_id, redirect, verifier, state):
    q = {'response_type': 'code', 'client_id': client_id, 'redirect_uri': redirect, 'state': state, 'scope': 'artforge',
         'code_challenge': b64(hashlib.sha256(verifier.encode()).digest()), 'code_challenge_method': 'S256', 'resource': RESOURCE}
    url = BASE + '/authorize?' + urllib.parse.urlencode(q)
    st, h, t = http('GET', url)
    cookies = '; '.join(c.split(';', 1)[0] for c in (h.get_all('Set-Cookie') or []))
    m = re.search(r'name="handle" value="([^"]+)"', t)
    return url, st, t, cookies, html.unescape(m.group(1)) if m else None

def submit(url, cookies, handle, decision):
    return http('POST', url, form={'handle': handle, 'decision': decision}, headers={'Cookie': cookies})

def login(label, replay=False):
    redirect = 'http://127.0.0.1:53682/callback'
    st, client = register(redirect)
    verifier, state = b64(secrets.token_bytes(48)), b64(secrets.token_bytes(12))
    url, st2, page, cookies, handle = authorize_page(client.get('client_id'), redirect, verifier, state)
    st3, h, _ = submit(url, cookies, handle, 'approve')
    loc = urllib.parse.urlparse(h.get('Location') or '')
    q = urllib.parse.parse_qs(loc.query)
    ok = st3 == 302 and q.get('state') == [state] and 'code' in q
    check(f'{label}: DCR + public consent -> authorization code (state, iss)', ok and q.get('iss') == [BASE], f'register {st}, page {st2}, submit {st3}, iss {q.get("iss")}')
    form = {'grant_type': 'authorization_code', 'code': q['code'][0], 'redirect_uri': redirect, 'client_id': client['client_id'], 'code_verifier': verifier, 'resource': RESOURCE}
    st4, _, t = http('POST', BASE + '/token', form=form)
    tok = json.loads(t)
    check(f'{label}: token exchange with PKCE', st4 == 200 and tok.get('token_type', '').lower() == 'bearer' and tok.get('access_token'), f'status {st4} expires_in {tok.get("expires_in")}')
    if replay:
        st5, _, t5 = http('POST', BASE + '/token', form=form)
        check(f'{label}: authorization code replay rejected (D1 single-use)', st5 == 400 and 'invalid_grant' in t5, st5)
        okr, secs, _ = eventually(lambda: rpc(tok['access_token'], 'ping')[0], lambda v: v == 401)
        check(f'{label}: tokens of the replayed grant revoked (KV propagation)', okr, f'after {secs}s')
    for s in (tok.get('access_token'), tok.get('refresh_token')):
        if s: args.secret.append(s)
    return client, tok

def rpc(token, method, params=None, rid=1, headers=None):
    h = {'Authorization': f'Bearer {token}', 'Accept': 'application/json, text/event-stream'}; h.update(headers or {})
    st, hd, t = http('POST', RESOURCE, {'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params or {}}, h)
    try: return st, json.loads(t) if t else None
    except Exception: return st, {'raw': t[:200]}

def call(token, name, arguments):
    return rpc(token, 'tools/call', {'name': name, 'arguments': arguments})[1]

def data_of(r):
    res = (r or {}).get('result') or {}
    if res.get('structuredContent'): return res['structuredContent']
    txt = next((c.get('text') for c in res.get('content', []) if c.get('type') == 'text'), '{}')
    try: return json.loads(txt)
    except Exception: return {'text': txt}

def is_denied(r): return bool(r) and (r.get('result') or {}).get('isError') and data_of(r).get('error', {}).get('code') == 'NOT_FOUND'

# ---------------------------------------------------------------- discovery
st, _, t = http('GET', BASE + '/.well-known/oauth-protected-resource/mcp'); prm = json.loads(t) if st == 200 else {}
check('PRM: resource and authorization_servers', st == 200 and prm.get('resource') == RESOURCE and prm.get('authorization_servers') == [BASE], prm)
st, _, t = http('GET', BASE + '/.well-known/oauth-authorization-server'); asm = json.loads(t) if st == 200 else {}
check('AS metadata: S256, DCR, iss, revocation', st == 200 and asm.get('code_challenge_methods_supported') == ['S256'] and asm.get('registration_endpoint') and asm.get('authorization_response_iss_parameter_supported') is True,
      {k: asm.get(k) for k in ('token_endpoint_auth_methods_supported', 'client_id_metadata_document_supported', 'revocation_endpoint')})
check('AS metadata: CIMD advertised with "none" auth (needed by Claude/ChatGPT CIMD)', asm.get('client_id_metadata_document_supported') is True and 'none' in (asm.get('token_endpoint_auth_methods_supported') or []), asm.get('token_endpoint_auth_methods_supported'))
st, h, _ = http('POST', RESOURCE, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
check('no token -> 401 with resource_metadata', st == 401 and 'resource_metadata=' in (h.get('WWW-Authenticate') or ''), h.get('WWW-Authenticate'))
st, _, _ = http('POST', RESOURCE, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}, {'Authorization': 'Bearer ' + b64(secrets.token_bytes(32))})
check('invented token -> 401', st == 401, st)
st, _, t = http('GET', BASE + '/')
check('landing page', st == 200 and '/mcp' in t, st)

# ---------------------------------------------------------------- consent negative paths
redirect = 'http://127.0.0.1:53682/callback'
st, client = register(redirect)
check('DCR registration', st == 201 and client.get('client_id'), st)
url, st, page, cookies, handle = authorize_page(client['client_id'], redirect, b64(secrets.token_bytes(48)), 'stateX')
check('consent page shows client and redirect host', st == 200 and handle and '127.0.0.1' in page and 'ArtForge e2e' in page, st)
check('public consent has no activation code or phone', 'access_code' not in page and 'رمز الوصول' not in page and 'wa.me' not in page)
st, h, page2 = submit(url, cookies, 'invalid-consent-handle', 'approve')
check('invalid consent handle rejected', st == 400 and not h.get('Location'), st)
url, st, page, cookies, handle = authorize_page(client['client_id'], redirect, b64(secrets.token_bytes(48)), 'stateY')
st, h, _ = submit(url, cookies, handle, 'deny')
loc = h.get('Location') or ''
check('deny -> access_denied redirect with iss', st == 302 and 'error=access_denied' in loc and 'iss=' in loc, loc[:120])
st, _, page = http('GET', BASE + '/authorize?' + urllib.parse.urlencode({'response_type': 'code', 'client_id': client['client_id'], 'redirect_uri': 'https://evil.example/cb', 'code_challenge': 'x' * 43, 'code_challenge_method': 'S256'}))
check('unregistered redirect_uri -> local error, no redirect', st == 400, st)

# ---------------------------------------------------------------- two users
login('replay probe', replay=True)
client_a, tok_a = login('user A')
client_b, tok_b = login('user B')
A, B = tok_a['access_token'], tok_b['access_token']
st, init = rpc(A, 'initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'e2e', 'version': '1'}})
check('initialize via gateway', st == 200 and init['result']['protocolVersion'] == '2025-06-18', init.get('result', {}).get('serverInfo'))
st, init2 = rpc(A, 'initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'e2e', 'version': '1'}})
check('initialize with newer protocol negotiates down', st == 200 and init2['result']['protocolVersion'] == '2025-06-18', init2['result']['protocolVersion'])
st, _ = rpc(A, 'notifications/initialized', rid=None)
tools = [x['name'] for x in rpc(A, 'tools/list')[1]['result']['tools']]
check('tools/list: 12 tools including generator', len(tools) == 12 and 'artforge_generate_image' in tools, tools)
if args.generation_only:
    spec = {'action':'submit','operationId':'release_'+secrets.token_hex(8),'prompt':'A refined editorial illustration of a quiet blue reading chair, a warm brass lamp and an open book beside a moonlit window, coherent geometry, no text','width':512,'height':512,'seed':42}
    started=time.time()
    first=call(A,'artforge_generate_image',spec); job=data_of(first).get('jobId')
    check('public generation accepted', bool(job), data_of(first))
    if job:
        ok, seconds, final=eventually(lambda:call(A,'artforge_generate_image',{'action':'get','jobId':job}),lambda r:data_of(r).get('state') in ('succeeded','failed'),timeout=100,step=2)
        images=[c for c in final.get('result',{}).get('content',[]) if c.get('type')=='image']
        check('live Workers AI returns inline image',ok and data_of(final).get('state')=='succeeded' and bool(images),str(data_of(final))+' elapsed='+str(round(time.time()-started,2)))
        if images:
            image=images[0]
            path=args.out+'.'+('jpg' if image['mimeType']=='image/jpeg' else 'png')
            open(path,'wb').write(base64.b64decode(image['data']))
            check('image saved for independent visual inspection',True,path)
        repeat=call(A,'artforge_generate_image',spec)
        check('live idempotency same job',data_of(repeat).get('jobId')==job)
        denied=call(B,'artforge_generate_image',{'action':'get','jobId':job})
        check('live cross-user image access denied',data_of(denied).get('error',{}).get('code')=='GENERATION_NOT_FOUND')
        bad=call(A,'artforge_generate_image',{**spec,'width':1024})
        check('live invalid dimensions denied',data_of(bad).get('error',{}).get('code')=='INVALID_GENERATION_REQUEST')
        deleted=call(A,'artforge_generate_image',{'action':'delete','jobId':job})
        check('live deletion removes returned image',data_of(deleted).get('state')=='deleted' and not any(c.get('type')=='image' for c in deleted.get('result',{}).get('content',[])))
    args.auth_only=True
if args.auth_only:
    json.dump({'base': BASE, 'testClientIds': test_clients, 'results': results, 'passed': sum(r['ok'] for r in results), 'total': len(results)}, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('SUMMARY', sum(r['ok'] for r in results), '/', len(results))
    raise SystemExit(0 if all(r['ok'] for r in results) else 1)
scene = {'version': 1, 'elements': [{'id': 'plate', 'description': 'poster'}], 'layers': [{'id': 'page'}], 'operations': [
    {'op': 'draw.rect', 'element': 'plate', 'layer': 'page', 'params': {'x': 0, 'y': 0, 'w': 700, 'h': 350, 'fill': '#111e33'}},
    {'op': 'draw.text', 'element': 'plate', 'layer': 'page', 'params': {'text': 'تجربة الرسم العربي', 'x': 630, 'y': 105, 'align': 'right', 'rtl': True, 'maxWidth': 570, 'fill': '#fff6e1', 'font': {'family': 'Tajawal', 'size': 40, 'weight': 700}}}]}
t0 = time.time()
r = call(A, 'artforge_create_design', {'prompt': 'ملصق اختبار بسيط', 'width': 700, 'height': 350, 'sceneSpec': scene})
d = data_of(r); doc_a, plan_a = d.get('documentId'), d.get('planId')
img = next((c['data'] for c in r['result']['content'] if c['type'] == 'image'), '')
check('A: Arabic design via gateway, text verified, PNG returned', d.get('success') and d.get('verification', {}).get('texts') == {'expected': 1, 'matched': 1} and base64.b64decode(img)[:4] == b'\x89PNG', f'{time.time()-t0:.1f}s doc {bool(doc_a)}')
r = call(A, 'artforge_tool_op', {'op': 'batch', 'params': {'documentId': doc_a, 'ops': [{'op': 'draw.rect', 'params': {'x': 30, 'y': 190, 'w': 110, 'h': 40, 'fill': '#eeb44e'}}]}})
check('A: edit own document (batch)', not r['result'].get('isError'))
for fmt in ('png', 'webp'):
    r = call(A, 'artforge_export', {'documentId': doc_a, 'format': fmt})
    check(f'A: export {fmt}', not r['result'].get('isError') and any(c['type'] == 'image' for c in r['result']['content']))
r = call(A, 'artforge_export', {'documentId': doc_a, 'format': 'pdf'})
check('trial restriction kept: PDF export refused', r.get('error', {}).get('code') == -32602, r.get('error'))
r = call(A, 'artforge_create_design', {'prompt': 'x', 'width': 1601})
check('trial restriction kept: width 1601 refused', r.get('error', {}).get('code') == -32602, r.get('error'))
# isolation
check('B cannot read A document (document.info)', is_denied(call(B, 'artforge_tool_op', {'op': 'document.info', 'params': {'documentId': doc_a}})))
check('B cannot export A document', is_denied(call(B, 'artforge_export', {'documentId': doc_a, 'format': 'png'})))
check('B cannot edit A document', is_denied(call(B, 'artforge_tool_op', {'op': 'batch', 'params': {'documentId': doc_a, 'ops': [{'op': 'draw.rect', 'params': {'x': 0, 'y': 0, 'w': 5, 'h': 5}}]}})))
check('B cannot execute A plan', is_denied(call(B, 'artforge_execute_design', {'planId': plan_a})))
check('B cannot reuse A document id inside a batch op', is_denied(call(B, 'artforge_tool_op', {'op': 'batch', 'ops': [{'op': 'draw.rect', 'params': {'documentId': doc_a, 'x': 0, 'y': 0, 'w': 5, 'h': 5}}]})))
sa, sb = data_of(call(A, 'artforge_status', {})), data_of(call(B, 'artforge_status', {}))
ids = lambda s: {x.get('id') or x.get('documentId') for x in s.get('documents', [])}
check('status scoped per user (A sees own doc, B sees none of A)', doc_a in ids(sa) and doc_a not in ids(sb) and 'url' not in json.dumps(sb.get('drawingTool', {})), {'A': len(ids(sa)), 'B': len(ids(sb))})
r = call(B, 'artforge_create_design', {'prompt': 'بطاقة', 'width': 400, 'height': 300})
doc_b = data_of(r).get('documentId')
check('B: own design works', data_of(r).get('success') and doc_b and doc_b != doc_a)
check('A cannot read B document', is_denied(call(A, 'artforge_tool_op', {'op': 'document.info', 'params': {'documentId': doc_b}})))
# token lifecycle
def do_refresh():
    st, _, t = http('POST', BASE + '/token', form={'grant_type': 'refresh_token', 'refresh_token': tok_a['refresh_token'], 'client_id': client_a['client_id']})
    return st, t
okf, secs_f, (st, t) = eventually(do_refresh, lambda v: v[0] == 200)
new = json.loads(t) if t.startswith('{') else {}
if new.get('access_token'): args.secret.extend([new['access_token'], new.get('refresh_token', '')])
check('refresh token rotation issues a working token', st == 200 and new.get('refresh_token') != tok_a['refresh_token'] and rpc(new['access_token'], 'ping')[0] == 200, (st, f'consistent after {secs_f}s', t[:120] if st != 200 else ''))
rev = asm.get('revocation_endpoint') or (BASE + '/token')
st, _, _ = http('POST', rev, form={'token': B, 'client_id': client_b['client_id']})
okv, secs_v, st2 = eventually(lambda: rpc(B, 'ping')[0], lambda v: v == 401)
check('revoked access token -> 401 (KV propagation)', st == 200 and okv, (st, st2, f'after {secs_v}s'))
if args.origin:
    st, _, _ = http('POST', args.origin.rstrip('/') + '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
    check('engine origin without its token -> 401 (direct bypass blocked)', st == 401, st)
# CIMD with real public client documents
if not args.skip_cimd:
    for name, cid, red in [('Claude Code CIMD (loopback, any port)', 'https://claude.ai/oauth/claude-code-client-metadata', 'http://localhost:47123/callback'),
                           ('ChatGPT CIMD', 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect')]:
        url, st, page, _, handle = authorize_page(cid, red, b64(secrets.token_bytes(48)), 's')
        check(f'{name}: consent page from fetched metadata', st == 200 and bool(handle), f'status {st}; ' + re.sub(r'<[^>]+>', ' ', page)[:160].strip())

blob = '\n'.join(seen)
leaks = [s[:6] + '…' for s in args.secret if s and s in blob]
leaks += [m for m in re.findall(r'\b[A-Z]:\\\\[A-Za-z]|[Uu]sers(?:\\\\|/)[A-Za-z]|/home/[a-z]|onrender\.com|127\.0\.0\.1:\d{4,5}/mcp', blob)][:5]
check('no secrets, engine origin or host paths in any response', not leaks, leaks)
json.dump({'base': BASE, 'testClientIds': test_clients, 'results': results, 'passed': sum(r['ok'] for r in results), 'total': len(results)}, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('SUMMARY', sum(r['ok'] for r in results), '/', len(results))
