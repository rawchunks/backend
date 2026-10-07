"""An audio recording is not an adapter: verify rejection without modifying a model."""
import json
import os
import urllib.request
import urllib.error

base='http://127.0.0.1:8001'
headers={'Authorization':'Bearer '+os.environ.get('ACESTEP_API_KEY',''),'Content-Type':'application/json'}
def request(path,payload=None):
 req=urllib.request.Request(base+path,headers=headers,data=None if payload is None else json.dumps(payload).encode())
 try:
  with urllib.request.urlopen(req,timeout=15) as res:return {'status':res.status,'data':json.load(res)}
 except urllib.error.HTTPError as e:return {'status':e.code,'data':json.load(e)}
print(json.dumps({'before':request('/v1/lora/status'),'attempt':request('/v1/lora/load',{'lora_path':'/tmp/rawchunks-preprod-audit/vocal.wav'}),'after':request('/v1/lora/status')}))
