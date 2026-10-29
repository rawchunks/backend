"""Exercise the packaged worker with local Valkey and model doubles."""

import asyncio
import ast
import importlib.util
import json
import ipaddress
import os
import shutil
import sys
import threading
import time
import types
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, Mock
import pytest
import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

BASE = Path(
    os.getenv(
        "RAWCHUNKS_WORKER_SOURCE", str(Path(__file__).resolve().parents[2] / "worker")
    )
)
OVERLAY = BASE / "overlay"


def test_sample_completion_preserves_supplied_inputs():
    from acestep.api.llm_generation_inputs import prepare_llm_generation_inputs

    req = types.SimpleNamespace(
        lm_top_k=None, lm_top_p=None, thinking=False, sample_mode=True,
        sample_query="English folk song", use_format=False, use_cot_caption=False,
        use_cot_language=False, full_analysis_only=False, task_type="text2music",
        prompt="English folk song", lyrics="", bpm=100, key_scale="C major",
        time_signature="4", audio_duration=30, vocal_language="en",
        lm_temperature=.85,
    )
    sample = Mock(return_value=types.SimpleNamespace(success=True, caption="Different song", lyrics="Generated lyrics", bpm=30, keyscale="E major", timesignature="3", duration=243))
    prepared = prepare_llm_generation_inputs(app_state=types.SimpleNamespace(), llm_handler=None, req=req, selected_handler_device="cuda", parse_description_hints=lambda _: ("zh", False), create_sample_fn=sample, format_sample_fn=Mock(), ensure_llm_ready_fn=Mock())
    assert (prepared.caption, prepared.lyrics, prepared.bpm, prepared.key_scale, prepared.time_signature, prepared.audio_duration) == (req.prompt, "Generated lyrics", 100, "C major", "4", 30)
    assert sample.call_args.kwargs["vocal_language"] == "en"
    assert prepared.use_cot_caption is False and prepared.use_cot_language is False


def test_sample_completion_fills_only_missing_metadata():
    from acestep.api.llm_generation_inputs import prepare_llm_generation_inputs

    req = types.SimpleNamespace(lm_top_k=None, lm_top_p=None, thinking=False, sample_mode=True, sample_query="Folk", use_format=False, use_cot_caption=False, use_cot_language=False, full_analysis_only=False, task_type="text2music", prompt="Folk", lyrics="Existing lyrics", bpm=None, key_scale="", time_signature="", audio_duration=None, vocal_language="en", lm_temperature=.85)
    sample = lambda **_: types.SimpleNamespace(success=True, caption="Different song", lyrics="Different lyrics", bpm=100, keyscale="C major", timesignature="4", duration=30)
    prepared = prepare_llm_generation_inputs(app_state=types.SimpleNamespace(), llm_handler=None, req=req, selected_handler_device="cuda", parse_description_hints=lambda _: (None, False), create_sample_fn=sample, format_sample_fn=Mock(), ensure_llm_ready_fn=Mock())
    assert (prepared.caption, prepared.lyrics, prepared.bpm, prepared.key_scale, prepared.audio_duration) == ("Folk", "Existing lyrics", 100, "C major", 30)


@pytest.fixture(autouse=True)
def modules(monkeypatch):
    for name, path in [
        ("acestep", OVERLAY / "acestep"),
        ("acestep.api", OVERLAY / "acestep/api"),
        ("acestep.api.jobs", OVERLAY / "acestep/api/jobs"),
        ("acestep.api.http", OVERLAY / "acestep/api/http"),
    ]:
        module = types.ModuleType(name)
        module.__path__ = [str(path)]
        monkeypatch.setitem(sys.modules, name, module)
    for name in list(sys.modules):
        if name.startswith("acestep.") and name not in (
            "acestep.api",
            "acestep.api.jobs",
            "acestep.api.http",
        ):
            monkeypatch.delitem(sys.modules, name, raising=False)
    constants = types.ModuleType("acestep.constants")
    constants.DEFAULT_DIT_INSTRUCTION = "instruction"
    monkeypatch.setitem(sys.modules, constants.__name__, constants)
    handler = types.ModuleType("acestep.handler")
    handler.AceStepHandler = object
    monkeypatch.setitem(sys.modules, handler.__name__, handler)


@pytest.fixture
def durable():
    from acestep.api.jobs.store import _JobStore
    from acestep.api.jobs.durable import DurableQueue

    uri = os.getenv("RAWCHUNKS_TEST_VALKEY_URI")
    if not uri:
        pytest.skip("Set RAWCHUNKS_TEST_VALKEY_URI to a local Valkey server")
    from urllib.parse import urlsplit

    parsed = urlsplit(uri)
    if (
        parsed.scheme != "redis"
        or not parsed.hostname
        or not ipaddress.ip_address(parsed.hostname).is_loopback
    ):
        pytest.fail("RAWCHUNKS_TEST_VALKEY_URI must use a loopback Redis URL")
    client = redis.Redis.from_url(uri, decode_responses=True)
    ns = "rawchunks:test:worker:" + uuid.uuid4().hex
    store = _JobStore(client=client, namespace=ns)
    queue = DurableQueue(store, 1)
    try:
        yield store, queue
    finally:
        for key in client.scan_iter(ns + ":*"):
            client.delete(key)


def test_atomic_admission_capacity_no_orphans(durable):
    from acestep.api.jobs.durable import QueueFull

    store, q = durable
    q.admit({"prompt": "one"}, job_id="job")
    for _ in range(100):
        with pytest.raises(QueueFull):
            q.admit({"prompt": "two"})
    assert store.get_stats()["total"] == 1 and q.qsize() == 1


def test_idempotent_replay_and_conflict_after_ack(durable):
    store, q = durable
    first, _ = q.admit({"prompt": "one"}, job_id="job")
    q.acquire()
    q.claim()
    store.mark_running("job")
    store.mark_succeeded("job", {"audio_paths": ["x"]})
    q.ack("job")
    replay, _ = q.admit({"prompt": "one"}, job_id="job")
    assert (
        replay.job_id == first.job_id
        and replay.status == "succeeded"
        and q.qsize() == 0
    )
    with pytest.raises(ValueError, match="different"):
        q.admit({"prompt": "two"}, job_id="job")


