"""Single GPU gate and per-job LoRA isolation with manual-state restoration."""
from __future__ import annotations
import asyncio
from functools import partial
from threading import Condition, RLock, get_ident
from copy import deepcopy

GPU_LOCK = RLock()
_RW_COND = Condition(RLock())
_shared_active = 0
_exclusive_owner = None
_exclusive_depth = 0
_exclusive_waiting = 0
_LLM_LOCK = RLock()
_TOKENIZER_LOCK = RLock()
_DIT_LOCK = RLock()
_VAE_LOCK = RLock()


def is_shared_gpu_busy() -> bool:
    return _shared_active > 1


def _wrap_method_with_lock(obj, name: str, lock: RLock) -> None:
    fn = getattr(obj, name, None)
    if not callable(fn) or getattr(fn, "_rawchunks_locked", False):
        return

    def wrapped(*args, **kwargs):
        with lock:
            return fn(*args, **kwargs)

    wrapped._rawchunks_locked = True
    setattr(obj, name, wrapped)


def ensure_threadsafe_handlers(app_state, selected_handler) -> None:
    llm_handler = getattr(app_state, "llm_handler", None)
    if llm_handler is not None and not getattr(llm_handler, "_rawchunks_threadsafe", False):
        for method_name in ("generate_with_stop_condition", "create_sample_from_query", "format_sample_from_input"):
            _wrap_method_with_lock(llm_handler, method_name, _LLM_LOCK)
        llm_handler._rawchunks_threadsafe = True
    if selected_handler is not None and not getattr(selected_handler, "_rawchunks_threadsafe", False):
        _wrap_method_with_lock(selected_handler, "_prepare_text_conditioning_inputs", _TOKENIZER_LOCK)
        _wrap_method_with_lock(selected_handler, "_prepare_target_latents_and_wavs", _VAE_LOCK)
        _wrap_method_with_lock(selected_handler, "_execute_service_generate_diffusion", _DIT_LOCK)
        _wrap_method_with_lock(selected_handler, "_decode_generate_music_pred_latents", _VAE_LOCK)
        empty_fn = getattr(selected_handler, "_empty_cache", None)
        if callable(empty_fn) and not getattr(empty_fn, "_rawchunks_locked", False):
            def safe_empty_cache(*args, **kwargs):
                if is_shared_gpu_busy():
                    return None
                return empty_fn(*args, **kwargs)
            safe_empty_cache._rawchunks_locked = True
            selected_handler._empty_cache = safe_empty_cache
        selected_handler._rawchunks_threadsafe = True


def gpu_call(call, *args, **kwargs):
    global _exclusive_owner, _exclusive_depth, _exclusive_waiting
    me = get_ident()
    with _RW_COND:
        if _exclusive_owner == me:
            _exclusive_depth += 1
        else:
            _exclusive_waiting += 1
            try:
                while _shared_active > 0 or _exclusive_owner is not None:
                    _RW_COND.wait()
                _exclusive_owner = me
                _exclusive_depth = 1
            finally:
                _exclusive_waiting -= 1
    try:
        with GPU_LOCK:
            return call(*args, **kwargs)
    finally:
        with _RW_COND:
            _exclusive_depth -= 1
            if _exclusive_depth == 0:
                _exclusive_owner = None
                _RW_COND.notify_all()


def gpu_shared_call(call, *args, **kwargs):
    global _shared_active
    me = get_ident()
    with _RW_COND:
        while (_exclusive_owner is not None and _exclusive_owner != me) or _exclusive_waiting > 0:
            _RW_COND.wait()
        _shared_active += 1
    try:
        return call(*args, **kwargs)
    finally:
        with _RW_COND:
            _shared_active -= 1
            if _shared_active == 0:
                _RW_COND.notify_all()


async def run_gpu(state, call, *args, shared: bool = False, **kwargs):
    runner = gpu_shared_call if shared else gpu_call
    future = asyncio.get_running_loop().run_in_executor(state.executor, partial(runner, call, *args, **kwargs))
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        await asyncio.shield(future)
        raise

def _success(result,warning=False):
    if not isinstance(result,str) or not result.startswith(('✅','⚠') if warning else ('✅',)):
        raise RuntimeError(str(result))

def apply_job_lora(handler,req):
    path = getattr(req,'lora_path',None)
    hot_cache = getattr(handler,'_lora_hot_cache_enabled',False) is True
    if not path:
        if hot_cache and getattr(handler,'_hot_cached_lora_path',None) and not getattr(handler,'_rawchunks_manual_lora',None):
            _success(handler.set_use_lora(False),True)
        return lambda:None
    manual = deepcopy(getattr(handler,'_rawchunks_manual_lora',{})) if getattr(handler,'lora_loaded',False) else {}
    if hot_cache and not manual:
        cached_path = getattr(handler,'_hot_cached_lora_path',None)
        if getattr(handler,'lora_loaded',False) and not cached_path:
            raise RuntimeError('Cannot isolate job LoRA: existing adapter source is unknown')
        def restore_hot():
            try:
                _success(handler.set_use_lora(False),True)
            except BaseException:
                handler._hot_cached_lora_path = None
                handler.model = None
                raise
        try:
            if cached_path != path or not getattr(handler,'lora_loaded',False):
                if getattr(handler,'lora_loaded',False):
                    _success(handler.unload_lora(),True)
                _success(handler.load_lora(path))
                handler._hot_cached_lora_path = path
            _success(handler.set_lora_scale(getattr(req,'lora_alpha',1.0)))
            _success(handler.set_use_lora(True))
        except BaseException:
            handler._hot_cached_lora_path = None
            try:
                _success(handler.unload_lora(),True)
            except BaseException:
                handler.model = None
            raise
        return restore_hot
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
