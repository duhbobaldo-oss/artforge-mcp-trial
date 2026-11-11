"""Diagnose refresh-token behaviour on the deployed gateway: login, then refresh after several delays."""
import base64, hashlib, html, json, re, secrets, sys, time, urllib.parse
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler, HTTPHandler, HTTPSHandler

BASE = sys.argv[1].rstrip('/')
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
op = build_opener(NoRedirect, HTTPHandler, HTTPSHandler)
def http(method, url, form=None, body=None, headers=None):
    h = {'User-Agent': 'ArtForge-gateway-test/1.0', **(headers or {})}; data = None
    if form is not None: data = urllib.parse.urlencode(form).encode(); h['Content-Type'] = 'application/x-www-form-urlencoded'
    if body is not None: data = json.dumps(body).encode(); h['Content-Type'] = 'application/json'
    try: r = op.open(Request(url, data=data, headers=h, method=method), timeout=60); return r.status, r.headers, r.read().decode()
    except HTTPError as e: return e.code, e.headers, e.read().decode()
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
red = 'http://127.0.0.1:53682/callback'
_, _, t = http('POST', BASE + '/register', body={'client_name': 'refresh probe', 'redirect_uris': [red], 'token_endpoint_auth_method': 'none', 'grant_types': ['authorization_code', 'refresh_token']})
reg = json.loads(t); cid = reg['client_id']
print('registered grant_types:', reg.get('grant_types'), 'auth:', reg.get('token_endpoint_auth_method'))
ver = b64(secrets.token_bytes(48))
q = {'response_type': 'code', 'client_id': cid, 'redirect_uri': red, 'state': 's', 'scope': 'artforge', 'resource': BASE + '/mcp',
     'code_challenge': b64(hashlib.sha256(ver.encode()).digest()), 'code_challenge_method': 'S256'}
url = BASE + '/authorize?' + urllib.parse.urlencode(q)
_, h, page = http('GET', url)
cookie = '; '.join(c.split(';', 1)[0] for c in h.get_all('Set-Cookie'))
handle = html.unescape(re.search(r'name="handle" value="([^"]+)"', page).group(1))
_, h, _ = http('POST', url, form={'handle': handle, 'decision': 'approve'}, headers={'Cookie': cookie})
code = urllib.parse.parse_qs(urllib.parse.urlparse(h['Location']).query)['code'][0]
_, _, t = http('POST', BASE + '/token', form={'grant_type': 'authorization_code', 'code': code, 'redirect_uri': red, 'client_id': cid, 'code_verifier': ver, 'resource': BASE + '/mcp'})
tok = json.loads(t); rt = tok['refresh_token']
for delay in [0, 5, 20, 60]:
    time.sleep(delay)
    st, _, t = http('POST', BASE + '/token', form={'grant_type': 'refresh_token', 'refresh_token': rt, 'client_id': cid})
    body = json.loads(t) if t.startswith('{') else {'raw': t[:120]}
    print(f'refresh after +{delay}s -> {st}', {k: body.get(k) for k in ('error', 'error_description', 'token_type', 'expires_in')})
    if st == 200:
        rt = body['refresh_token']; acc0 = body['access_token']
        st2, _, _ = http('POST', BASE + '/mcp', body={'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, headers={'Authorization': 'Bearer ' + body['access_token']})
        print('  new access token ping ->', st2)
        break

# --- revocation timing (KV eventual consistency)
st, _, t = http('POST', BASE + '/token', form={'grant_type': 'refresh_token', 'refresh_token': rt, 'client_id': cid})
print('immediate second refresh with rotated token ->', st)
acc = acc0
ping = lambda: http('POST', BASE + '/mcp', body={'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, headers={'Authorization': 'Bearer ' + acc})[0]
print('before revoke ping ->', ping())
print('revoke ->', http('POST', BASE + '/token/revoke' if False else BASE + '/token', form={'token': acc, 'client_id': cid, 'token_type_hint': 'access_token'})[0])
t0 = time.time()
for _ in range(16):
    st = ping(); el = round(time.time() - t0)
    print(f'  +{el}s ping -> {st}')
    if st == 401: break
    time.sleep(8)