def test_restart_recovery_fences_old_executor(durable):
    from acestep.api.jobs.store import _JobStore
    from acestep.api.jobs.durable import DurableQueue, LeaseLost

    store, q = durable
    q.admit({"prompt": "one"}, job_id="job")
    assert q.acquire()
    q.claim()
    store.mark_running("job")
    fresh = _JobStore(client=store.client, namespace=store.namespace)
    other = DurableQueue(fresh, 1)
    assert fresh.get("job").status == "running" and not other.acquire()
    store.client.delete(q.keys[4])
    assert other.acquire()
    assert other.claim()[0] == "job"
    with pytest.raises(LeaseLost):
        store.mark_succeeded("job", {})
    fresh.mark_succeeded("job", {"audio_paths": ["new"]})
    other.ack("job")
    assert q.qsize() == 0


def test_concurrent_admission_rejects_without_block(durable):
    from acestep.api.jobs.durable import QueueFull

    store, q = durable

    def admit(i):
        try:
            return q.admit({"prompt": str(i)}, job_id="job-" + str(i))[0].job_id
        except QueueFull:
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(admit, range(100)))
    assert len([x for x in results if x]) == 1 and store.get_stats()["total"] == 1


def test_terminal_cleanup_failure_ack_balanced_and_retries(
    durable, tmp_path, monkeypatch
):
    from acestep.api.jobs import worker_loops

    store, q = durable
    path = tmp_path / "upload"
    path.write_bytes(b"x")
    q.admit({}, job_id="job", temp_files=[str(path)])
    q.acquire()
    q.claim()

    async def run(*_):
        store.mark_succeeded("job", {})

    state = types.SimpleNamespace(job_queue=q)
    remove = worker_loops.os.remove

    def denied(p):
        raise PermissionError("denied")

    monkeypatch.setattr(worker_loops.os, "remove", denied)
    asyncio.run(
        worker_loops.process_queue_item("job", {}, state, store, run, AsyncMock())
    )
    assert (
        q.qsize() == 0
        and store.temp_files("job") == [str(path)]
        and store.client.hlen(q.keys[3]) == 0
    )
    monkeypatch.setattr(worker_loops.os, "remove", remove)

    async def sleep(_):
        if not path.exists():
            raise asyncio.CancelledError

    asyncio.run(worker_loops.run_job_store_cleanup_loop(store, 1, sleep_fn=sleep))
    assert not path.exists() and store.temp_files("job") == []


def test_bounded_observer_does_not_block_cleanup(durable):
    from acestep.api.jobs import worker_loops

    store, q = durable
    q.admit({}, job_id="job")
    q.acquire()
    q.claim()

    async def scenario():
        rec = store.get("job")
        rec.done_event = asyncio.Event()
        rec.progress_queue = asyncio.Queue(maxsize=1)

        async def run(*_):
            store.mark_succeeded("job", {})

        await worker_loops.process_queue_item(
            "job", {}, types.SimpleNamespace(job_queue=q), store, run, AsyncMock()
        )
        assert rec.done_event.is_set() and q.qsize() == 0

    asyncio.run(scenario())


@pytest.fixture
def separation(durable, monkeypatch, tmp_path):
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    api = types.ModuleType("demucs.api")
    separator = Mock()
    separator.samplerate = 44100
    separator.separate_audio_file.return_value = (
        0,
        {"vocals": 1, "drums": 2, "bass": 3, "other": 4},
    )
    api.Separator = Mock(return_value=separator)

    def save(tensor, path, **kwargs):
        Path(path).write_bytes(b"output")

    api.save_audio = Mock(side_effect=save)
    demucs = types.ModuleType("demucs")
    demucs.api = api
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "demucs", demucs)
    monkeypatch.setitem(sys.modules, "demucs.api", api)
    from acestep.api.http import separate

    store, q = durable
    q.maxsize = 100
    assert q.acquire()
    app = FastAPI()
    app.state.temp_audio_dir = str(tmp_path / "audio")
    Path(app.state.temp_audio_dir).mkdir()
    app.state.executor = ThreadPoolExecutor(max_workers=1)
    app.state.job_queue = q

    async def verify(request: Request):
        if request.headers.get("Authorization") != "Bearer key":
            raise HTTPException(401, "Unauthorized")

    separate.register_separate_route(app, verify, lambda data: {"data": data}, store)
    stop = threading.Event()

    def consume():
        async def loop():
            from acestep.api.jobs.worker_loops import process_queue_item

            while not stop.is_set():
                item = q.claim()
                if item:
                    identifier, payload = item

                    async def run(identifier, req):
                        await separate.execute_separation_job(
                            app.state, store, identifier, req
                        )

                    await process_queue_item(
                        identifier,
                        payload["request"],
                        app.state,
                        store,
                        run,
                        AsyncMock(),
                    )
                else:
                    await asyncio.sleep(0.001)

        asyncio.run(loop())

    thread = threading.Thread(target=consume)
    thread.start()
    source = Path(app.state.temp_audio_dir) / "source.wav"
    source.write_bytes(b"fake audio")
    data = types.SimpleNamespace(
        module=separate,
        app=app,
        client=TestClient(app),
        store=store,
        queue=q,
        source=source,
        api=api,
        separator=separator,
        headers={"Authorization": "Bearer key"},
        tmp=tmp_path,
    )
    try:
        yield data
    finally:
        stop.set()
        thread.join()
        app.state.executor.shutdown()


@pytest.mark.parametrize(
    "mode", ["all", "vocals", "drums", "bass", "other", "instrumental"]
)
def test_separation_stem_type_and_retry_receipt(separation, mode):
    f = separation
    headers = {**f.headers, "Idempotency-Key": "sep-job"}
    first = f.client.post(
        "/isolate",
        json={"src_audio_path": str(f.source), "stem_type": mode},
        headers=headers,
    )
    assert first.status_code == 200
    stems = first.json()["data"]["stems"]
    assert list(stems) == (
        ["vocals", "drums", "bass", "other"]
        if mode == "all"
        else [mode]
    )
    retry = f.client.post(
        "/isolate",
        json={"src_audio_path": str(f.source), "stem_type": mode},
        headers=headers,
    )
    assert retry.json() == first.json()
    f.separator.separate_audio_file.assert_called_once()


def test_separation_sandbox_query_parse_and_symlink(separation):
    f = separation
    private = f.tmp / "secret"
    private.write_bytes(b"secret")
    for src in [str(private), "/v1/audio?path=" + str(private)]:
        assert (
            f.client.post(
                "/isolate", json={"src_audio_path": src}, headers=f.headers
            ).status_code
            == 403
        )
    link = Path(f.app.state.temp_audio_dir) / "link"
    link.symlink_to(private)
    assert (
        f.client.post(
            "/isolate", json={"src_audio_path": str(link)}, headers=f.headers
        ).status_code
        == 403
    )
    query = "/v1/audio?" + __import__("urllib.parse", fromlist=["urlencode"]).urlencode(
        {"path": str(f.source), "download": "1"}
    )
    assert (
        f.client.post(
            "/isolate", json={"src_audio_path": query}, headers=f.headers
        ).status_code
        == 200
    )


