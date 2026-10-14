"""Atomic Valkey queue admission and fenced singleton GPU claims."""
from __future__ import annotations
import asyncio
import json
import os
import re
import hashlib
from uuid import uuid4

class QueueFull(Exception): pass
class LeaseLost(RuntimeError): pass

ADMIT = """
local expected = {'hash','hash','list','hash','hash'}
for i,t in ipairs(expected) do
 local actual = redis.call('TYPE',KEYS[i]).ok
 if actual ~= 'none' and actual ~= t then return redis.error_reply('WRONGTYPE queue key') end
end
local old = redis.call('HGET', KEYS[1], ARGV[1])
if old and redis.call('HEXISTS',KEYS[5],ARGV[1]) == 1 then
 local previous = redis.call('HGET',KEYS[5],ARGV[1])
 if previous ~= ARGV[6] then return {-2, ''} end
 return {0, old}
end
if tonumber(ARGV[4]) > 0 and redis.call('LLEN', KEYS[3]) >= tonumber(ARGV[4]) then return {-1, ''} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[4], ARGV[1], ARGV[5])
redis.call('HSET', KEYS[5], ARGV[1], ARGV[6])
redis.call('RPUSH', KEYS[3], ARGV[1])
return {redis.call('LLEN', KEYS[3]), ARGV[2]}
"""
CLAIM = """
local expected = {'hash','hash','list','hash','string'}
for i,t in ipairs(expected) do
 local actual = redis.call('TYPE',KEYS[i]).ok
 if actual ~= 'none' and actual ~= t then return redis.error_reply('WRONGTYPE queue key') end
end
if redis.call('GET', KEYS[5]) ~= ARGV[1] then return {'', ''} end
local id = redis.call('LINDEX', KEYS[3], 0)
while id do
  local raw = redis.call('HGET', KEYS[1], id)
  local payload = redis.call('HGET', KEYS[2], id)
  if raw and payload then
    local rec = cjson.decode(raw)
    if rec.status == 'queued' then
      redis.call('LPOP', KEYS[3])
      rec.claim = ARGV[2]
      redis.call('HSET', KEYS[1], id, cjson.encode(rec))
      redis.call('HSET', KEYS[4], id, ARGV[2])
      return {id, payload}
    end
  end
  redis.call('LPOP', KEYS[3])
  id = redis.call('LINDEX', KEYS[3], 0)
end
return {'', ''}
"""
RECOVER = """
local expected = {'hash','hash','list','hash','string'}
for i,t in ipairs(expected) do
 local actual = redis.call('TYPE',KEYS[i]).ok
 if actual ~= 'none' and actual ~= t then return redis.error_reply('WRONGTYPE queue key') end
end
if redis.call('GET', KEYS[5]) ~= ARGV[1] then return 0 end
local all = redis.call('HGETALL', KEYS[4]); local count = 0
local records = {}
for i=1,#all,2 do
 local raw = redis.call('HGET',KEYS[1],all[i])
 if raw then records[all[i]] = cjson.decode(raw) end
end
for i=1,#all,2 do
  local id = all[i]; local raw = redis.call('HGET', KEYS[1], id)
  if raw then
    local rec = records[id]
    if rec.status ~= 'succeeded' and rec.status ~= 'failed' then
      rec.status = 'queued'; rec.stage = 'queued'; rec.claim = nil; rec.started_at = cjson.null
      redis.call('HSET', KEYS[1], id, cjson.encode(rec))
      redis.call('LPUSH', KEYS[3], id); count = count + 1
    else
      redis.call('HDEL', KEYS[2], id)
    end
  end
  redis.call('HDEL', KEYS[4], id)
end
return count
"""
RENEW = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1
"""
RELEASE = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
"""
ACK = """
local expected = {'hash','hash','list','hash','string'}
for i,t in ipairs(expected) do
 local actual = redis.call('TYPE',KEYS[i]).ok
 if actual ~= 'none' and actual ~= t then return redis.error_reply('WRONGTYPE queue key') end
end
if redis.call('GET', KEYS[5]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[4], ARGV[2]) ~= ARGV[3] then return 0 end
local raw = redis.call('HGET', KEYS[1], ARGV[2])
if not raw then return 0 end
local rec = cjson.decode(raw)
if rec.status ~= 'succeeded' and rec.status ~= 'failed' then return 0 end
redis.call('HDEL', KEYS[4], ARGV[2]); redis.call('HDEL', KEYS[2], ARGV[2]); return 1
"""
ACQUIRE_MULTI = """
local pool_key = KEYS[1]
local lease_key = KEYS[2]
local owner = ARGV[1]
local lease_ms = tonumber(ARGV[2])
local max_executors = tonumber(ARGV[3])
local members = redis.call('SMEMBERS', pool_key)
local live = 0
for _, m in ipairs(members) do
  if m == owner or redis.call('EXISTS', lease_key .. ':' .. m) == 1 then
    if m ~= owner then live = live + 1 end
  else
    redis.call('SREM', pool_key, m)
  end
end
if live >= max_executors then return 0 end
redis.call('SADD', pool_key, owner)
redis.call('SET', lease_key .. ':' .. owner, owner, 'PX', lease_ms)
return 1
"""
CLAIM_MULTI = """
local expected = {'hash','hash','list','hash','string'}
for i,t in ipairs(expected) do
 local actual = redis.call('TYPE',KEYS[i]).ok
 if actual ~= 'none' and actual ~= t then return redis.error_reply('WRONGTYPE queue key') end
end
if redis.call('GET', KEYS[5]) ~= ARGV[1] then return {'', ''} end
local id = redis.call('LINDEX', KEYS[3], 0)
while id do
  local raw = redis.call('HGET', KEYS[1], id)
  local payload = redis.call('HGET', KEYS[2], id)
  if raw and payload then
    local rec = cjson.decode(raw)
    if rec.status == 'queued' then
      redis.call('LPOP', KEYS[3])
      rec.claim = ARGV[2]
      rec.owner = ARGV[1]
      redis.call('HSET', KEYS[1], id, cjson.encode(rec))
      redis.call('HSET', KEYS[4], id, ARGV[1] .. ':' .. ARGV[2])
      return {id, payload}
    end
  end
  redis.call('LPOP', KEYS[3])
  id = redis.call('LINDEX', KEYS[3], 0)
end
return {'', ''}
"""
RECOVER_MULTI = """
local lease_prefix = KEYS[5]
local owner = ARGV[1]
if redis.call('GET', lease_prefix .. ':' .. owner) ~= owner then return 0 end
local all = redis.call('HGETALL', KEYS[4]); local count = 0
for i=1,#all,2 do
  local id = all[i]
  local active_val = all[i+1] or ''
  local sep = string.find(active_val, ':', 1, true)
  local job_owner = sep and string.sub(active_val, 1, sep - 1) or ''
  if job_owner == '' or redis.call('EXISTS', lease_prefix .. ':' .. job_owner) == 0 then
    local raw = redis.call('HGET', KEYS[1], id)
    if raw then
      local rec = cjson.decode(raw)
      if rec.status ~= 'succeeded' and rec.status ~= 'failed' then
        rec.status = 'queued'; rec.stage = 'queued'; rec.claim = nil; rec.owner = nil; rec.started_at = cjson.null
        redis.call('HSET', KEYS[1], id, cjson.encode(rec))
        redis.call('LPUSH', KEYS[3], id); count = count + 1
      else
        redis.call('HDEL', KEYS[2], id)
      end
    end
    redis.call('HDEL', KEYS[4], id)
  end
end
return count
"""
ACK_MULTI = """
if redis.call('GET', KEYS[5]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[4], ARGV[2]) ~= (ARGV[1] .. ':' .. ARGV[3]) then return 0 end
local raw = redis.call('HGET', KEYS[1], ARGV[2])
if not raw then return 0 end
local rec = cjson.decode(raw)
if rec.status ~= 'succeeded' and rec.status ~= 'failed' then return 0 end
redis.call('HDEL', KEYS[4], ARGV[2]); redis.call('HDEL', KEYS[2], ARGV[2]); return 1
"""

