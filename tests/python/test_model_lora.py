"""Execute packaged model and LoRA controls without model weights."""

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

FIXTURES = Path(__file__).resolve().parents[2] / "worker/overlay/acestep/api"


def load(name, file):
    source = (
        FIXTURES / file
        if file == "job_model_selection.py"
        else FIXTURES / "http" / file
    )
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def lora(monkeypatch):
    handler_module = types.ModuleType("acestep.handler")
    handler_module.AceStepHandler = object
    constants = types.ModuleType("acestep.constants")
    constants.DEFAULT_DIT_INSTRUCTION = "test instruction"
    from concurrent.futures import ThreadPoolExecutor

    package = types.ModuleType("acestep")
    package.__path__ = [str(FIXTURES.parent)]
    monkeypatch.setitem(sys.modules, "acestep", package)
    for package_name, path in [
        ("acestep.api", FIXTURES),
        ("acestep.api.jobs", FIXTURES / "jobs"),
    ]:
        package = types.ModuleType(package_name)
        package.__path__ = [str(path)]
        monkeypatch.setitem(sys.modules, package_name, package)
    monkeypatch.setitem(sys.modules, "acestep.handler", handler_module)
    monkeypatch.setitem(sys.modules, "acestep.constants", constants)
    module = load("tested_lora", "lora_routes.py")
    app = FastAPI()
    handler = Mock()
    handler.model = object()
    app.state.handler = handler
    app.state.executor = ThreadPoolExecutor(max_workers=1)
    handler._rawchunks_manual_lora = {}
    for name in [
        "add_lora",
        "load_lora",
        "unload_lora",
        "set_use_lora",
        "set_lora_scale",
    ]:
        getattr(handler, name).return_value = "✅ complete"
    handler.get_lora_status.return_value = {
        "loaded": True,
        "active": True,
        "scale": 0.4,
        "adapters": ["voice"],
        "active_adapter": "voice",
    }
    handler._adapter_type = "lora"
    handler.lora_loaded = False
    handler.use_lora = False
    handler.lora_scale = 1.0

    async def verify(request: Request):
        if request.headers.get("authorization") != "Bearer test-key":
            raise HTTPException(401, "Unauthorized")

    module.register_lora_routes(app, verify, lambda data, **kw: {"data": data, **kw})
    yield types.SimpleNamespace(
        module=module,
        handler=handler,
        app=app,
        client=TestClient(app, raise_server_exceptions=False),
        headers={"Authorization": "Bearer test-key"},
    )
    app.state.executor.shutdown()


@pytest.mark.parametrize(
    "path,payload,call,args",
    [
        ("load", {"lora_path": "/adapters/voice"}, "load_lora", ("/adapters/voice",)),
        (
            "load",
            {"lora_path": "/adapters/voice", "adapter_name": " voice "},
            "add_lora",
            ("/adapters/voice",),
        ),
        ("unload", {}, "unload_lora", ()),
        ("toggle", {"use_lora": False}, "set_use_lora", (False,)),
        ("scale", {"scale": 0.5}, "set_lora_scale", (0.5,)),
        (
            "scale",
            {"scale": 0.5, "adapter_name": " voice "},
            "set_lora_scale",
            ("voice", 0.5),
        ),
    ],
)
def test_lora_lifecycle_routes(lora, path, payload, call, args):
    r = lora.client.post("/v1/lora/" + path, json=payload, headers=lora.headers)
    assert r.status_code == 200
    assert getattr(lora.handler, call).call_args.args == args
    if path == "load" and "adapter_name" in payload:
        assert lora.handler.add_lora.call_args.kwargs == {"adapter_name": "voice"}


@pytest.mark.parametrize("scale", [-0.1, 1.1, "invalid", None])
def test_lora_invalid_scale(lora, scale):
    assert (
        lora.client.post(
            "/v1/lora/scale", json={"scale": scale}, headers=lora.headers
        ).status_code
        == 422
    )
    lora.handler.set_lora_scale.assert_not_called()


def test_lora_auth_and_status(lora):
    assert lora.client.get("/v1/lora/status").status_code == 401
    data = lora.client.get("/v1/lora/status", headers=lora.headers).json()["data"]
    assert data["lora_loaded"] and data["use_lora"]
    assert data["lora_scale"] == 0.4
    assert data["adapters"] == ["voice"]


