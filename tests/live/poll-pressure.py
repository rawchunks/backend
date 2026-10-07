import concurrent.futures
import json
import os
import time
import urllib.request

task_ids = json.loads(os.environ.get('RAWCHUNKS_AUDIT_TASK_IDS', '[]'))
# Read-only worker queries. No new generation, training, uploads or mutations.
def query(index):
 start=time.monotonic()
 body=json.dumps({'task_id_list':task_ids}).encode()
 request=urllib.request.Request('http://127.0.0.1:8001/query_result',data=body,headers={'Authorization':'Bearer '+os.environ.get('ACESTEP_API_KEY',''),'Content-Type':'application/json'})
 with urllib.request.urlopen(request,timeout=15) as response:
  data=json.load(response)
  return {'request':index,'status':response.status,'seconds':time.monotonic()-start,'items':len(data.get('data',[]))}
with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
 results=list(pool.map(query,range(20)))
print(json.dumps(results))