def test_metadata_and_redirect_urls_fail_closed(separation, monkeypatch):
    f = separation
    resolver = Mock(return_value=[(2, 1, 6, "", ("169.254.169.254", 80))])
    monkeypatch.setattr(f.module, "resolve_host", resolver)
    assert (
        f.client.post(
            "/isolate",
            json={"src_audio_path": "http://169.254.169.254/audio"},
            headers=f.headers,
        ).status_code
        == 403
    )
    assert f.store.get_stats()["total"] == 0


def test_download_bound_and_failure_terminal(separation, monkeypatch):
    import io

    f = separation
    monkeypatch.setattr(
        f.module,
        "resolve_host",
        lambda *_args, **_kw: [(2, 1, 6, "", ("8.8.8.8", 443))],
    )

    class Body(io.BytesIO):
        headers = {
            "Content-Type": "audio/wav",
            "Content-Length": str(f.module.MAX_AUDIO_BYTES + 1),
        }

    opener = Mock()
    opener.open.return_value = Body(b"x")
    monkeypatch.setattr(
        f.module.urllib.request, "build_opener", Mock(return_value=opener)
    )
    r = f.client.post(
        "/isolate",
        json={"src_audio_path": "https://example.com/audio"},
        headers={**f.headers, "Idempotency-Key": "sep-remote"},
    )
    assert r.status_code == 500 and f.store.get("sep-remote").status == "failed"
    assert opener.open.call_args.kwargs["timeout"] > 0
    assert not list(Path(f.app.state.temp_audio_dir).glob("*input*"))


def test_gpu_generation_and_separation_share_one_gate(separation):
    from acestep.api.gpu import run_gpu

    f = separation
    active = 0
    maximum = 0
    lock = threading.Lock()

    def execute(*_):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.01)
        with lock:
            active -= 1
        return 0, {"vocals": 1, "drums": 2, "bass": 3, "other": 4}

    f.separator.separate_audio_file.side_effect = execute

    def generation(_):
        return asyncio.run(run_gpu(f.app.state, execute))

    def separate(_):
        return f.client.post(
            "/isolate", json={"src_audio_path": str(f.source)}, headers=f.headers
        ).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        calls = [
            pool.submit(generation, i) if i % 2 else pool.submit(separate, i)
            for i in range(8)
        ]
        results = [c.result() for c in calls]
    assert maximum == 1 and all(x == 200 for i, x in enumerate(results) if not i % 2)


def test_job_lora_restores_manual_state_and_failure_blocks_handler():
    from acestep.api.gpu import apply_job_lora

    handler = Mock()
    handler.lora_loaded = True
    handler.model = object()
    handler._rawchunks_manual_lora = {
        "adapters": [{"path": "/adapters/style", "name": "style", "scale": 0.4}],
        "enabled": False,
        "active_adapter": "style",
    }
    for name in (
        "unload_lora",
        "load_lora",
        "add_lora",
        "set_lora_scale",
        "set_use_lora",
        "set_active_lora_adapter",
    ):
        getattr(handler, name).return_value = "✅ ok"
    cleanup = apply_job_lora(
        handler, types.SimpleNamespace(lora_path="/adapters/voice", lora_alpha=0.7)
    )
    cleanup()
    handler.load_lora.assert_called_once_with("/adapters/voice")
    handler.add_lora.assert_called_once_with("/adapters/style", adapter_name="style")
    assert handler.set_lora_scale.call_args.args == ("style", 0.4)
    assert handler.set_use_lora.call_args.args == (False,)
    handler.unload_lora.side_effect = ["✅ ok", "❌ failed"]
    cleanup = apply_job_lora(
        handler, types.SimpleNamespace(lora_path="/adapters/voice", lora_alpha=0.7)
    )
    with pytest.raises(RuntimeError):
        cleanup()
    assert handler.model is None


def test_patch_preflight_idempotent_and_drift_fail_closed(tmp_path):
    spec = importlib.util.spec_from_file_location("tested_patch", BASE / "patch.py")
    patch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patch)
    overlay = tmp_path / "overlay"
    root = tmp_path / "root"
    overlay.mkdir()
    root.mkdir()
    (overlay / "a.py").write_text("x=2\n")
    (root / "a.py").write_text("x=1\n")
    (overlay / "b.py").write_text("y=2\n")
    (root / "b.py").write_text("y=1\n")
    import hashlib

    manifest = tmp_path / "manifest"
    manifest.write_text(
        json.dumps(
            {
                "files": {
                    "a.py": hashlib.sha256(b"x=1\n").hexdigest(),
                    "b.py": hashlib.sha256(b"y=1\n").hexdigest(),
                }
            }
        )
    )
    (root / "b.py").write_text("drift\n")
    with pytest.raises(RuntimeError):
        patch.install(root, overlay, manifest)
    assert (root / "a.py").read_text() == "x=1\n"
    (root / "b.py").write_text("y=1\n")
    assert patch.install(root, overlay, manifest) == 2
    assert patch.install(root, overlay, manifest) == 0


def test_real_worker_runtime_mixed_jobs_and_graceful_shutdown(
    durable, monkeypatch, tmp_path
):
    from acestep.api import worker_runtime

    store, q = durable
    q.maxsize = 10
    from acestep.api.jobs.store import _JobStore
    from acestep.api.jobs.durable import DurableQueue

    app = FastAPI()
    app.state.executor = ThreadPoolExecutor(max_workers=1)
    app.state.job_queue = q
    app.state.temp_audio_dir = str(tmp_path)
    fake = types.ModuleType("acestep.api.http.separate")
    executed = []

    async def separate(state, store, identifier, req):
        executed.append(("separate", identifier))
        store.mark_running(identifier)
        store.mark_succeeded(identifier, {"stems": {"vocals": "x"}})

    fake.execute_separation_job = separate
    monkeypatch.setitem(sys.modules, fake.__name__, fake)

    async def run(identifier, req):
        executed.append(("generate", identifier))
        store.mark_running(identifier)
        store.mark_succeeded(identifier, {"audio_paths": ["y"]})

    async def scenario():
        q.admit({"prompt": "x"}, job_id="gen")
        q.admit({"src_audio_path": "x"}, kind="separate", job_id="sep")
        workers, cleanup = worker_runtime.start_worker_tasks(
            app_state=app.state,
            store=store,
            worker_count=1,
            run_one_job=run,
            cleanup_job_temp_files=AsyncMock(),
            cleanup_interval_seconds=100,
        )
        await asyncio.wait_for(q.wait("sep"), 1)
        await worker_runtime.stop_worker_tasks(
            workers=workers, cleanup_task=cleanup, executor=app.state.executor
        )
        await worker_runtime.stop_durable_runtime(app.state)
        assert not store.client.get(q.keys[4]) and store.client.hlen(q.keys[3]) == 0

    asyncio.run(scenario())
    assert executed == [("generate", "gen"), ("separate", "sep")]


