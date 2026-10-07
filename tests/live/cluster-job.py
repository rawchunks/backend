"""Read-only or bounded worker calls run inside the existing GPU pod.
Never print credentials. Mutations are limited to release_task when passed an explicit audited payload.
"""
import json
import os
import sys
import urllib.request
import urllib.error

def call(path, payload=None):
    request=urllib.request.Request('http://127.0.0.1:8001'+path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Authorization':'Bearer '+os.environ.get('ACESTEP_API_KEY',''),'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:return {'httpStatus':response.status,'body':json.load(response)}
    except urllib.error.HTTPError as error:
        return {'httpStatus':error.code,'body':json.load(error)}

operation=sys.argv[1]
if operation=='query':
    print(json.dumps(call('/query_result',{'task_id_list':sys.argv[2:],'task_ids':sys.argv[2:]})))
elif operation=='health':print(json.dumps(call('/health')))
elif operation=='stats':print(json.dumps(call('/v1/stats')))
elif operation=='separate':
    path=sys.argv[2]
    assert path in ['/tmp/rawchunks-preprod-audit/vocal.wav','/tmp/rawchunks-preprod-audit/mixed.wav']
    print(json.dumps(call('/separate',{'src_audio_path':path,'stem_type':sys.argv[3]})))
elif operation=='release':
    data=json.loads(sys.stdin.read())
    assert data.get('audio_duration',0)<=60 and data.get('batch_size',1)==1
    assert data.get('model') in ['acestep-v15-xl-turbo','acestep-v15-xl-base','acestep-v15-xl-sft']
    print(json.dumps(call('/release_task',data)))
else:raise ValueError('Unsupported operation')
