import json
import sys
import urllib.parse
from pathlib import Path

import numpy as np
import soundfile as sf

records = json.loads(sys.stdin.read())
output = []
for record in records:
    file_url = record['file']
    parsed = urllib.parse.urlparse(file_url)
    path = urllib.parse.parse_qs(parsed.query).get('path', [file_url])[0]
    audio, rate = sf.read(path, always_2d=True)
    output.append({
        'taskId': record['taskId'], 'requestedModel': record['requestedModel'], 'actualModel': record['dit_model'],
        'file': path, 'fileBytes': Path(path).stat().st_size, 'sampleRate': rate, 'channels': audio.shape[1],
        'duration': audio.shape[0] / rate, 'finite': bool(np.isfinite(audio).all()),
        'peak': float(np.abs(audio).max()), 'rms': float(np.sqrt(np.mean(audio**2))),
        'clippedFraction': float(np.mean(np.abs(audio) >= 1.0)),
        'generationInfo': record.get('generation_info'),
    })
print(json.dumps(output))