def test_release_route_admits_stable_task_and_cleans_rejection(
    durable, monkeypatch, tmp_path
):
    parser = types.ModuleType("acestep.api.http.release_task_request_parser")
    parser.parse_release_task_request = AsyncMock(
        return_value=(types.SimpleNamespace(prompt="x"), [])
    )
    monkeypatch.setitem(sys.modules, parser.__name__, parser)
    from acestep.api.http.release_task_route import register_release_task_route

    store, q = durable
    app = FastAPI()
    app.state.job_queue = q
    register_release_task_route(
        app,
        Mock(),
        lambda data: {"data": data},
        store,
        object,
        object,
        Mock(),
        AsyncMock(),
        object,
        "",
        0.8,
        2,
        0.9,
    )
    endpoint = next(
        r.endpoint for r in app.routes if getattr(r, "path", "") == "/release_task"
    )

    async def scenario():
        first = await endpoint(Mock(), None, "stable-id")
        assert first["data"]["task_id"] == "stable-id"
        assert (await endpoint(Mock(), None, "stable-id"))["data"][
            "task_id"
        ] == "stable-id"
        upload = tmp_path / "upload"
        upload.write_bytes(b"x")
        parser.parse_release_task_request.return_value = (
            types.SimpleNamespace(prompt="two"),
            [str(upload)],
        )
        with pytest.raises(HTTPException) as exc:
            await endpoint(Mock(), None, "other-id")
        assert (
            exc.value.status_code == 429
            and not upload.exists()
            and store.get("other-id") is None
        )

    asyncio.run(scenario())


def test_completed_recovery_preserves_result_without_rerun(durable):
    from acestep.api.jobs.store import _JobStore
    from acestep.api.jobs.durable import DurableQueue

    store, q = durable
    q.admit({}, job_id="job")
    q.acquire()
    q.claim()
    store.mark_succeeded("job", {"audio_paths": ["x"]})
    store.client.delete(q.keys[4])
    other = DurableQueue(_JobStore(client=store.client, namespace=store.namespace), 1)
    assert other.acquire()
    assert other.claim() is None and store.get("job").result == {"audio_paths": ["x"]}


def test_pinned_remote_transport_uses_validated_ip_and_original_tls_host(
    separation, monkeypatch
):
    f = separation
    monkeypatch.setattr(
        f.module, "resolve_host", lambda *a, **k: [(2, 1, 6, "", ("8.8.8.8", 443))]
    )
    handler = f.module._PinnedHTTPSHandler()
    socket_connect = Mock()
    monkeypatch.setattr(f.module.socket, "create_connection", socket_connect)
    seen = {}

    def do_open(factory, request, **kwargs):
        connection = factory("audio.example:443", timeout=5)
        seen["host"] = connection.host
        connection._create_connection(("audio.example", 443), 5, None)
        return object()

    monkeypatch.setattr(handler, "do_open", do_open)
    handler.https_open(f.module.urllib.request.Request("https://audio.example/file"))
    assert seen["host"] == "audio.example" and socket_connect.call_args.args[0] == (
        "8.8.8.8",
        443,
    )


def test_query_result_preserves_stems_for_lost_http_receipt(durable):
    from acestep.api.http.query_result_service import collect_query_results

    store, q = durable
    q.admit({}, kind="separate", job_id="sep")
    q.acquire()
    q.claim()
    store.mark_succeeded(
        "sep",
        {
            "audio_paths": ["vocals.wav"],
            "stems": {"vocals": "/v1/audio?path=vocals.wav"},
            "metas": {"caption": "vocals"},
        },
    )
    result = collect_query_results(
        ["sep"],
        None,
        store,
        lambda status: 1 if status == "succeeded" else 0,
        "prefix",
        600,
        lambda: "",
    )[0]
    assert (
        result["stems"] == {"vocals": "/v1/audio?path=vocals.wav"}
        and result["status"] == 1
    )
    assert json.loads(result["result"])[0]["file"] == "vocals.wav"


@pytest.mark.parametrize("name", ["jobs", "requests", "pending", "files", "digests"])
def test_admission_preflight_wrongtype_has_no_partial_mutation(durable, name):
    store, q = durable
    key = store.key(name)
    store.client.set(key, "corrupted")
    before = {
        k: store.client.dump(k) for k in store.client.scan_iter(store.namespace + ":*")
    }
    with pytest.raises(redis.ResponseError, match="WRONGTYPE"):
        q.admit({"prompt": "x"}, job_id="never-admitted")
    after = {
        k: store.client.dump(k) for k in store.client.scan_iter(store.namespace + ":*")
    }
    assert after == before


@pytest.mark.parametrize(
    "operation,corrupt",
    [("claim", "active"), ("recover", "pending"), ("ack", "requests")],
)
def test_claim_recovery_ack_preflight_cannot_partially_modify_state(
    durable, operation, corrupt
):
    from acestep.api.jobs.durable import RECOVER

    store, q = durable
    q.admit({}, job_id="job")
    q.acquire()
    if operation == "ack":
        q.claim()
        store.mark_succeeded("job", {})
    key = store.key(corrupt)
    store.client.delete(key)
    store.client.set(key, "corrupt")
    before = {
        k: store.client.dump(k)
        for k in store.client.scan_iter(store.namespace + ":*")
        if k != store.key("executor")
    }
    with pytest.raises(redis.ResponseError, match="WRONGTYPE"):
        if operation == "claim":
            q.claim()
        elif operation == "ack":
            q.ack("job")
        else:
            store.client.eval(RECOVER, 5, *q.keys, q.owner)
    after = {
        k: store.client.dump(k)
        for k in store.client.scan_iter(store.namespace + ":*")
        if k != store.key("executor")
    }
    assert before == after


