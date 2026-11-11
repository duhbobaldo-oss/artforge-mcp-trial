"""Real public OAuth -> drawing -> reference -> Workers AI -> isolated result.
Never prints or saves tokens. Creates disposable OAuth connections and one image job.
Usage: python -I cloudflare-gateway/test/e2e-reference.py --base https://... --out evidence.json
"""
import argparse, base64, hashlib, html, json, re, secrets, time, urllib.parse
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

p=argparse.ArgumentParser();p.add_argument('--base',required=True);p.add_argument('--out',required=True)
args=p.parse_args();BASE=args.base.rstrip('/');RESOURCE=BASE+'/mcp';checks=[];evidence={}
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*a,**k):return None
opener=build_opener(NoRedirect)
def http(method,url,body=None,form=None,headers=None):
    h={'User-Agent':'ArtForge-reference-e2e/1.0',**(headers or {})};data=None
    if form is not None:data=urllib.parse.urlencode(form).encode();h['Content-Type']='application/x-www-form-urlencoded'
    elif body is not None:data=json.dumps(body).encode();h['Content-Type']='application/json'
    try:
        with opener.open(Request(url,data=data,headers=h,method=method),timeout=150) as r:return r.status,r.headers,r.read()
    except HTTPError as e:return e.code,e.headers,e.read()
def check(name,ok):
    checks.append({'check':name,'ok':bool(ok)});print(('PASS 'if ok else'FAIL ')+name,flush=True)
    if not ok:raise RuntimeError(name)
def b64(b):return base64.urlsafe_b64encode(b).decode().rstrip('=')
def login():
    redirect='http://127.0.0.1:53682/callback'
    st,_,raw=http('POST',BASE+'/register',{'client_name':'ArtForge reference acceptance','redirect_uris':[redirect],
        'token_endpoint_auth_method':'none','grant_types':['authorization_code','refresh_token'],'response_types':['code']})
    client=json.loads(raw);check('DCR registration',st==201 and client.get('client_id'));evidence.setdefault('testClientIds',[]).append(client['client_id'])
    verifier=b64(secrets.token_bytes(48));state=b64(secrets.token_bytes(12))
    query={'response_type':'code','client_id':client['client_id'],'redirect_uri':redirect,'state':state,'scope':'artforge',
        'code_challenge':b64(hashlib.sha256(verifier.encode()).digest()),'code_challenge_method':'S256','resource':RESOURCE}
    url=BASE+'/authorize?'+urllib.parse.urlencode(query);st,h,raw=http('GET',url)
    match=re.search(r'name="handle" value="([^"]+)"',raw.decode());check('public OAuth consent',st==200 and match)
    cookies='; '.join(c.split(';',1)[0]for c in(h.get_all('Set-Cookie')or[]))
    st,h,_=http('POST',url,form={'handle':html.unescape(match.group(1)),'decision':'approve'},headers={'Cookie':cookies})
    q=urllib.parse.parse_qs(urllib.parse.urlparse(h.get('Location')or'').query)
    check('authorization transaction state and issuer',st==302 and q.get('state')==[state]and q.get('iss')==[BASE]and q.get('code'))
    st,_,raw=http('POST',BASE+'/token',form={'grant_type':'authorization_code','code':q['code'][0],
        'redirect_uri':redirect,'client_id':client['client_id'],'code_verifier':verifier,'resource':RESOURCE})
    token=json.loads(raw);check('PKCE token exchange',st==200 and token.get('access_token'))
    return token['access_token']
def rpc(token,method,params=None):
    st,_,raw=http('POST',RESOURCE,{'jsonrpc':'2.0','id':1,'method':method,'params':params or{}},headers={'Authorization':'Bearer '+token})
    if st!=200:raise RuntimeError('MCP HTTP '+str(st))
    return json.loads(raw)
def call(token,name,arguments):return rpc(token,'tools/call',{'name':name,'arguments':arguments})
def data(reply):
    r=reply.get('result',{});return r.get('structuredContent')or json.loads(next(c['text']for c in r['content']if c['type']=='text'))
def denied(reply):return bool(reply.get('result',{}).get('isError'))
def drawing_spec():
    ops=[]
    def rect(e,x,y,w,h,fill,radius=0):ops.append({'op':'draw.rect','layer':'art','element':e,'params':{'x':x,'y':y,'w':w,'h':h,'fill':fill,'radius':radius}})
    rect('room',0,0,512,512,'#c58c60');rect('floor',0,350,512,162,'#845b47')
    for y in range(20,350,40):rect('room',0,y,512,2,'#8a5e46')
    rect('fireplace',182,70,148,280,'#b8aa96',12);rect('fireplace',200,210,112,125,'#302833',32)
    rect('fire',225,259,57,64,'#ffd67d',20)
    for x in [50,365]:rect('armchair'+str(x),x,250,98,146,'#578b80',28)
    rect('table',150,365,215,45,'#d7ad7a',20);rect('book',218,369,80,27,'#f5e7ca',3)
    return {'version':1,'layers':[{'id':'art'}],'elements':[{'id':e,'description':e}for e in sorted(set(o['element']for o in ops))],'operations':ops}

