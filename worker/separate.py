"""Durable queued Demucs separation through the shared GPU executor."""
from __future__ import annotations
import asyncio
import ipaddress
import http.client
import os
import socket
from socket import getaddrinfo as resolve_host
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Literal, Optional
from functools import partial

from fastapi import Depends, Header, HTTPException, Request
from pydantic import BaseModel
from threading import RLock
import torch
import demucs.api
from acestep.api.gpu import run_gpu
from acestep.api.jobs.durable import QueueFull

MAX_AUDIO_BYTES = 200 * 1024 * 1024  # Existing API audio upload boundary.
DOWNLOAD_TIMEOUT_SECONDS = 90  # Network I/O bound, not a GPU job deadline.
_DEMUCS_LOCK = RLock()
_demucs_separator = None

def get_separator():
    global _demucs_separator
    if _demucs_separator is None:
        _demucs_separator = demucs.api.Separator(model='htdemucs',device='cuda' if torch.cuda.is_available() else 'cpu')
        if hasattr(_demucs_separator, 'update_parameter'):
            _demucs_separator.update_parameter(shifts=0, overlap=0.1)
    return _demucs_separator

class IsolateRequest(BaseModel):
    src_audio_path: str
    stem_type: Optional[Literal['all','vocals','drums','bass','other','instrumental']] = 'all'
    wait: bool = True

def _public_url(src):
    parsed = urllib.parse.urlsplit(src)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(400,'Invalid source audio URL')
    try:
        answers = resolve_host(parsed.hostname,parsed.port or (443 if parsed.scheme=='https' else 80),type=socket.SOCK_STREAM)
    except OSError as exc:
        raise RuntimeError('Source audio host could not be resolved') from exc
    if not answers or any(not ipaddress.ip_address(item[4][0]).is_global for item in answers):
        raise HTTPException(403,'Source audio URL must resolve to a public address')
    ordered = sorted(answers, key=lambda item: 0 if item[0] == socket.AF_INET else 1)
    addresses = list(dict.fromkeys(item[4][0] for item in ordered))
    return parsed, addresses

def _connect_pinned(addresses, port, timeout=None, source_address=None):
    candidates = [addresses] if isinstance(addresses, str) else list(addresses)
    last_exc = None
    for addr in candidates:
        try:
            return socket.create_connection((addr, port), timeout, source_address)
        except OSError as exc:
            last_exc = exc
    if last_exc is not None:
        raise last_exc
    raise OSError('No resolved address available for connection')

class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self,request):
        parsed,addresses=_public_url(request.full_url)
        def connection(host,**kwargs):
            conn=http.client.HTTPConnection(host,**kwargs)
            conn._create_connection=lambda target,timeout=None,source_address=None: _connect_pinned(addresses,parsed.port or 80,timeout,source_address)
            return conn
        return self.do_open(connection,request)

class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self,request):
        parsed,addresses=_public_url(request.full_url)
        def connection(host,**kwargs):
            conn=http.client.HTTPSConnection(host,**kwargs)
            conn._create_connection=lambda target,timeout=None,source_address=None: _connect_pinned(addresses,parsed.port or 443,timeout,source_address)
            return conn
        kwargs={'context':self._context}
        if hasattr(self,'_check_hostname'):kwargs['check_hostname']=self._check_hostname
        return self.do_open(connection,request,**kwargs)

class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _public_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def _download(src,target):
    _public_url(src)
    req_url = src
    req_headers = {'User-Agent':'rawchunks-audio-worker'}
    try:
        from acestep.core.generation.handler.io_audio import r2_authenticated_request
        req_url, req_headers = r2_authenticated_request(src)
        if req_url != src:
            _public_url(req_url)
    except Exception:
        req_url = src
        req_headers = {'User-Agent':'rawchunks-audio-worker'}
    deadline = time.monotonic()+DOWNLOAD_TIMEOUT_SECONDS
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),_SafeRedirect(),_PinnedHTTPHandler(),_PinnedHTTPSHandler())
    def _open_req(u, h):
        return opener.open(urllib.request.Request(u, headers=h), timeout=DOWNLOAD_TIMEOUT_SECONDS)
    try:
        try:
            resp_ctx = _open_req(req_url, req_headers)
        except urllib.error.HTTPError:
            if req_url == src:
                raise
            resp_ctx = _open_req(src, {'User-Agent':'rawchunks-audio-worker'})
        with resp_ctx as response, open(target,'xb') as out:
            length = response.headers.get('Content-Length')
            if length is not None and int(length)>MAX_AUDIO_BYTES:
                raise HTTPException(413,'Source audio exceeds 50 MiB')
            mime = response.headers.get('Content-Type','').split(';')[0].strip().lower()
            if mime and not (mime.startswith('audio/') or mime=='application/octet-stream'):
                raise HTTPException(400,'Source response is not audio')
            size = 0
            while True:
                remaining = deadline-time.monotonic()
                if remaining<=0: raise TimeoutError('Source audio download deadline exceeded')
                # Bound each body read as well as the complete transfer.
                raw_socket = getattr(getattr(getattr(response,'fp',None),'raw',None),'_sock',None)
                if raw_socket is not None: raw_socket.settimeout(remaining)
                chunk = response.read(min(1024*1024,MAX_AUDIO_BYTES-size+1))
                if not chunk: break
                size += len(chunk)
                if size>MAX_AUDIO_BYTES: raise HTTPException(413,'Source audio exceeds 50 MiB')
                out.write(chunk)
    except BaseException:
        try: target.unlink()
        except FileNotFoundError: pass
        raise