class DurableQueue:
    def __init__(self, store, maxsize, *, max_executors=None):
        self.store, self.maxsize = store, maxsize
        self.owner, self.claims = uuid4().hex, {}
        resolved_max = int(max_executors if max_executors is not None else os.getenv('ACESTEP_MAX_EXECUTORS', '1'))
        self.max_executors = max(1, resolved_max)
        self.store._multi_executor = self.max_executors > 1
        # Lease controls ownership, not an inference time budget. Renewal
        # failure exits the process before another executor can reclaim work.
        self.lease_ms = 30000
    @property
    def keys(self):
        return [self.store.key(n) for n in ('jobs','requests','pending','active','executor')]
    @property
    def _owner_lease_key(self):
        return f'{self.keys[4]}:{self.owner}' if self.max_executors > 1 else self.keys[4]
    @property
    def _pool_key(self):
        return self.store.key('executors')
    def qsize(self): return self.store.client.llen(self.keys[2])
    def full(self): return self.maxsize > 0 and self.qsize() >= self.maxsize
    def _target_namespace(self, kind, payload):
        ns = self.store.namespace
        if ns.startswith('rawchunks:worker:') and kind == 'generate' and isinstance(payload, dict):
            model = str(payload.get('model') or '')
            for suffix in ('sft', 'base', 'turbo'):
                if model.endswith(f'-{suffix}'):
                    return f'rawchunks:worker:{suffix}'
        return ns
    def admit(self, req, *, kind='generate', temp_files=(), job_id=None):
        identifier = job_id or str(uuid4())
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',identifier):
            raise ValueError('Invalid idempotency task identifier')
        record = self.store.new_record(identifier)
        payload = req.model_dump(mode='json') if hasattr(req,'model_dump') else vars(req) if hasattr(req,'__dict__') else req
        target_ns = self._target_namespace(kind, payload)
        serialized = json.dumps({'kind':kind,'request':payload},allow_nan=False,sort_keys=True)
        digest = hashlib.sha256(serialized.encode()).hexdigest()
        value = self.store.client.eval(ADMIT,5,f'{target_ns}:jobs',f'{target_ns}:requests',f'{target_ns}:pending',f'{target_ns}:files',f'{target_ns}:digests',identifier,
            self.store.encode(record),serialized,self.maxsize,json.dumps(list(temp_files)),digest)
        if int(value[0]) == -2: raise ValueError('Idempotency key already used for a different request')
        if int(value[0]) == -1: raise QueueFull('Server busy: queue is full')
        return self.store.decode(value[1]), int(value[0])
    async def put(self,item):
        # Preserve upstream local callers that create an observer record before
        # submitting. Lua still commits durable input and membership together.
        identifier,req = item
        state = getattr(self,'app_state',None)
        files = list(state.job_temp_files.get(identifier,[])) if state is not None else []
        try:
            self.admit(req,job_id=identifier,temp_files=files)
            if state is not None:
                state.job_temp_files.pop(identifier,None)
                try:state.pending_ids.remove(identifier)
                except ValueError:pass
        except QueueFull:
            self.store.client.hdel(self.store.key('jobs'),identifier)
            if state is not None:
                state.job_temp_files.pop(identifier,None)
                try:state.pending_ids.remove(identifier)
                except ValueError:pass
            for path in files:
                try:os.remove(path)
                except OSError:pass
            from fastapi import HTTPException
            raise HTTPException(429,'Server busy: queue is full')
    def acquire(self):
        if self.max_executors > 1:
            if not self.store.client.eval(ACQUIRE_MULTI,2,self._pool_key,self.keys[4],self.owner,self.lease_ms,self.max_executors):
                return False
            self.store.client.eval(RECOVER_MULTI,5,*self.keys,self.owner)
            return True
        if not self.store.client.set(self.keys[4],self.owner,nx=True,px=self.lease_ms): return False
        self.store.client.eval(RECOVER,5,*self.keys,self.owner)
        return True
    def renew(self):
        if not self.store.client.eval(RENEW,1,self._owner_lease_key,self.owner,self.lease_ms): raise LeaseLost('Executor lease lost')
        if self.max_executors > 1:
            self.store.client.eval(RECOVER_MULTI,5,*self.keys,self.owner)
    def release(self):
        self.store.client.eval(RELEASE,1,self._owner_lease_key,self.owner)
        if self.max_executors > 1:
            self.store.client.srem(self._pool_key,self.owner)
    def claim(self):
        token = uuid4().hex
        if self.max_executors > 1:
            identifier,payload = self.store.client.eval(CLAIM_MULTI,5,self.keys[0],self.keys[1],self.keys[2],self.keys[3],self._owner_lease_key,self.owner,token)
        else:
            identifier,payload = self.store.client.eval(CLAIM,5,*self.keys,self.owner,token)
        if not identifier: return None
        self.claims[identifier] = token; self.store.claims[identifier] = (self.owner,token)
        return identifier,json.loads(payload)
    def ack(self,identifier):
        script = ACK_MULTI if self.max_executors > 1 else ACK
        if not self.store.client.eval(script,5,self.keys[0],self.keys[1],self.keys[2],self.keys[3],self._owner_lease_key,self.owner,identifier,self.claims.get(identifier,'')):
            raise LeaseLost('Cannot acknowledge an unowned or nonterminal job')
        self.claims.pop(identifier,None); self.store.claims.pop(identifier,None)
    async def wait(self,identifier):
        while True:
            record = await asyncio.to_thread(self.store.get,identifier)
            if record is None: raise RuntimeError('Accepted job record is missing')
            if record.status in ('succeeded','failed'): return record
            await asyncio.sleep(.1)
    def fatal_lease_loss(self):
        # A CUDA call cannot be cancelled in a Python thread; the process must
        # end if it cannot renew exclusive execution ownership.
        os._exit(1)