@pytest.mark.parametrize(
    "message,status", [("❌ bad path", 400), ("⚠️ not found", 400), ("✅ loaded", 200)]
)
def test_load_result_errors_are_http_failures(lora, message, status):
    lora.handler.load_lora.return_value = message
    assert (
        lora.client.post(
            "/v1/lora/load", json={"lora_path": "voice"}, headers=lora.headers
        ).status_code
        == status
    )


def test_lora_uninitialized_handler_is_rejected(lora):
    lora.app.state.handler = None
    assert lora.client.get("/v1/lora/status", headers=lora.headers).status_code == 500


@pytest.mark.parametrize(
    "path,payload,call",
    [
        ("toggle", {"use_lora": True}, "set_use_lora"),
        ("scale", {"scale": 0.4}, "set_lora_scale"),
    ],
)
def test_lora_control_errors_are_not_http_200(lora, path, payload, call):
    getattr(lora.handler, call).return_value = "❌ adapter unavailable"
    assert (
        lora.client.post(
            "/v1/lora/" + path, json=payload, headers=lora.headers
        ).status_code
        == 400
    )


def test_generation_request_preserves_per_job_lora_selection(lora):
    schema = load("tested_release", "release_task_models.py")
    request = schema.GenerateMusicRequest(
        model="acestep-v15-xl-base", lora_path="/adapters/voice", lora_alpha=0.7
    )
    data = request.model_dump()
    assert data.get("lora_path") == "/adapters/voice"
    assert data.get("lora_alpha") == 0.7


@pytest.fixture
def selection():
    module = load("tested_selection", "job_model_selection.py")
    primary = Mock()
    primary.initialize_service.return_value = ("ok", True)
    state = types.SimpleNamespace(
        handler=primary,
        handler2=None,
        handler3=None,
        _config_path="acestep-v15-xl-turbo",
        _service_init_kwargs={},
        _checkpoint_dir="/checkpoints",
        _ensure_model_downloaded=Mock(),
    )
    return module, state


def select(module, state, model):
    return module.select_generation_handler(
        app_state=state,
        requested_model=model,
        get_model_name=lambda x: x,
        job_id="job",
        log_fn=lambda _: None,
    )


@pytest.mark.parametrize("model", [None, "acestep-v15-xl-turbo"])
def test_current_model_does_not_reload(selection, model):
    module, state = selection
    assert select(module, state, model) == (state.handler, "acestep-v15-xl-turbo")
    state.handler.initialize_service.assert_not_called()


@pytest.mark.parametrize("slot", [2, 3])
def test_secondary_model_routing(selection, slot):
    module, state = selection
    secondary = Mock()
    setattr(state, f"handler{slot}", secondary)
    setattr(state, f"_initialized{slot}", True)
    setattr(state, f"_config_path{slot}", "acestep-v15-xl-base")
    assert select(module, state, "acestep-v15-xl-base") == (
        secondary,
        "acestep-v15-xl-base",
    )


def test_alternating_resident_models_never_reload(selection, monkeypatch):
    module, state = selection
    monkeypatch.setenv("ACESTEP_ON_DEMAND_MODEL_LOAD", "false")
    state.handler2 = Mock()
    state.handler3 = Mock()
    state._initialized2 = state._initialized3 = True
    state._config_path2 = "acestep-v15-xl-sft"
    state._config_path3 = "acestep-v15-xl-base"
    models = [state._config_path, state._config_path2, state._config_path3]
    handlers = [state.handler, state.handler2, state.handler3]
    for index in [0, 1, 2, 0, 2, 1]:
        assert select(module, state, models[index]) == (handlers[index], models[index])
    for handler in handlers:
        handler.initialize_service.assert_not_called()
    state._ensure_model_downloaded.assert_not_called()
    assert state._config_path == models[0]


def test_unavailable_resident_slot_fails_without_replacing_primary(selection, monkeypatch):
    module, state = selection
    monkeypatch.setenv("ACESTEP_ON_DEMAND_MODEL_LOAD", "false")
    state.handler2 = Mock()
    state._initialized2 = False
    state._config_path2 = "acestep-v15-xl-sft"
    with pytest.raises(ValueError, match="unavailable"):
        select(module, state, state._config_path2)
    state.handler.initialize_service.assert_not_called()
    state._ensure_model_downloaded.assert_not_called()


