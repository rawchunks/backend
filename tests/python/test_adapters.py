"""Real filesystem/hash validation for inference artifact materialization."""
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import pytest

spec = importlib.util.spec_from_file_location('artifact_validation', Path(__file__).resolve().parents[2] / 'worker/overlay/acestep/api/adapters.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

@pytest.fixture
def artifact(tmp_path, monkeypatch):
    model = 'acestep-v15-xl-sft'
    directory = tmp_path/model
    directory.mkdir()
    (directory/'model.safetensors').write_bytes(b'checkpoint-weights')
    (directory/'config.json').write_text('{}')
    fingerprint = module.checkpoint_fingerprint(directory)
    files = {'adapter_config.json':b'{"peft_type":"LORA"}', 'adapter_model.safetensors':b'trained-weights'}
    manifest = {'schema_version':1,'model':model,'checkpoint_fingerprint':fingerprint,'files':[{'filename':name,'digest':hashlib.sha256(body).hexdigest()} for name,body in files.items()], 'metrics':{'optimizer_steps':10,'final_loss':.2,'effective_update_norm':.7}}
    state=SimpleNamespace(_checkpoint_dir=str(tmp_path),checkpoint_fingerprints={model:fingerprint})
    def materialize(overrides=None):
        data = {**manifest, **(overrides or {})}
        content = json.dumps(data).encode()
        files['manifest.json']=content
        digest=hashlib.sha256(content).hexdigest()
        monkeypatch.setattr(module,'_download',lambda url,target,maximum:Path(target).write_bytes(files[Path(url).name]))
        return module.materialize_adapter(state, 'https://pub-1b122472089542a8826ac7f695328c46.r2.dev/voice/manifest.json', digest, model)
    return SimpleNamespace(materialize=materialize,files=files,manifest=manifest)

def test_validated_artifact_is_immutable_digest_keyed_cache(artifact):
    first=artifact.materialize()
    assert Path(first,'adapter_config.json').is_file()
    assert first == artifact.materialize()

def test_corrupted_cached_weights_fail_before_gpu(artifact):
    first=artifact.materialize()
    Path(first,'adapter_model.safetensors').write_bytes(b'corrupted')
    with pytest.raises(ValueError,match='checksum mismatch'):artifact.materialize()

@pytest.mark.parametrize('overrides',[
 {'model':'acestep-v15-xl-turbo'},
 {'checkpoint_fingerprint':'0'*64},
 {'metrics':{'optimizer_steps':0,'final_loss':.2,'effective_update_norm':1}},
 {'metrics':{'optimizer_steps':1,'final_loss':float('nan'),'effective_update_norm':1}},
 {'metrics':{'optimizer_steps':1,'final_loss':.2,'effective_update_norm':0}},
 {'files':[{'filename':'../outside','digest':'a'*64}]},
])
def test_incompatible_failed_or_unsafe_manifest_is_rejected(artifact,overrides):
    with pytest.raises(ValueError):artifact.materialize(overrides)

def test_outside_object_store_rejected_without_request(tmp_path):
    with pytest.raises(ValueError,match='configured LoRA'):module._download('https://example.com/adapter',tmp_path/'artifact',100)
