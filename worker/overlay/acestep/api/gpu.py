"""Single GPU gate and per-job LoRA isolation with manual-state restoration."""
from __future__ import annotations
import asyncio
from functools import partial
from threading import RLock
from copy import deepcopy

GPU_LOCK = RLock()
def gpu_call(call,*args,**kwargs):
    with GPU_LOCK: return call(*args,**kwargs)
async def run_gpu(state,call,*args,**kwargs):
    future = asyncio.get_running_loop().run_in_executor(state.executor,partial(gpu_call,call,*args,**kwargs))
    try: return await asyncio.shield(future)
    except asyncio.CancelledError:
        await asyncio.shield(future)
        raise

def _success(result,warning=False):
    if not isinstance(result,str) or not result.startswith(('✅','⚠') if warning else ('✅',)):
        raise RuntimeError(str(result))

def apply_job_lora(handler,req):
    path = getattr(req,'lora_path',None)
    if not path: return lambda:None
    manual = deepcopy(getattr(handler,'_rawchunks_manual_lora',{})) if getattr(handler,'lora_loaded',False) else {}
    if getattr(handler,'lora_loaded',False) and not manual:
        raise RuntimeError('Cannot isolate job LoRA: existing adapter source is unknown')
    try:
        _success(handler.unload_lora(),True)
    except BaseException:
        handler.model=None
        raise
    def restore():
        try:
            _success(handler.unload_lora(),True)
            for adapter in manual.get('adapters',[]):
                name = adapter.get('name')
                _success(handler.add_lora(adapter['path'],adapter_name=name) if name else handler.load_lora(adapter['path']))
                _success(handler.set_lora_scale(name,adapter['scale']) if name else handler.set_lora_scale(adapter['scale']),True)
            if manual.get('adapters'):
                active = manual.get('active_adapter')
                if active:
                    _success(handler.set_active_lora_adapter(active))
                _success(handler.set_use_lora(manual.get('enabled',True)))
            handler._rawchunks_manual_lora=manual
        except BaseException:
            handler.model = None
            raise
    try:
        _success(handler.load_lora(path))
        _success(handler.set_lora_scale(getattr(req,'lora_alpha',1.0)))
        _success(handler.set_use_lora(True))
    except BaseException:
        restore(); raise
    return restore