def test_on_demand_switch_reuses_single_handler(selection, monkeypatch):
    module, state = selection
    monkeypatch.setenv("ACESTEP_ON_DEMAND_MODEL_LOAD", "true")
    monkeypatch.setenv("ACESTEP_QUEUE_WORKERS", "1")
    monkeypatch.setenv("ACESTEP_API_WORKERS", "1")
    assert select(module, state, "acestep-v15-xl-base") == (
        state.handler,
        "acestep-v15-xl-base",
    )
    state._ensure_model_downloaded.assert_called_once_with(
        "acestep-v15-xl-base", "/checkpoints"
    )
    assert state._config_path == "acestep-v15-xl-base"


@pytest.mark.parametrize("value", ["2", "garbage"])
def test_on_demand_disabled_with_multiple_or_invalid_workers(
    selection, monkeypatch, value
):
    module, state = selection
    monkeypatch.setenv("ACESTEP_ON_DEMAND_MODEL_LOAD", "true")
    monkeypatch.setenv("ACESTEP_QUEUE_WORKERS", value)
    assert not module._on_demand_load_enabled()


def test_failed_model_load_clears_poisoned_config(selection, monkeypatch):
    module, state = selection
    monkeypatch.setenv("ACESTEP_ON_DEMAND_MODEL_LOAD", "true")
    state.handler.initialize_service.return_value = ("failed", False)
    with pytest.raises(RuntimeError):
        select(module, state, "acestep-v15-xl-base")
    assert state._config_path == ""


def test_failed_fetch_cooldown_prevents_repeated_download(selection):
    module, state = selection
    state._ensure_model_downloaded.side_effect = OSError("provider down")
    with pytest.raises(OSError):
        module._prepare_on_demand_model(state, "acestep-v15-xl-base")
    with pytest.raises(RuntimeError, match="retry blocked"):
        module._prepare_on_demand_model(state, "acestep-v15-xl-base")
    assert state._ensure_model_downloaded.call_count == 1


def test_unknown_model_fails_closed_instead_of_generating_wrong_model(
    selection, monkeypatch
):
    module, state = selection
    monkeypatch.setenv("ACESTEP_ON_DEMAND_MODEL_LOAD", "true")
    with pytest.raises(ValueError):
        select(module, state, "unknown-model")


def test_failed_model_fetch_does_not_silently_use_turbo(selection, monkeypatch):
    module, state = selection
    monkeypatch.setenv("ACESTEP_ON_DEMAND_MODEL_LOAD", "true")
    state._ensure_model_downloaded.side_effect = OSError("checkpoint unavailable")
    with pytest.raises(OSError):
        select(module, state, "acestep-v15-xl-base")

def test_explicit_adapter_controls_target_the_selected_resident_model(lora):
    secondary = Mock()
    secondary.model = object()
    secondary._rawchunks_manual_lora = {}
    secondary._adapter_type = 'lora'
    secondary.unload_lora.return_value = '✅ unloaded'
    secondary.set_use_lora.return_value = '✅ toggled'
    secondary.set_lora_scale.return_value = '✅ scaled'
    secondary.get_lora_status.return_value = {'loaded':True,'active':True,'scale':.5,'adapters':['sft']}
    lora.app.state.handler2=secondary
    lora.app.state._config_path='acestep-v15-xl-turbo'
    lora.app.state._config_path2='acestep-v15-xl-sft'
    with lora.client as client:
        assert client.get('/v1/lora/status?model=acestep-v15-xl-sft',headers=lora.headers).json()['data']['adapters']==['sft']
        assert client.post('/v1/lora/toggle',json={'model':'acestep-v15-xl-sft','use_lora':False},headers=lora.headers).status_code==200
        assert client.post('/v1/lora/scale',json={'model':'acestep-v15-xl-sft','scale':.4},headers=lora.headers).status_code==200
        assert client.post('/v1/lora/unload?model=acestep-v15-xl-sft',headers=lora.headers).status_code==200
    secondary.unload_lora.assert_called_once()
    lora.handler.unload_lora.assert_not_called()
