"""In-memory job store and JSON persistence helpers for API jobs."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from dataclasses import dataclass
from threading import Lock
import math
import redis
from typing import Any, Dict, Literal, Optional
from uuid import uuid4

JobStatus = Literal["queued", "running", "succeeded", "failed"]


@dataclass
class _JobRecord:
    """Internal mutable record stored in the in-memory job store."""
    job_id: str
    status: JobStatus
    created_at: float
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    progress_text: str = ""
    status_text: str = ""
    env: str = "development"
    progress: float = 0.0
    stage: str = "queued"
    updated_at: Optional[float] = None
    done_event: Optional[asyncio.Event] = None
    progress_queue: Optional[asyncio.Queue] = None


def _atomic_write_json(path: str, payload: Dict[str, Any]) -> None:
    """Write a JSON document atomically to reduce corruption risk."""
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".json", dir=directory or None)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file_obj:
            json.dump(payload, file_obj, ensure_ascii=False, indent=2)
            file_obj.flush()
            os.fsync(file_obj.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise


def _append_jsonl(path: str, record: Dict[str, Any]) -> None:
    """Append a single JSON record as one line in JSONL format."""
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "a", encoding="utf-8") as file_obj:
        file_obj.write(json.dumps(record, ensure_ascii=False) + "\n")


_UPDATE = """
local expected = {'hash','string'}
for i,t in ipairs(expected) do
 local actual = redis.call('TYPE',KEYS[i]).ok
 if actual ~= 'none' and actual ~= t then return redis.error_reply('WRONGTYPE store key') end
end
local raw = redis.call('HGET', KEYS[1], ARGV[1]); if not raw then return '' end
local rec = cjson.decode(raw)
if rec.claim then
 if redis.call('GET',KEYS[2]) ~= ARGV[3] or rec.claim ~= ARGV[4] then return 'LEASE_LOST' end
end
if rec.status == 'succeeded' or rec.status == 'failed' then return raw end
local changes = cjson.decode(ARGV[2]); for k,v in pairs(changes) do rec[k] = v end
if ARGV[5] ~= '' then rec.result_json = ARGV[5] end
redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(rec))
if changes.status or changes.progress then
 redis.call('PUBLISH',ARGV[6],cjson.encode({status=rec.status,progress=rec.progress,error=rec.error}))
end
return cjson.encode(rec)
"""
_CLEANUP = """
for i=1,#KEYS do
 local actual = redis.call('TYPE',KEYS[i]).ok
 if actual ~= 'none' and actual ~= 'hash' then return redis.error_reply('WRONGTYPE store key') end
end
local all = redis.call('HGETALL',KEYS[1]); local count = 0
for i=1,#all,2 do
 local rec = cjson.decode(all[i+1]); local id = all[i]
 if (rec.status == 'succeeded' or rec.status == 'failed') and not redis.call('HGET',KEYS[2],id) and
 not redis.call('HGET',KEYS[4],id) and tonumber(rec.finished_at or rec.created_at) < tonumber(ARGV[1]) then
  redis.call('HDEL',KEYS[1],id); redis.call('HDEL',KEYS[3],id); redis.call('HDEL',KEYS[5],id); count = count + 1
 end