def _local_source(src,temp_dir,store=None):
    parsed = urllib.parse.urlsplit(src)
    if parsed.path in ('/v1/audio','/audio') and parsed.query:
        params = urllib.parse.parse_qs(parsed.query,keep_blank_values=True)
        if set(params) - {'path','download'} or len(params.get('path',[])) != 1:
            raise HTTPException(400,'Invalid audio path query')
        src = params['path'][0]
    elif parsed.scheme:
        raise HTTPException(400,'Unsupported source audio scheme')
    candidate = Path(src).resolve(strict=False)
    try: candidate.relative_to(temp_dir.resolve())
    except ValueError: raise HTTPException(403,'Source audio is outside the audio directory')
    if not candidate.is_file() and store is not None:
        try:
            from acestep.api.training import fetch_cached_audio_bytes
            raw = fetch_cached_audio_bytes(store, candidate)
            if raw:
                candidate.parent.mkdir(parents=True,exist_ok=True)
                candidate.write_bytes(raw)
        except Exception:
            pass
    if not candidate.is_file(): raise HTTPException(404,'Source audio file not found')
    if candidate.stat().st_size>MAX_AUDIO_BYTES: raise HTTPException(413,'Source audio exceeds 50 MiB')
    return candidate

def _execute(temp_dir,source,job_id,stem_type):
    import contextlib
    from concurrent.futures import ThreadPoolExecutor
    with _DEMUCS_LOCK:
        separator = get_separator()
        use_amp = torch.cuda.is_available() and hasattr(torch, 'amp') and hasattr(torch.amp, 'autocast')
        amp_dtype = torch.bfloat16 if (use_amp and hasattr(torch.cuda, 'is_bf16_supported') and torch.cuda.is_bf16_supported()) else torch.float16
        amp_ctx = torch.amp.autocast('cuda', dtype=amp_dtype) if use_amp else contextlib.nullcontext()
        no_grad_ctx = torch.no_grad() if hasattr(torch, 'no_grad') else contextlib.nullcontext()
        with no_grad_ctx, amp_ctx:
            separated = None
            if use_amp and hasattr(separator, 'separate_tensor'):
                try:
                    import soundfile as sf
                    import torchaudio
                    data, sr = sf.read(str(source), dtype='float32', always_2d=True)
                    wav = torch.from_numpy(data.T).to('cuda', non_blocking=True)
                    if sr != separator.samplerate:
                        wav = torchaudio.functional.resample(wav, sr, separator.samplerate)
                    _, separated = separator.separate_tensor(wav, separator.samplerate)
                except Exception:
                    separated = None
            if separated is None:
                _, separated = separator.separate_audio_file(str(source))
    order = ['vocals','drums','bass','other'] if stem_type in ('all',None) else [stem_type]
    if stem_type == 'instrumental' and all(name in separated for name in ('drums','bass','other')):
        separated['instrumental'] = separated['drums']+separated['bass']+separated['other']
    stems = {}; paths = []; tasks = []
    def _save_stem(item):
        tensor, out_path = item
        if hasattr(tensor, 'detach'):
            try:
                import soundfile as sf
                arr = tensor.numpy() if getattr(tensor, 'dtype', None) == torch.int16 else tensor.detach().cpu().clamp(-1.0, 1.0).numpy()
                if arr.ndim == 2:
                    arr = arr.T
                sf.write(out_path, arr, separator.samplerate, subtype='PCM_16')
                return
            except Exception:
                pass
        demucs.api.save_audio(tensor, out_path, samplerate=separator.samplerate)
    try:
        for name in order:
            if name not in separated:
                if stem_type not in ('all',None): raise RuntimeError(f'Separator did not produce {name}')
                continue
            tensor = separated[name]
            if hasattr(tensor, 'detach') and getattr(tensor, 'is_cuda', False):
                try:
                    tensor = (tensor.detach().clamp(-1.0, 1.0) * 32767.0).to(torch.int16).cpu()
                except Exception:
                    pass
            path = temp_dir/f'{job_id}_{name}.wav'
            paths.append(str(path)); stems[name] = '/v1/audio?'+urllib.parse.urlencode({'path':str(path)})
            tasks.append((tensor, str(path)))
        if len(tasks) > 1:
            with ThreadPoolExecutor(max_workers=min(5, len(tasks))) as pool:
                list(pool.map(_save_stem, tasks))
        elif tasks:
            _save_stem(tasks[0])
        return {'task_id':job_id,'status':'ready','stems':stems,'audio_paths':paths,'metas':{'caption':','.join(stems)}}
    except BaseException:
        for path in paths:
            try: Path(path).unlink()
            except FileNotFoundError: pass
        raise

