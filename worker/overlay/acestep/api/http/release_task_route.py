"""Legacy task submission with atomic durable admission."""
from __future__ import annotations
import os
import asyncio
from typing import Optional
from fastapi import Header,HTTPException,Request
from acestep.api.http.release_task_request_parser import parse_release_task_request
from acestep.api.jobs.durable import QueueFull
from acestep.api.training import cache_audio_file

def register_release_task_route(app,verify_token_from_request,wrap_response,store,request_parser_cls,
        request_model_cls,validate_audio_path,save_upload_to_temp,upload_file_type,default_dit_instruction,
        lm_default_temperature,lm_default_cfg_scale,lm_default_top_p):
    @app.post('/release_task')
    async def create_music_generate_job(request:Request,authorization:Optional[str]=Header(None),
            idempotency_key:Optional[str]=Header(None)):
        req,temp_files=await parse_release_task_request(request=request,authorization=authorization,
            verify_token_from_request=verify_token_from_request,request_parser_cls=request_parser_cls,
            request_model_cls=request_model_cls,validate_audio_path=validate_audio_path,
            save_upload_to_temp=save_upload_to_temp,upload_file_type=upload_file_type,
            default_dit_instruction=default_dit_instruction,lm_default_temperature=lm_default_temperature,
            lm_default_cfg_scale=lm_default_cfg_scale,lm_default_top_p=lm_default_top_p)
        for p in temp_files:
            cache_audio_file(store, p)
        try:
            record,position=app.state.job_queue.admit(req,temp_files=temp_files,job_id=idempotency_key)
        except BaseException as exc:
            # A transport failure may follow a committed Lua admission. Keep
            # inputs unless rejection is known, so a recovered job can read them.
            if not isinstance(exc,(QueueFull,ValueError,asyncio.CancelledError)):
                raise
            for path in temp_files:
                try: os.remove(path)
                except OSError: pass
            if isinstance(exc,QueueFull): raise HTTPException(429,'Server busy: queue is full') from exc
            if isinstance(exc,ValueError): raise HTTPException(409,str(exc)) from exc
            raise
        return wrap_response({'task_id':record.job_id,'status':record.status,'queue_position':position})
