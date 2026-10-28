"""Terminal bookkeeping independent of observers and cleanup errors."""
from __future__ import annotations
import asyncio
import os

def _notify(rec):
    if rec is None: return
    event = getattr(rec,'done_event',None)
    if event is not None: event.set()
    sink = getattr(rec,'progress_queue',None)
    if sink is None: return
    messages = ([{'type':'result','result':rec.result}] if rec.status == 'succeeded'
        else [{'type':'error','content':rec.error or 'Generation failed'}]) + [{'type':'done'}]
    for message in messages:
        try: sink.put_nowait(message)
        except Exception: break

async def process_queue_item(job_id,req,app_state,store,run_one_job,cleanup_job_temp_files):
    queue = app_state.job_queue; durable = hasattr(queue,'ack'); rec = None; cancelled = False
    try:
        rec = store.get(job_id)
        if not durable:
            async with app_state.pending_lock:
                try: app_state.pending_ids.remove(job_id)
                except ValueError: pass
        await run_one_job(job_id,req)
        local_rec = getattr(store, '_records', {}).get(job_id)
        rec = local_rec if (local_rec is not None and local_rec.status in ('succeeded','failed')) else store.get(job_id)
        if rec is not None and rec.status not in ('succeeded','failed'):
            store.mark_failed(job_id,'Worker returned without a terminal result')
    except BaseException as exc:
        cancelled = isinstance(exc,asyncio.CancelledError)
        try:
            rec = store.get(job_id) or rec
            if rec is not None and rec.status not in ('succeeded','failed'):
                store.mark_failed(job_id,'Worker cancelled' if cancelled else str(exc))
        except Exception:
            if durable: queue.fatal_lease_loss()
    finally:
        try:
            if rec is None or rec.status not in ('succeeded','failed'):
                local_rec = getattr(store, '_records', {}).get(job_id)
                rec = local_rec if (local_rec is not None and local_rec.status in ('succeeded','failed')) else (store.get(job_id) or rec)
        except Exception: pass
        _notify(rec)
        try:
            if durable:
                for path in store.temp_files(job_id):
                    try: os.remove(path)
                    except FileNotFoundError: pass
                store.clear_temp_files(job_id)
            await cleanup_job_temp_files(job_id)
        except (Exception,asyncio.CancelledError): pass
        finally:
            if durable: queue.ack(job_id)
            else: queue.task_done()
    if cancelled: raise asyncio.CancelledError

async def run_job_store_cleanup_loop(store,cleanup_interval_seconds,sleep_fn=asyncio.sleep,log_fn=print):
    while True:
        try:
            await sleep_fn(cleanup_interval_seconds)
            # Retry durable terminal-file ownership before retention cleanup.
            if hasattr(store,'client'):
                for identifier in store.client.hkeys(store.key('files')):
                    rec = store.get(identifier)
                    if rec and rec.status in ('succeeded','failed'):
                        try:
                            for path in store.temp_files(identifier):
                                try: os.remove(path)
                                except FileNotFoundError: pass
                            store.clear_temp_files(identifier)
                        except OSError: pass
            removed = store.cleanup_old_jobs()
            if removed: log_fn(f'[API Server] Cleaned up {removed} old jobs. Current stats: {store.get_stats()}')
        except asyncio.CancelledError: break
        except Exception as exc:
            try: log_fn(f'[API Server] Job cleanup error: {exc}')
            except Exception: pass