async def execute_separation_job(state,store,job_id,req):
    store.mark_running(job_id)
    temp_dir = Path(state.temp_audio_dir); temp_dir.mkdir(parents=True,exist_ok=True)
    src = req['src_audio_path']; remote = urllib.parse.urlsplit(src).scheme in ('http','https')
    # Raw task IDs never form filesystem names; caller idempotency keys are
    # accepted by the queue only when safe for public task identifiers.
    shm_dir = Path('/dev/shm') if remote and os.path.isdir('/dev/shm') and os.access('/dev/shm', os.W_OK) else temp_dir
    input_path = shm_dir/f'{job_id}_input.audio'
    use_url_cache = remote and 'PYTEST_CURRENT_TEST' not in os.environ and os.environ.get('ACESTEP_DISABLE_URL_CACHE') != '1'
    cache_path = None
    if use_url_cache:
        import hashlib
        cache_dir = shm_dir / 'acestep' / 'url_cache'
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
            ext = Path(urllib.parse.urlsplit(src).path).suffix.lower()
            if ext not in ('.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac'):
                ext = '.wav'
            cache_path = cache_dir / f'{hashlib.sha256(src.encode("utf-8")).hexdigest()}{ext}'
        except Exception:
            cache_path = None
    try:
        try: input_path.unlink()
        except FileNotFoundError: pass
        if remote and cache_path is not None and cache_path.is_file() and cache_path.stat().st_size > 0:
            source = cache_path
        else:
            source = await asyncio.to_thread(_download,src,input_path) if remote else _local_source(src,temp_dir,store)
            if remote:
                source = input_path
                if cache_path is not None and input_path.is_file():
                    try:
                        import shutil
                        existing = sorted(cache_path.parent.glob('*.*'), key=lambda p: p.stat().st_mtime)
                        for stale in existing[:-15]:
                            stale.unlink(missing_ok=True)
                        tmp_cache = cache_path.with_suffix(f'.{os.getpid()}.tmp')
                        shutil.copyfile(input_path, tmp_cache)
                        os.replace(tmp_cache, cache_path)
                    except Exception:
                        pass
        result = await run_gpu(state,_execute,temp_dir,source,job_id,req.get('stem_type','all'),shared=True)
        if os.environ.get('ACESTEP_CACHE_STEMS_IN_REDIS', '').lower() in ('1', 'true', 'yes'):
            from acestep.api.training import cache_audio_file
            for audio_path in (result.get('audio_paths') or []):
                cache_audio_file(store, audio_path)
        store.mark_succeeded(job_id,result)
    except BaseException as exc:
        store.mark_failed(job_id,str(exc))
        raise
    finally:
        if remote:
            try: input_path.unlink()
            except FileNotFoundError: pass

def register_separate_route(app,verify_api_key,wrap_response,store):
    @app.post('/separate')
    @app.post('/v1/separate')
    async def separate_endpoint(req:SeparateRequest,request:Request,
            idempotency_key:Optional[str]=Header(None),_:None=Depends(verify_api_key)):
        if not req.src_audio_path: raise HTTPException(400,'src_audio_path is required')
        src=req.src_audio_path
        if urllib.parse.urlsplit(src).scheme not in ('http','https'):
            _local_source(src,Path(request.app.state.temp_audio_dir),store)
        else:
            try: await asyncio.to_thread(_public_url,src)
            except HTTPException: raise
            except Exception as exc: raise HTTPException(500,f'Separation failed: {exc}') from exc
        try:
            record,_=app.state.job_queue.admit(req,kind='separate',job_id=idempotency_key)
        except QueueFull as exc: raise HTTPException(429,'Server busy: queue is full') from exc
        except ValueError as exc: raise HTTPException(409,str(exc)) from exc
        if not req.wait:
            return wrap_response({'task_id': record.job_id, 'status': record.status})
        record = await app.state.job_queue.wait(record.job_id)
        if record.status=='failed': raise HTTPException(500,f'Separation failed: {record.error}')
        return wrap_response(record.result)