def test_existing_local_queue_put_preserves_observers_and_atomic_membership(durable):
    store, q = durable
    rec = store.create()
    rec.done_event = asyncio.Event()
    rec.progress_queue = asyncio.Queue()
    asyncio.run(q.put((rec.job_id, types.SimpleNamespace(prompt="local"))))
    assert (
        store.get(rec.job_id) is rec and rec.done_event is not None and q.qsize() == 1
    )
    q.acquire()
    identifier, payload = q.claim()
    assert identifier == rec.job_id and payload["request"]["prompt"] == "local"


def test_separation_source_matches_packaged_overlay():
    assert (BASE / "separate.py").read_bytes() == (
        BASE / "overlay/acestep/api/http/separate.py"
    ).read_bytes()


def test_overlay_has_no_added_provider_module():
    assert not (BASE / "overlay/acestep/openrouter_adapter.py").exists()
    # Training registration is a reviewed pinned overlay; provider adapter stays upstream.
    assert (BASE / "overlay/acestep/api/train_api_service.py").is_file()


def test_all_packaged_modules_compile_and_manifest_is_complete():
    overlay = BASE / "overlay"
    manifest = json.loads((BASE / "source.json").read_text())
    files = {p.relative_to(overlay).as_posix() for p in overlay.rglob("*.py")}
    assert files == set(manifest["files"])
    for relative in files:
        compile((overlay / relative).read_bytes(), relative, "exec")


def test_lifespan_queue_and_shutdown_install_actual_durable_runtime():
    overlay = BASE / "overlay/acestep"
    lifespan = (overlay / "api/lifespan_runtime.py").read_text()
    server = (overlay / "api_server.py").read_text()
    assert (
        "app.state.job_queue = DurableQueue(store, maxsize=queue_maxsize)" in lifespan
    )
    assert (
        "await stop_worker_tasks(" in server
        and "await stop_durable_runtime(app.state)" in server
    )
    assert "app.state.local_cache = None" in lifespan


@pytest.fixture
def startup(monkeypatch, tmp_path):
    downloader = types.ModuleType("acestep.model_downloader")
    downloader.get_checkpoints_dir = lambda: tmp_path
    gpu = types.ModuleType("acestep.gpu_config")
    gpu.VRAM_AUTO_OFFLOAD_THRESHOLD_GB = 20
    gpu.get_gpu_config = lambda: types.SimpleNamespace(gpu_memory_gb=40)
    gpu.set_global_gpu_config = lambda config: None
    llm = types.ModuleType("acestep.api.startup_llm_init")
    llm.initialize_llm_at_startup = Mock()
    for module in [downloader, gpu, llm]:
        monkeypatch.setitem(sys.modules, module.__name__, module)
    from acestep.api import startup_model_init

    monkeypatch.setenv("ACESTEP_CONFIG_PATH", "acestep-v15-xl-turbo")
    monkeypatch.setenv("ACESTEP_OFFLOAD_TO_CPU", "true")
    monkeypatch.setenv("ACESTEP_OFFLOAD_DIT_TO_CPU", "false")
    handlers = [Mock(), Mock(), Mock()]
    for handler in handlers:
        handler.initialize_service.return_value = ("loaded", True)
    app = FastAPI()
    app.state.gpu_config = gpu.get_gpu_config()
    app.state._initialized = app.state._initialized2 = app.state._initialized3 = False
    kwargs = {
        "app": app, "handler": handlers[0], "handler2": handlers[1], "handler3": handlers[2],
        "llm_handler": object(), "config_path2": "acestep-v15-xl-sft", "config_path3": "acestep-v15-xl-base",
        "get_project_root": lambda: str(tmp_path), "get_model_name": lambda name: name,
        "ensure_model_downloaded": Mock(),
        "env_bool": lambda name, default: os.getenv(name, str(default)).lower() == "true",
    }
    return types.SimpleNamespace(module=startup_model_init, kwargs=kwargs, handlers=handlers, llm=llm, app=app)


def test_startup_loads_every_configured_slot_on_gpu(startup):
    startup.module.do_model_initialization(**startup.kwargs)
    for index, handler in enumerate(startup.handlers):
        suffix = str(index + 1) if index else ""
        assert getattr(startup.app.state, "_initialized" + suffix)
        assert handler.initialize_service.call_args.kwargs["offload_dit_to_cpu"] is False
    startup.llm.initialize_llm_at_startup.assert_called_once()


@pytest.mark.parametrize("slot", [0, 1, 2])
@pytest.mark.parametrize("failure", ["download", "returned", "raised"])
def test_startup_rejects_any_failed_configured_slot(startup, slot, failure):
    models = ["acestep-v15-xl-turbo", "acestep-v15-xl-sft", "acestep-v15-xl-base"]
    if failure == "download":
        def download(model, directory):
            if model == models[slot]:
                raise RuntimeError("checkpoint unavailable")
        startup.kwargs["ensure_model_downloaded"].side_effect = download
    elif failure == "returned":
        startup.handlers[slot].initialize_service.return_value = ("checkpoint unavailable", False)
    else:
        startup.handlers[slot].initialize_service.side_effect = RuntimeError("checkpoint unavailable")
    with pytest.raises(RuntimeError, match="checkpoint unavailable"):
        startup.module.do_model_initialization(**startup.kwargs)
    suffix = str(slot + 1) if slot else ""
    assert not getattr(startup.app.state, "_initialized" + suffix)
    startup.llm.initialize_llm_at_startup.assert_not_called()
    for handler in startup.handlers[slot + 1:]:
        handler.initialize_service.assert_not_called()


@pytest.mark.parametrize("init_fails", [False, True])
def test_startup_initializes_models_before_acquiring_executor_lease(init_fails):
    from contextlib import asynccontextmanager

    source = ast.parse((OVERLAY / "acestep/api_server.py").read_text())
    lifespan = next(node for node in ast.walk(source) if isinstance(node, ast.AsyncFunctionDef) and node.name == "lifespan")
    events = []
    runtime = types.SimpleNamespace(**dict.fromkeys(["handler", "llm_handler", "handler2", "handler3", "config_path2", "config_path3", "executor"]))

    def initialize(**kwargs):
        events.append("initialize")
        if init_fails:
            raise RuntimeError("Initialization failed")

    def start(**kwargs):
        events.append("acquire")
        return [], None

    async def stop(**kwargs):
        events.append("drain")

    async def release(state):
        events.append("release")

    scope = dict.fromkeys([
        "store", "QUEUE_MAXSIZE", "INITIAL_AVG_JOB_SECONDS", "AVG_WINDOW", "WORKER_COUNT", "JOB_STORE_CLEANUP_INTERVAL",
        "_get_project_root", "initialize_training_state", "_get_model_name", "_ensure_model_downloaded", "_env_bool",
    ])
    scope.update({
        "asynccontextmanager": asynccontextmanager, "FastAPI": FastAPI, "asyncio": asyncio,
        "GenerateMusicRequest": object, "AceStepHandler": object, "LLMHandler": object,
        "initialize_lifespan_runtime": lambda **kwargs: runtime,
        "initialize_models_at_startup": initialize, "start_worker_tasks": start,
        "stop_worker_tasks": stop, "stop_durable_runtime": release,
    })
    exec(compile(ast.Module(body=[lifespan], type_ignores=[]), "api_server.py", "exec"), scope)

    async def scenario():
        app = FastAPI()
        app.state.role = "generation"
        app.state._config_path = app.state._config_path2 = app.state._config_path3 = ""
        async with scope["lifespan"](app):
            events.append("ready")

    if init_fails:
        with pytest.raises(RuntimeError, match="Initialization failed"):
            asyncio.run(scenario())
        assert events == ["initialize"]
    else:
        asyncio.run(scenario())
        assert events == ["initialize", "acquire", "ready", "drain", "release"]