try:
    alice=login();bob=login()
    tools=rpc(alice,'tools/list')['result']['tools'];tool=next(t for t in tools if t['name']=='artforge_generate_image')
    check('public discovery advertises documentId','documentId'in tool['inputSchema']['properties'])
    status=call(alice,'artforge_tool_op',{'op':'generation.status'});check('cached-client generation status',data(status).get('imageToImage')is True)
    created=call(alice,'artforge_create_design',{'prompt':'رسم كرتوني','width':512,'height':512,'preview':False,'sceneSpec':drawing_spec()})
    created_data=data(created);evidence['creation']={'error':created_data.get('error')or created.get('error'),'success':created_data.get('success'),'issues':created_data.get('verification',{}).get('issues')}
    document=created_data.get('documentId');check('real renderer creates the source drawing',bool(document)and not denied(created))
    evidence['documentId']=document
    captured=call(alice,'artforge_tool_op',{'op':'document.preview','params':{'documentId':document,'maxWidth':511,'static':True}})
    source=data(captured).get('result',{}).get('base64');check('source PNG can be independently read',isinstance(source,str))
    expected=hashlib.sha256(base64.b64decode(source)).hexdigest();evidence['referenceSha256']=expected
    submit={'action':'submit','operationId':'reference-'+secrets.token_hex(8),'documentId':document,
        'prompt':'Transform image 0 into a charming polished 3D cartoon cabin interior. Preserve its two green armchairs, center fireplace, wood walls and coffee table with open book. Rounded plush shapes and soft warm lighting.',
        'width':512,'height':512,'seed':7}
    rejected=call(bob,'artforge_generate_image',submit)
    check('cross-connection source denied before generation',data(rejected).get('error',{}).get('code')=='GENERATION_REFERENCE_NOT_FOUND')
    started=call(alice,'artforge_generate_image',submit);job=data(started);evidence['submission']=job
    check('owned drawing submitted to public generator',not denied(started)and job.get('jobId'))
    evidence['jobId']=job['jobId'];check('submit provenance matches independently rendered PNG',job.get('source',{}).get('referenceSha256')==expected)
    repeat=call(alice,'artforge_generate_image',submit);check('duplicate submit reuses durable job',data(repeat).get('jobId')==job['jobId'])
    for _ in range(40):
        current=call(alice,'artforge_generate_image',{'action':'get','jobId':job['jobId']});state=data(current)
        if state.get('state')!='running':break
        time.sleep(2)
    check('real Workers AI image-to-image succeeded',state.get('state')=='succeeded')
    check('result carries source provenance',state.get('source',{}).get('mode')=='image-to-image'and state['source']['referenceSha256']==expected)
    image=next((c for c in current['result']['content']if c['type']=='image'),None);check('generated image is delivered',bool(image))
    evidence['result']=state;evidence['imageSha256']=hashlib.sha256(base64.b64decode(image['data'])).hexdigest()
    image_file=Path(args.out).with_suffix('.'+('png'if image['mimeType']=='image/png'else'jpg'));image_file.write_bytes(base64.b64decode(image['data']));evidence['imageFile']=str(image_file)
    for action in ['get','cancel','delete']:
        other=call(bob,'artforge_generate_image',{'action':action,'jobId':job['jobId']})
        check('cross-connection '+action+' denied',data(other).get('error',{}).get('code')=='GENERATION_NOT_FOUND')
    cancelled=call(alice,'artforge_generate_image',{'action':'cancel','jobId':job['jobId']});check('cancel completed job preserves result',data(cancelled).get('state')=='succeeded')
    removed=call(alice,'artforge_generate_image',{'action':'delete','jobId':job['jobId']});check('owner deletion purges image',data(removed).get('state')=='deleted'and not any(c['type']=='image'for c in removed['result']['content']))
    again=call(alice,'artforge_generate_image',{'action':'get','jobId':job['jobId']});check('deleted state persists',data(again).get('state')=='deleted')
    evidence['ok']=True
except Exception as e:
    evidence['ok']=False;evidence['error']=str(e)[:120]
finally:
    evidence['checks']=checks;Path(args.out).write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'ok':evidence['ok'],'passed':sum(c['ok']for c in checks),'checks':len(checks)},ensure_ascii=False),flush=True)
if not evidence['ok']:raise SystemExit(1)
