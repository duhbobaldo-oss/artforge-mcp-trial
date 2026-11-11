import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import secrets
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

p = argparse.ArgumentParser()
p.add_argument('--base', default='http://127.0.0.1:8799')
p.add_argument('--out', default='work/plugin-stats-results.json')
a = p.parse_args()
origin = 'https://obr.obr432.workers.dev'
ua = 'Mozilla/5.0 ArtForgeAcceptance/' + secrets.token_hex(8)
results = []

def request(action='stats', body=None, headers=None, plugin='artforge'):
    h = {'User-Agent': ua, 'Origin': origin, **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault('Content-Type', 'application/json')
    req = Request(a.base + '/api/plugins/' + plugin + '/' + action, data=data, headers=h)
    try:
        response = urlopen(req, timeout=45)
    except HTTPError as e:
        response = e
    with response:
        return response.code, response.headers, json.load(response)

def check(name, passed):
    results.append({'check': name, 'ok': bool(passed)})
    print(('PASS ' if passed else 'FAIL ') + name, flush=True)

status, headers, initial = request()
check('stats and allowed CORS', status == 200 and headers.get('Access-Control-Allow-Origin') == origin and bool(initial.get('ticket')))
check('unknown plugin rejected', request(plugin='missing-plugin')[0] == 404)
check('write without Origin rejected', request('view', {}, {'Origin': ''})[0] == 403)
check('unapproved Origin rejected', request('view', {}, {'Origin': 'https://invalid.example'})[0] == 403)
check('non-JSON write rejected', request('view', {}, {'Content-Type': 'text/plain'})[0] == 415)
check('automated write rejected', request('view', {}, {'User-Agent': 'ExampleBot'})[0] == 403)
rating = {'stars': 5, 'client': secrets.token_urlsafe(18), 'ticket': initial['ticket']}
check('fresh rating ticket rejected', request('rate', rating)[2].get('error') == 'ticket')
with ThreadPoolExecutor(max_workers=6) as pool:
    visits = list(pool.map(lambda _: request('view', {}), range(6)))
check('concurrent visits count once', sum(v[2].get('counted', False) for v in visits) == 1)
check('duplicate view not counted', request('view', {})[2].get('counted') is False)
time.sleep(2.6)
status, _, rated = request('rate', rating)
check('valid rating stored', status == 200 and rated.get('yourRating') == 5)
rating['stars'] = 3
status, _, updated = request('rate', rating)
check('rating updated without duplicate', status == 200 and updated.get('updated') and updated.get('yourRating') == 3 and updated['ratings']['count'] == rated['ratings']['count'])
check('invalid stars rejected', request('rate', {**rating, 'stars': 6})[2].get('error') == 'stars')
check('honeypot rejected', request('rate', {**rating, 'website': 'filled'})[2].get('error') == 'automated')
check('invalid signature rejected', request('rate', {**rating, 'ticket': '0.invalid'})[2].get('error') == 'ticket')
_, _, final = request()
check('written stats read back', final['ratings'] == updated['ratings'] and final['views'] == initial['views'] + 1)
check('response contains no raw visitor details', not any(k in final for k in ['ip', 'userAgent', 'voter', 'client', 'secret']))
with open(a.out, 'w', encoding='utf8') as f:
    json.dump({'passed': sum(r['ok'] for r in results), 'total': len(results), 'results': results}, f, indent=2)
print('SUMMARY', sum(r['ok'] for r in results), '/', len(results))
raise SystemExit(0 if all(r['ok'] for r in results) else 1)