@pytest.mark.parametrize(
    "payload,status",
    [
        ({}, 422),
        ({"src_audio_path": ""}, 400),
        ({"src_audio_path": None}, 422),
        ({"src_audio_path": "x", "stem_type": "unsupported"}, 422),
    ],
)
def test_separation_invalid_request_and_auth_precede_admission(
    separation, payload, status
):
    f = separation
    assert (
        f.client.post("/isolate", json=payload, headers=f.headers).status_code
        == status
    )
    assert (
        f.client.post("/isolate", json={"src_audio_path": str(f.source)}).status_code
        == 401
    )
    assert f.store.get_stats()["total"] == 0


def test_missing_input_and_inference_error_terminalize(separation):
    f = separation
    assert (
        f.client.post(
            "/isolate",
            json={"src_audio_path": str(f.source.parent / "missing")},
            headers=f.headers,
        ).status_code
        == 404
    )
    f.separator.separate_audio_file.side_effect = RuntimeError("inference failed")
    r = f.client.post(
        "/isolate",
        json={"src_audio_path": str(f.source)},
        headers={**f.headers, "Idempotency-Key": "sep-error"},
    )
    assert r.status_code == 500 and f.store.get("sep-error").status == "failed"
    assert f.store.client.hlen(f.queue.keys[3]) == 0


@pytest.mark.parametrize("cuda,expected", [(False, "cpu"), (True, "cuda")])
def test_separator_lazy_singleton_device_selection(separation, cuda, expected):
    f = separation
    f.module.torch.cuda.is_available = lambda: cuda
    first = f.module.get_separator()
    assert f.module.get_separator() is first
    f.api.Separator.assert_called_once_with(model="htdemucs", device=expected)


def test_missing_stems_all_skips_and_explicit_mode_fails(separation):
    f = separation
    f.separator.separate_audio_file.return_value = (0, {"vocals": 1})
    all_result = f.client.post(
        "/isolate", json={"src_audio_path": str(f.source)}, headers=f.headers
    )
    assert list(all_result.json()["data"]["stems"]) == ["vocals"]
    explicit = f.client.post(
        "/isolate",
        json={"src_audio_path": str(f.source), "stem_type": "instrumental"},
        headers=f.headers,
    )
    assert explicit.status_code == 500


def test_remote_success_streams_then_cleans_input(separation, monkeypatch):
    import io

    f = separation
    monkeypatch.setattr(
        f.module, "resolve_host", lambda *a, **k: [(2, 1, 6, "", ("8.8.8.8", 443))]
    )

    class Body(io.BytesIO):
        headers = {"Content-Type": "audio/wav", "Content-Length": "5"}

    opener = Mock()
    opener.open.return_value = Body(b"audio")
    monkeypatch.setattr(
        f.module.urllib.request, "build_opener", Mock(return_value=opener)
    )
    result = f.client.post(
        "/isolate",
        json={"src_audio_path": "https://audio.example/file"},
        headers={**f.headers, "Idempotency-Key": "remote-success"},
    )
    assert (
        result.status_code == 200
        and f.store.get("remote-success").status == "succeeded"
    )
    assert f.separator.separate_audio_file.call_args.args[0].endswith(
        "remote-success_input.audio"
    )
    assert not list(Path(f.app.state.temp_audio_dir).glob("*input*"))


def test_progress_store_lifecycle_retention_and_duplicate_identity(durable):
    from acestep.api.jobs.store import _JobStore

    store, q = durable
    rec = store.create_with_id("manual", env="production")
    store.mark_running("manual")
    store.update_progress("manual", 0.4, "diffusion")
    store.update_progress_text("manual", "text")
    store.update_status_text("manual", "status")
    assert (
        rec is store.get("manual")
        and rec.progress == 0.4
        and rec.env == "production"
        and rec.stage == "diffusion"
    )
    assert rec.progress_text == "text" and rec.status_text == "status"
    store.mark_succeeded("manual", {"x": 1})
    store.mark_failed("manual", "late failure")
    assert (
        store.create_with_id("manual") is rec
        and rec.status == "succeeded"
        and rec.result == {"x": 1}
    )
    assert _JobStore(client=store.client, namespace=store.namespace).get(
        "manual"
    ).result == {"x": 1}
    assert (
        store.cleanup_old_jobs(max_age_seconds=-1) == 1 and store.get("manual") is None
    )


@pytest.mark.parametrize("value", [-2, 0, 0.25, 2, "0.4"])
def test_store_progress_clamping(durable, value):
    store, _ = durable
    store.create_with_id("job")
    store.update_progress("job", value)
    assert store.get("job").progress == max(0, min(1, float(value)))


@pytest.mark.parametrize("value", [float("nan"), float("inf"), "bad"])
def test_store_rejects_invalid_progress_without_mutation(durable, value):
    store, _ = durable
    store.create_with_id("job")
    with pytest.raises(ValueError):
        store.update_progress("job", value)
    assert store.get("job").progress == 0


@pytest.mark.parametrize(
    "method,args",
    [("mark_running", ()), ("mark_succeeded", ({},)), ("mark_failed", ("error",))],
)
def test_store_missing_lifecycle_id_raises(durable, method, args):
    store, _ = durable
    with pytest.raises(KeyError):
        getattr(store, method)("missing", *args)


def test_local_queue_put_full_cleans_only_unadmitted_record(durable, tmp_path):
    store, q = durable
    q.admit({}, job_id="accepted")
    rejected = store.create()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(q.put((rejected.job_id, types.SimpleNamespace(prompt="rejected"))))
    assert exc.value.status_code == 429 and store.get(rejected.job_id) is None
    assert store.get("accepted") is not None and q.qsize() == 1


