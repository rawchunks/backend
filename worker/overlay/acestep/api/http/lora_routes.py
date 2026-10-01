"""Preserved LoRA controls serialized with generation and separation."""
from __future__ import annotations
from typing import Optional
from fastapi import Depends,HTTPException
from pydantic import BaseModel,Field
from acestep.api.gpu import run_gpu
from acestep.api.adapters import prepare_job_adapter

class LoadLoRARequest(BaseModel):
    lora_path:Optional[str]=None
    lora_manifest_url:Optional[str]=None
    lora_manifest_digest:Optional[str]=None
    model:Optional[str]=None
    adapter_name:Optional[str]=None
class SetLoRAScaleRequest(BaseModel):
    scale:float=Field(...,ge=0.0,le=1.0)
    adapter_name:Optional[str]=None
    model:Optional[str]=None
class ToggleLoRARequest(BaseModel):
    use_lora:bool
    model:Optional[str]=None

def _is_success_message(result,allow_warning=False):
    return isinstance(result,str) and result.startswith(('✅','⚠') if allow_warning else ('✅',))
def _require_initialized_handler(app,model=None):
    handler=app.state.handler
    if model:
        from pathlib import Path
        handler=next((getattr(app.state,'handler'+suffix,None) for suffix in ('','2','3') if Path(getattr(app.state,'_config_path'+suffix,'')).name == model),None)
        if handler is None:raise HTTPException(400,'Requested resident model is unavailable')
    if handler is None or handler.model is None:raise HTTPException(500,'Model not initialized')
    return handler

def register_lora_routes(app,verify_api_key,wrap_response):
    async def control(fn):
        try:return await run_gpu(app.state,fn)
        except HTTPException:raise
        except Exception as exc:raise HTTPException(500,str(exc)) from exc
    @app.post('/v1/lora/load')
    async def load_lora_endpoint(request:LoadLoRARequest,_:None=Depends(verify_api_key)):
        if bool(request.lora_path) == bool(request.lora_manifest_url):raise HTTPException(400,'Choose one local adapter or validated manifest')
        try:await prepare_job_adapter(app.state,request)
        except Exception as exc:raise HTTPException(400,str(exc)) from exc
        handler=_require_initialized_handler(app,request.model)
        name=request.adapter_name.strip() if request.adapter_name else None
        def load():
            was_loaded=bool(getattr(handler,'lora_loaded',False))
            result=handler.add_lora(request.lora_path,adapter_name=name) if name else handler.load_lora(request.lora_path)
            if not _is_success_message(result):raise HTTPException(400,result)
            status=handler.get_lora_status();actual_name=status.get('active_adapter') or name
            config=getattr(handler,'_rawchunks_manual_lora',{}) if was_loaded else {}
            config.setdefault('adapters',[]).append({'path':request.lora_path,'name':actual_name,'scale':1.0})
            config['enabled']=True;config['active_adapter']=actual_name;handler._rawchunks_manual_lora=config
            payload={'message':result,'lora_path':request.lora_path}
            if name:payload['adapter_name']=name
            return payload
        return wrap_response(await control(load))
    @app.post('/v1/lora/unload')
    async def unload_lora_endpoint(model:Optional[str]=None,_:None=Depends(verify_api_key)):
        handler=_require_initialized_handler(app,model)
        def unload():
            result=handler.unload_lora()
            if not _is_success_message(result,True):raise HTTPException(400,result)
            handler._rawchunks_manual_lora={};return {'message':result}
        return wrap_response(await control(unload))
    @app.post('/v1/lora/toggle')
    async def toggle_lora_endpoint(request:ToggleLoRARequest,_:None=Depends(verify_api_key)):
        handler=_require_initialized_handler(app,request.model)
        def toggle():
            result=handler.set_use_lora(request.use_lora)
            if not _is_success_message(result):raise HTTPException(400,result)
            config=getattr(handler,'_rawchunks_manual_lora',{});config['enabled']=request.use_lora;handler._rawchunks_manual_lora=config
            return {'message':result,'use_lora':request.use_lora}
        return wrap_response(await control(toggle))
    @app.post('/v1/lora/scale')
    async def set_lora_scale_endpoint(request:SetLoRAScaleRequest,_:None=Depends(verify_api_key)):
        handler=_require_initialized_handler(app,request.model);name=request.adapter_name.strip() if request.adapter_name else None
        def scale():
            result=handler.set_lora_scale(name,request.scale) if name else handler.set_lora_scale(request.scale)
            if not _is_success_message(result,True):raise HTTPException(400,result)
            config=getattr(handler,'_rawchunks_manual_lora',{});status=handler.get_lora_status()
            active=status.get('active_adapter') or name or config.get('active_adapter')
            for adapter in config.get('adapters',[]):
                if adapter['name']==active:adapter['scale']=request.scale
            config['active_adapter']=active;handler._rawchunks_manual_lora=config
            payload={'message':result,'scale':request.scale}
            if name:payload['adapter_name']=name
            return payload
        return wrap_response(await control(scale))
    @app.get('/v1/lora/status')
    async def get_lora_status_endpoint(model:Optional[str]=None,_:None=Depends(verify_api_key)):
        handler=_require_initialized_handler(app,model)
        def status_payload():
            status=handler.get_lora_status()
            return {'lora_loaded':bool(status.get('loaded',getattr(handler,'lora_loaded',False))),
                'use_lora':bool(status.get('active',getattr(handler,'use_lora',False))),
                'lora_scale':float(status.get('scale',getattr(handler,'lora_scale',1.0))),
                'adapter_type':getattr(handler,'_adapter_type',None),'scales':status.get('scales',{}),
                'active_adapter':status.get('active_adapter'),'adapters':status.get('adapters',[]),
                'synthetic_default_mode':bool(status.get('synthetic_default_mode',False))}
        return wrap_response(await control(status_payload))