end
return count
"""
class _JobStore:
    """Durable facade; mutable records retain local observers but refresh on get."""
    def __init__(self,max_age_seconds=86400,*,client=None,namespace='rawchunks:worker'):
        uri = os.getenv('VALKEY_URL') or os.getenv('VALKEY_REQUESTS_SERVICE_URI')
        if client is None and not uri: raise RuntimeError('VALKEY_URL or VALKEY_REQUESTS_SERVICE_URI is required')
        self.client = client if client is not None else redis.Redis.from_url(uri,decode_responses=True,socket_connect_timeout=5,socket_timeout=5)
        self.client.ping(); self.namespace = namespace; self._max_age = max_age_seconds
        self._lock = Lock(); self._records = {}; self.claims = {}
    def key(self,name): return f'{self.namespace}:{name}'
    def new_record(self,identifier,env='development'):
        now = time.time(); return _JobRecord(identifier,'queued',now,env=env,updated_at=now)
    def encode(self,record):
        return json.dumps({k:v for k,v in vars(record).items() if k not in ('done_event','progress_queue')},allow_nan=False)
    def decode(self,raw):
        data = json.loads(raw); identifier = data['job_id']
        if data.get('result_json'): data['result'] = json.loads(data['result_json'])
        with self._lock:
            rec = self._records.get(identifier)
            if rec is None: rec = self.new_record(identifier); self._records[identifier] = rec
            for k,v in data.items(): setattr(rec,k,v)
        return rec
    def create(self): return self.create_with_id(str(uuid4()))
    def create_with_id(self,identifier,env='development'):
        self.client.hsetnx(self.key('jobs'),identifier,self.encode(self.new_record(identifier,env)))
        return self.get(identifier)
    def get(self,identifier):
        raw = self.client.hget(self.key('jobs'),identifier); return self.decode(raw) if raw else None
    def _update(self,identifier,changes,missing_ok=False):
        changes['updated_at'] = time.time(); owner,token = self.claims.get(identifier,('',''))
        raw = self.client.eval(_UPDATE,2,self.key('jobs'),self.key('executor'),identifier,json.dumps(changes,allow_nan=False),owner,token,json.dumps(changes['result'],allow_nan=False) if changes.get('result') is not None else '',self.key('events:'+identifier))
        if raw == 'LEASE_LOST':
            from acestep.api.jobs.durable import LeaseLost
            raise LeaseLost('Stale worker cannot update job')
        if not raw:
            if not missing_ok: raise KeyError(identifier)
            return
        self.decode(raw)
    def mark_running(self,identifier):
        rec = self.get(identifier)
        if rec is None: raise KeyError(identifier)
        self._update(identifier,dict(status='running',started_at=time.time(),progress=max(rec.progress,.01),stage='running'))
    def mark_succeeded(self,identifier,result):
        self._update(identifier,dict(status='succeeded',finished_at=time.time(),result=result,error=None,progress=1.0,stage='succeeded'))
    def mark_failed(self,identifier,error):
        self._update(identifier,dict(status='failed',finished_at=time.time(),result=None,error=error,stage='failed'))
    def update_progress(self,identifier,progress,stage=None):
        if self.get(identifier) is None: return
        value = float(progress)
        if not math.isfinite(value): raise ValueError('progress must be finite')
        changes = {'progress':max(0.0,min(1.0,value))}
        if stage: changes['stage'] = stage
        self._update(identifier,changes,True)
    def update_status_text(self,identifier,text): self._update(identifier,{'status_text':text},True)
    def update_progress_text(self,identifier,text): self._update(identifier,{'progress_text':text},True)
    def temp_files(self,identifier):
        raw = self.client.hget(self.key('files'),identifier); return json.loads(raw) if raw else []
    def clear_temp_files(self,identifier): self.client.hdel(self.key('files'),identifier)
    def cleanup_old_jobs(self,max_age_seconds=None):
        age = self._max_age if max_age_seconds is None else max_age_seconds
        removed = self.client.eval(_CLEANUP,5,self.key('jobs'),self.key('active'),self.key('requests'),self.key('files'),self.key('digests'),time.time()-age)
        with self._lock:
            for identifier in list(self._records):
                if not self.client.hexists(self.key('jobs'),identifier): self._records.pop(identifier,None)
        return removed
    def get_stats(self):
        stats = dict(total=0,queued=0,running=0,succeeded=0,failed=0)
        for raw in self.client.hvals(self.key('jobs')):
            status = json.loads(raw)['status']; stats['total'] += 1
            if status in stats: stats[status] += 1
        return stats