def test_process_cancelled_inference_balances_queue_and_wakes_waiters():
    from acestep.api.jobs.worker_loops import process_queue_item

    async def scenario():
        queue = asyncio.Queue()
        queue.put_nowait(("job", {}))
        queue.get_nowait()
        record = types.SimpleNamespace(
            status="running",
            result=None,
            error=None,
            done_event=asyncio.Event(),
            progress_queue=asyncio.Queue(),
        )
        store = Mock()
        store.get.return_value = record

        def fail(*args):
            record.status = "failed"
            record.error = args[1]

        store.mark_failed.side_effect = fail
        with pytest.raises(asyncio.CancelledError):
            await process_queue_item(
                "job",
                {},
                types.SimpleNamespace(
                    job_queue=queue, pending_lock=asyncio.Lock(), pending_ids=["job"]
                ),
                store,
                AsyncMock(side_effect=asyncio.CancelledError),
                AsyncMock(),
            )
        assert (
            record.status == "failed"
            and record.done_event.is_set()
            and queue._unfinished_tasks == 0
        )

    asyncio.run(scenario())


def test_cancelled_worker_drains_gpu_call_before_releasing_claim(durable):
    from acestep.api import worker_runtime
    from acestep.api.gpu import run_gpu

    store, q = durable
    state = types.SimpleNamespace(
        job_queue=q, executor=ThreadPoolExecutor(max_workers=1)
    )
    started = threading.Event()
    finished = threading.Event()

    def inference():
        started.set()
        time.sleep(0.04)
        finished.set()
        return {}

    async def run(identifier, req):
        store.mark_running(identifier)
        result = await run_gpu(state, inference)
        store.mark_succeeded(identifier, result)

    async def scenario():
        q.admit({}, job_id="job")
        workers, cleanup = worker_runtime.start_worker_tasks(
            app_state=state,
            store=store,
            worker_count=1,
            run_one_job=run,
            cleanup_job_temp_files=AsyncMock(),
            cleanup_interval_seconds=100,
        )
        await asyncio.to_thread(started.wait)
        await worker_runtime.stop_worker_tasks(
            workers=workers, cleanup_task=cleanup, executor=state.executor
        )
        assert (
            finished.is_set()
            and store.get("job").status == "succeeded"
            and store.client.hlen(q.keys[3]) == 0
        )
        await worker_runtime.stop_durable_runtime(state)

    asyncio.run(scenario())


def test_invalid_record_json_cannot_pop_pending_job(durable):
    store, q = durable
    q.admit({}, job_id="job")
    q.acquire()
    store.client.hset(store.key("jobs"), "job", "invalid-json")
    with pytest.raises(redis.ResponseError):
        q.claim()
    assert q.qsize() == 1 and store.client.lindex(store.key("pending"), 0) == "job"


def test_actual_generation_runtime_applies_lora_before_result_and_restores_after(
    durable,
):
    from acestep.api.job_execution_runtime import run_one_job_runtime

    store, q = durable
    q.admit({}, job_id="job")
    q.acquire()
    q.claim()
    handler = Mock()
    handler.model = object()
    handler.lora_loaded = False
    handler._rawchunks_manual_lora = {}
    events = []
    handler.unload_lora.side_effect = lambda: events.append("unload") or "✅ ok"
    handler.load_lora.side_effect = lambda p: events.append("load:" + p) or "✅ ok"
    handler.set_lora_scale.side_effect = lambda s: events.append("scale") or "✅ ok"
    handler.set_use_lora.return_value = "✅ ok"
    handler._empty_cache = Mock()
    state = types.SimpleNamespace(
        job_store=store,
        executor=ThreadPoolExecutor(max_workers=1),
        handler=handler,
        stats_lock=asyncio.Lock(),
        recent_durations=[],
    )

    def result(*_):
        events.append("generate")
        return {"audio_paths": ["x"]}

    async def scenario():
        await run_one_job_runtime(
            app_state=state,
            store=store,
            job_id="job",
            req=types.SimpleNamespace(model=None, lora_path="/voice", lora_alpha=0.7),
            ensure_models_initialized_fn=AsyncMock(),
            select_generation_handler_fn=lambda **kw: (handler, "model"),
            get_model_name=lambda x: x,
            build_blocking_result_fn=result,
            update_progress_job_cache_fn=Mock(),
            update_terminal_job_cache_fn=Mock(),
            map_status=lambda x: x,
            result_key_prefix="",
            result_expire_seconds=1,
        )

    asyncio.run(scenario())
    state.executor.shutdown()
    assert (
        events == ["unload", "load:/voice", "scale", "generate", "unload"]
        and store.get("job").status == "succeeded"
    )


def test_reinitialize_uses_same_executor_as_generation(separation):
    f = separation
    path = OVERLAY / "acestep/api/http/reinitialize_route.py"
    spec = importlib.util.spec_from_file_location("tested_reinitialize", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    handler = Mock()
    handler.model = None
    handler.vae = None
    handler.text_encoder = None
    handler.last_init_params = {
        "project_root": "/project",
        "config_path": "model",
        "device": "cuda",
        "use_flash_attention": False,
        "compile_model": False,
        "offload_to_cpu": False,
        "offload_dit_to_cpu": False,
    }
    active = 0
    maximum = 0
    lock = threading.Lock()
    started = threading.Event()

    def call():
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        started.set()
        time.sleep(0.03)
        with lock:
            active -= 1

    def initialize(**kwargs):
        call()
        return "ok", True

    handler.initialize_service.side_effect = initialize
    f.app.state.handler = handler
    f.app.state.llm_handler = None
    module.register_reinitialize_route(
        f.app,
        lambda: None,
        lambda data, **kw: {"data": data, **kw},
        lambda *a: False,
        lambda: "/project",
    )
    from acestep.api.gpu import run_gpu

    with ThreadPoolExecutor(max_workers=2) as pool:
        inference = pool.submit(lambda: asyncio.run(run_gpu(f.app.state, call)))
        started.wait()
        control = pool.submit(lambda: f.client.post("/v1/reinitialize"))
        inference.result()
        assert control.result().status_code == 200
    assert maximum == 1


def test_manifest_preflight_against_pinned_immutable_image(tmp_path):
    """Run explicitly with the already-local image; never load model handlers."""
    if os.getenv("RAWCHUNKS_TEST_IMMUTABLE_WORKER_IMAGE") != "1":
        pytest.skip("immutable image preflight is opt-in after the base image is local")
    import subprocess
    import hashlib

    manifest = json.loads((BASE / "source.json").read_text())
    expected_digest = manifest["imageDigest"]
    image = (
        "us-east1-docker.pkg.dev/gen-lang-client-0035632562/compose/acestep-xl-15@"
        + expected_digest
    )
    script = 'import json,pathlib; root=pathlib.Path("/app/ACE-Step-1.5"); manifest=json.loads(pathlib.Path("/tmp/rawchunks-package/source.json").read_text()); print(json.dumps({p:(root/p).read_text() if (root/p).is_file() else None for p in manifest["files"]}))'
    capture = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--pull",
            "never",
            "--platform",
            "linux/amd64",
            "--entrypoint",
            "python3",
            "--mount",
            f"type=bind,src={BASE},dst=/tmp/rawchunks-package,readonly",
            image,
            "-c",
            script,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    sources = json.loads(capture.stdout)
    stage = tmp_path / "root"
    stage.mkdir()
    for relative, expected_hash in manifest["files"].items():
        content = sources[relative]
        if expected_hash is None:
            assert content is None
            continue
        assert hashlib.sha256(content.encode()).hexdigest() == expected_hash, relative
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    spec = importlib.util.spec_from_file_location("immutable_patch", BASE / "patch.py")
    patch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patch)
    assert patch.install(stage, OVERLAY, BASE / "source.json") == len(manifest["files"])
    assert patch.install(stage, OVERLAY, BASE / "source.json") == 0


