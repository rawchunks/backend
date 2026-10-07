import json
import numpy as np
import soundfile as sf
from pathlib import Path

outputs=[]
for kind in ['vocal','mixed']:
 data=json.loads(Path('/tmp/rawchunks-preprod-audit/'+kind+'-separation.json').read_text())
 for name,url in data['body']['data']['stems'].items():
  path=url.split('path=',1)[1];audio,rate=sf.read(path,always_2d=True)
  outputs.append({'sample':kind,'stem':name,'sampleRate':rate,'duration':audio.shape[0]/rate,'channels':audio.shape[1],
  'finite':bool(np.isfinite(audio).all()),'peak':float(np.abs(audio).max()),'rms':float(np.sqrt(np.mean(audio**2)))})
print(json.dumps(outputs))
