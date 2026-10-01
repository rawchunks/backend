"""Actual PEFT CPU adapter isolation using installed lifecycle and GPU-gate code."""
import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[2] / 'worker/overlay/acestep'


def production_unload():
    torch = pytest.importorskip('torch', reason='Actual PEFT CPU sequence executes in worker')
    peft = pytest.importorskip('peft', reason='Actual PEFT CPU sequence executes in worker')
    tree = ast.parse((ROOT/'core/generation/handler/lora/lifecycle.py').read_text())
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'unload_lora')
    namespace = {'logger':Mock()}
    exec(compile(ast.Module(body=[function],type_ignores=[]),str(ROOT/'core/generation/handler/lora/lifecycle.py'),'exec'),namespace)
    return torch, peft, namespace['unload_lora']


def production_gate():
    tree = ast.parse((ROOT/'api/gpu.py').read_text())
    functions = [node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in {'_success','apply_job_lora'}]
    namespace = {'deepcopy':__import__('copy').deepcopy}
    exec(compile(ast.Module(body=functions,type_ignores=[]),str(ROOT/'api/gpu.py'),'exec'),namespace)
    return namespace['apply_job_lora']


def host_fixture(tmp_path):
    torch,peft,unload=production_unload()
    class Decoder(torch.nn.Module):
        def __init__(self):
            super().__init__();self.proj=torch.nn.Linear(4,4,bias=False)
        def forward(self,value):return self.proj(value)
    torch.manual_seed(13)
    decoder=Decoder()
    original={key:value.detach().clone() for key,value in decoder.state_dict().items()}
    for name,update in [('A',.1),('B',.2)]:
        training=Decoder();training.load_state_dict(original)
        adapter=peft.get_peft_model(training,peft.LoraConfig(r=2,lora_alpha=2,target_modules=['proj']))
        for key,value in adapter.named_parameters():
            if 'lora_' in key:value.data.fill_(update)
        adapter.save_pretrained(tmp_path/name)
    host=SimpleNamespace(model=SimpleNamespace(decoder=decoder),device='cpu',dtype=torch.float32,lora_loaded=False,use_lora=False,_base_decoder=original,_rawchunks_manual_lora={})
    host._lora_service=SimpleNamespace()
    host._ensure_lora_registry=lambda:None
    host.unload_lora=lambda:unload(host)
    def load(path):
        host.model.decoder=peft.PeftModel.from_pretrained(host.model.decoder,path,is_trainable=False)
        host.lora_loaded=True;host.use_lora=True
        return '✅ loaded'
    host.load_lora=load
    host.set_lora_scale=lambda value:'✅ scale'
    host.set_use_lora=lambda value:'✅ enabled'
    return torch,peft,host,original


def test_sequence_adapter_a_adapter_b_then_no_reference_restores_exact_base(tmp_path):
    torch,peft,host,original=host_fixture(tmp_path)
    gate=production_gate();samples=torch.arange(8,dtype=torch.float32).reshape(2,4)
    expected=host.model.decoder(samples).detach().clone();outputs=[]
    for name in ['A','B']:
        cleanup=gate(host,SimpleNamespace(lora_path=str(tmp_path/name),lora_alpha=1))
        outputs.append(host.model.decoder(samples).detach().clone())
        cleanup()
        assert not isinstance(host.model.decoder,peft.PeftModel)
        assert not hasattr(host.model.decoder,'peft_config')
        assert not any(hasattr(module,'lora_A') or hasattr(module,'lora_B') for module in host.model.decoder.modules())
        assert set(host.model.decoder.state_dict())==set(original)
        assert all(torch.equal(host.model.decoder.state_dict()[key],value) for key,value in original.items())
        assert torch.equal(host.model.decoder(samples),expected)
        assert not host.lora_loaded and not host.use_lora
    gate(host,SimpleNamespace(lora_path=None))()
    assert torch.equal(host.model.decoder(samples),expected)
    assert not torch.equal(outputs[0],expected)
    assert not torch.equal(outputs[1],expected)
    assert not torch.equal(outputs[0],outputs[1])


def test_cleanup_base_key_mismatch_fails_closed(tmp_path):
    torch,peft,host,original=host_fixture(tmp_path)
    cleanup=production_gate()(host,SimpleNamespace(lora_path=str(tmp_path/'A'),lora_alpha=1))
    host._base_decoder={'wrong.weight':torch.zeros(4,4)}
    with pytest.raises(RuntimeError):cleanup()
    assert host.model is None
