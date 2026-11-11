"""Real Claude Code OAuth against the deployed gateway, headless.
1. `claude mcp add --scope local` in a throwaway project folder (removed at the end).
2. `claude mcp login --no-browser`: read the authorization URL Claude Code prints.
3. Complete the public consent page (as a person would), get the redirect URL.
4. Deliver it to Claude Code: GET the loopback callback, or paste it on stdin.
5. `claude -p` uses the server with the stored OAuth token; then `claude mcp remove`.
Usage: python test/claude_code_oauth.py <gateway-base> [--draw]"""
import html, json, os, re, shutil, subprocess, sys, threading, time, urllib.parse
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler, HTTPHandler, HTTPSHandler, urlopen

BASE = sys.argv[1].rstrip('/'); DRAW = '--draw' in sys.argv
NAME = 'artforge-trial-test'
proj = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tmp-claude-code-test')
os.makedirs(proj, exist_ok=True)
sh = os.name == 'nt'
def run(args, **kw): return subprocess.run(['claude', *args], cwd=proj, capture_output=True, text=True, encoding='utf-8', errors='replace', shell=sh, **kw)
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
op = build_opener(NoRedirect, HTTPHandler, HTTPSHandler)
def http(method, url, form=None, headers=None):
    data = urllib.parse.urlencode(form).encode() if form else None
    h = {'User-Agent': 'ArtForge-gateway-test/1.0', **(headers or {})}
    if form: h['Content-Type'] = 'application/x-www-form-urlencoded'
    try: r = op.open(Request(url, data=data, headers=h, method=method), timeout=60); return r.status, r.headers, r.read().decode('utf-8', 'replace')
    except HTTPError as e: return e.code, e.headers, e.read().decode('utf-8', 'replace')

report = {}
run(['mcp', 'remove', NAME, '--scope', 'local'])
add = run(['mcp', 'add', '--transport', 'http', '--scope', 'local', NAME, BASE + '/mcp'])
report['add'] = add.returncode
cap = os.path.join(proj, '..', 'tmp-captured-url.txt')
if os.path.exists(cap): os.remove(cap)
benv = dict(os.environ, BROWSER='node ' + os.path.join(os.path.dirname(os.path.abspath(__file__)), 'capture-url.cjs'))
EXTERNAL = '--external-login' in sys.argv  # login runs in a real terminal (TTY); we only finish the consent
class _Done:
    returncode = None
    stdout = []
    def poll(self): return None
    def wait(self, timeout=None): time.sleep(15)
    def kill(self): pass
proc = _Done() if EXTERNAL else subprocess.Popen(['claude', 'mcp', 'login', NAME], cwd=proj, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, env=benv,
                        stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', shell=sh, bufsize=1)
lines, auth_url = [], None
def reader():
    for line in proc.stdout: lines.append(line)
threading.Thread(target=reader, daemon=True).start()
t0 = time.time()
if EXTERNAL: print('READY: run the login in a terminal now', flush=True)
while time.time() - t0 < (240 if EXTERNAL else 60) and not auth_url:
    src = ''.join(lines) + (open(cap, encoding='utf-8').read() if os.path.exists(cap) else '')
    m = re.search(r'https://\S+/authorize\?\S+', src)
    if m: auth_url = m.group(0)
    time.sleep(0.2)
report['authorize_url_printed'] = bool(auth_url)
if auth_url:
    q = urllib.parse.parse_qs(urllib.parse.urlparse(auth_url).query)
    report['client_id_kind'] = 'CIMD' if q.get('client_id', [''])[0].startswith('https://') else 'DCR'
    report['redirect_uri'] = re.sub(r':\d+/', ':<port>/', q.get('redirect_uri', [''])[0])
    report['pkce'] = q.get('code_challenge_method')
    report['resource'] = q.get('resource')
    st, h, page = http('GET', auth_url)
    cookie = '; '.join(c.split(';', 1)[0] for c in (h.get_all('Set-Cookie') or []))
    m = re.search(r'name="handle" value="([^"]+)"', page)
    if not m:
        print('DEBUG status', st, 'params', sorted(q.keys()), 'url_len', len(auth_url))
        print('DEBUG page', re.sub(r'<style>.*?</style>|<[^>]+>', ' ', page, flags=re.S)[:300])
        print('DEBUG lines', re.sub(r'(code_challenge|state)=[^&\s]+', r'\1=x', ''.join(lines))[:600])
        proc.kill(); run(['mcp', 'remove', NAME, '--scope', 'local']); sys.exit(1)
    handle = html.unescape(m.group(1))
    report['consent_page'] = st
    st, h, _ = http('POST', auth_url, form={'handle': handle, 'decision': 'approve'}, headers={'Cookie': cookie})
    location = h.get('Location') or ''
    report['consent_redirect'] = st == 302 and 'code=' in location
    delivered = 'none'
    report['login_alive_before_callback'] = proc.poll() is None
    report['login_output_before_callback'] = re.sub(r'(code_challenge|state)=[^&\s]+', r'\1=x', ''.join(lines))[-500:]
    try:
        with urlopen(Request(location, headers={'User-Agent': 'ArtForge-gateway-test/1.0'}), timeout=15) as r: delivered = f'loopback {r.status}'
    except (HTTPError, URLError, OSError) as e:
        delivered = f'loopback refused ({type(e).__name__})'
    report['delivered'] = delivered
try: proc.wait(timeout=90)
except subprocess.TimeoutExpired: proc.kill()
report['login_exit'] = proc.returncode
report['login_output_tail'] = re.sub(r'(code|token|state)=[^&\s]+', r'\1=<redacted>', ''.join(lines)[-400:])
lst = run(['mcp', 'get', NAME])
report['mcp_get'] = re.sub(r'\s+', ' ', lst.stdout)[:300]
prompt = ('Use the MCP server tools. First call artforge_capabilities once. ' +
          ('Then call artforge_create_design once with prompt "بطاقة ترحيب" width 800 height 500 and the Arabic headline "أهلًا بكم في OBR". ' if DRAW else '') +
          'Reply only with a JSON object: {"tools_visible": <number of artforge tools you can see>, "capabilities_ok": true/false' +
          (', "design_success": ..., "texts": ...' if DRAW else '') + '}')
t0 = time.time()
p = run(['-p', prompt, '--allowedTools', f'mcp__{NAME}__artforge_capabilities,mcp__{NAME}__artforge_create_design', '--output-format', 'json'], timeout=400)
try: out = json.loads(p.stdout); report['claude_p'] = {'is_error': out.get('is_error'), 'result': out.get('result'), 'seconds': round(time.time() - t0, 1)}
except Exception: report['claude_p'] = {'raw': p.stdout[-500:], 'stderr': p.stderr[-300:]}
run(['mcp', 'remove', NAME, '--scope', 'local'])
shutil.rmtree(proj, ignore_errors=True)
print(json.dumps(report, ensure_ascii=False, indent=1))