def test_job_notifications_follow_durable_state(durable):
    store, q = durable
    q.admit({}, job_id="notice")
    with store.client.pubsub() as subscription:
        subscription.subscribe(store.key("events:notice"))
        subscription.get_message(timeout=1)
        store.mark_running("notice")
        event = subscription.get_message(timeout=1)
        assert event is not None and event["type"] == "message"
        assert store.get("notice").status == "running"
        store.mark_succeeded("notice", {"audio_paths": ["result.wav"]})
        event = subscription.get_message(timeout=1)
        assert event is not None and event["type"] == "message"
        assert store.get("notice").result["audio_paths"] == ["result.wav"]
        store.mark_succeeded("notice", {"audio_paths": ["replacement.wav"]})
        assert subscription.get_message(timeout=.05) is None
    assert store.get("notice").result["audio_paths"] == ["result.wav"]


def test_stale_executor_cannot_publish_completion(durable):
    from acestep.api.jobs.durable import LeaseLost
    store, q = durable
    q.admit({}, job_id="stale-notice")
    assert q.acquire()
    q.claim()
    with store.client.pubsub() as subscription:
        subscription.subscribe(store.key("events:stale-notice"))
        subscription.get_message(timeout=1)
        store.client.delete(q.keys[4])
        with pytest.raises(LeaseLost):
            store.mark_succeeded("stale-notice", {})
        assert subscription.get_message(timeout=.05) is None
        assert store.get("stale-notice").status != "succeeded"


def test_multi_executor_concurrency_and_selective_orphan_recovery(durable):
    from acestep.api.jobs.durable import DurableQueue
    from acestep.api.jobs.store import _JobStore
    base_store, _ = durable
    s1 = _JobStore(client=base_store.client, namespace="rawchunks:multi")
    s2 = _JobStore(client=base_store.client, namespace="rawchunks:multi")
    s3 = _JobStore(client=base_store.client, namespace="rawchunks:multi")
    q1 = DurableQueue(s1, maxsize=10, max_executors=2)
    q2 = DurableQueue(s2, maxsize=10, max_executors=2)
    q3 = DurableQueue(s3, maxsize=10, max_executors=2)
    assert q1.acquire()
    assert q2.acquire()
    assert not q3.acquire()
    q1.admit({"prompt": "one"}, job_id="job-1")
    q1.admit({"prompt": "two"}, job_id="job-2")
    c1 = q1.claim()
    c2 = q2.claim()
    assert c1 is not None and c1[0] == "job-1"
    assert c2 is not None and c2[0] == "job-2"
    s1.mark_running("job-1")
    s2.mark_running("job-2")
    # Simulate worker 2 crashing (its lease expires), while worker 1 stays alive
    s2.client.delete(q2._owner_lease_key)
    q1.renew()
    # job-2 is recovered back to queued while job-1 stays running on worker 1
    assert s1.get("job-1").status == "running"
    assert s1.get("job-2").status == "queued"
    s1.mark_succeeded("job-1", {"ok": True})
    q1.ack("job-1")
    reclaimed = q1.claim()
    assert reclaimed is not None and reclaimed[0] == "job-2"
    s1.mark_succeeded("job-2", {"ok": True})
    q1.ack("job-2")
    assert s1.get_stats() == {"total": 2, "queued": 0, "running": 0, "succeeded": 2, "failed": 0}


def test_hot_lora_cache_reuses_loaded_adapter():
    from types import SimpleNamespace
    from acestep.api.gpu import apply_job_lora
    events = []
    handler = SimpleNamespace(
        _lora_hot_cache_enabled=True,
        _hot_cached_lora_path=None,
        _rawchunks_manual_lora={},
        lora_loaded=False,
        model=object(),
    )
    def unload_lora():
        events.append("unload")
        handler.lora_loaded = False
        return "✅ unloaded"
    def load_lora(path):
        events.append(f"load:{path}")
        handler.lora_loaded = True
        return "✅ loaded"
    def set_lora_scale(scale):
        events.append(f"scale:{scale}")
        return "✅ scaled"
    def set_use_lora(enabled):
        events.append(f"use:{enabled}")
        return "✅ toggled"
    handler.unload_lora = unload_lora
    handler.load_lora = load_lora
    handler.set_lora_scale = set_lora_scale
    handler.set_use_lora = set_use_lora

    # First job with /voice-a loads from disk
    restore1 = apply_job_lora(handler, SimpleNamespace(lora_path="/voice-a", lora_alpha=0.8))
    restore1()
    # Second job with same /voice-a reuses hot adapter without unload/load!
    restore2 = apply_job_lora(handler, SimpleNamespace(lora_path="/voice-a", lora_alpha=0.9))
    restore2()
    # Third job with no LoRA simply ensures use_lora(False)
    restore3 = apply_job_lora(handler, SimpleNamespace(lora_path=None))
    restore3()
    assert events == [
        "load:/voice-a", "scale:0.8", "use:True", "use:False",
        "scale:0.9", "use:True", "use:False",
        "use:False",
    ]

