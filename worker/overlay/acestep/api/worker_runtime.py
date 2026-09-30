"""Durable singleton queue orchestration and graceful GPU drain."""
from __future__ import annotations
import asyncio
import os
from contextlib import suppress
from acestep.api.jobs.worker_loops import process_queue_item,run_job_store_cleanup_loop

async def _heartbeat(queue):
    try:
        while True:
            await asyncio.sleep(queue.lease_ms/3000)
            await asyncio.to_thread(queue.renew)
    except asyncio.CancelledError: raise
    except BaseException: queue.fatal_lease_loss()
async def _queue_worker_loop(*,app_state,store,run_one_job,cleanup_job_temp_files):
    queue = app_state.job_queue
    try:
        while True:
            item = await asyncio.to_thread(queue.claim)
            if item is None:
                await asyncio.sleep(.1); continue
            identifier,payload = item
            if payload['kind'] == 'training':
                from acestep.api.training import execute_training_job
                async def run(identifier,req): await execute_training_job(app_state,store,identifier,req)
                req = payload['request']
            elif payload['kind'] == 'separate':
                from acestep.api.http.separate import execute_separation_job
                async def run(identifier,req): await execute_separation_job(app_state,store,identifier,req)
                req = payload['request']
            else:
                from acestep.api.http.release_task_models import GenerateMusicRequest
                run = run_one_job; req = GenerateMusicRequest(**payload['request'])
            processing = asyncio.create_task(process_queue_item(identifier,req,app_state,store,run,cleanup_job_temp_files))
            try:
                await asyncio.shield(processing)
            except asyncio.CancelledError:
                await asyncio.shield(processing)
                raise
    except asyncio.CancelledError: raise
    except BaseException: queue.fatal_lease_loss()
def start_worker_tasks(*,app_state,store,worker_count,run_one_job,cleanup_job_temp_files,cleanup_interval_seconds):
    if worker_count != 1 or os.getenv('ACESTEP_API_WORKERS','1') != '1':
        raise RuntimeError('Durable GPU scheduling requires one worker and one executor')
    queue = app_state.job_queue
    if not queue.acquire(): raise RuntimeError('Another GPU executor owns the Valkey lease')
    worker = asyncio.create_task(_queue_worker_loop(app_state=app_state,store=store,run_one_job=run_one_job,cleanup_job_temp_files=cleanup_job_temp_files))
    app_state.lease_heartbeat = asyncio.create_task(_heartbeat(queue))
    cleanup = asyncio.create_task(run_job_store_cleanup_loop(store,cleanup_interval_seconds))
    app_state.worker_tasks=[worker];app_state.cleanup_task=cleanup;app_state.durable_queue=queue
    return [worker],cleanup
async def stop_worker_tasks(*,workers,cleanup_task,executor):
    cleanup_task.cancel()
    for worker in workers: worker.cancel()
    await asyncio.gather(*workers,cleanup_task,return_exceptions=True)
    executor.shutdown(wait=True,cancel_futures=True)
async def stop_durable_runtime(app_state):
    app_state.lease_heartbeat.cancel()
    with suppress(asyncio.CancelledError): await app_state.lease_heartbeat
    await asyncio.to_thread(app_state.durable_queue.release)
