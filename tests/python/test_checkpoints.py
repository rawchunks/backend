import importlib.util
import json
import os
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest

OVERLAY = Path(__file__).resolve().parents[2] / "worker/overlay/acestep/api"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def dependencies(monkeypatch):
    downloader = types.ModuleType("acestep.model_downloader")
    downloader.MAIN_MODEL_COMPONENTS = ["vae"]
    downloader.MAIN_MODEL_REPO = "ACE-Step/Ace-Step1.5"
    downloader.SUBMODEL_REGISTRY = {
        "acestep-v15-xl-turbo": "ACE-Step/acestep-v15-xl-turbo",
        "acestep-v15-xl-base": "ACE-Step/acestep-v15-xl-base",
    }
    downloader.get_checkpoints_dir = lambda: Path(os.environ["ACESTEP_CHECKPOINTS_DIR"])
    monkeypatch.setitem(sys.modules, downloader.__name__, downloader)
    gpu = types.ModuleType("acestep.gpu_config")
    gpu.VRAM_AUTO_OFFLOAD_THRESHOLD_GB = 16
    gpu.get_gpu_config = lambda: types.SimpleNamespace(gpu_memory_gb=24)
    gpu.resolve_lm_backend = lambda *_: "pt"
    gpu.set_global_gpu_config = lambda _: None
    monkeypatch.setitem(sys.modules, gpu.__name__, gpu)
    llm = types.ModuleType("acestep.api.startup_llm_init")
    llm.initialize_llm_at_startup = Mock()
    monkeypatch.setitem(sys.modules, llm.__name__, llm)
    return downloader, llm


@pytest.fixture
def download(dependencies, monkeypatch):
    hub = types.ModuleType("huggingface_hub")
    hub.snapshot_download = Mock()
    alternate = types.ModuleType("modelscope")
    alternate.snapshot_download = Mock()
    monkeypatch.setitem(sys.modules, hub.__name__, hub)
    monkeypatch.setitem(sys.modules, alternate.__name__, alternate)
    return load("tested_download", OVERLAY / "model_download.py"), hub, alternate


def weights(root, name, sharded=False):
    path = root / name
    path.mkdir(parents=True, exist_ok=True)
    if sharded:
        files = [f"model-{number:05d}-of-00004.safetensors" for number in range(1, 5)]
        for file in files:
            (path / file).write_bytes(b"weights")
        (path / "model.safetensors.index.json").write_text(
            json.dumps({"weight_map": {str(index): file for index, file in enumerate(files)}})
        )
    else:
        (path / "model.safetensors").write_bytes(b"weights")
    return path


@pytest.mark.parametrize("sharded", [False, True])
def test_existing_weights_do_not_download(download, tmp_path, sharded):
    module, hub, alternate = download
    path = weights(tmp_path, "acestep-v15-xl-turbo", sharded)
    assert module.ensure_model_downloaded(path.name, str(tmp_path)) == str(path)
    hub.snapshot_download.assert_not_called()
    alternate.snapshot_download.assert_not_called()


def test_missing_shard_is_rejected_before_download(download, tmp_path):
    module, hub, alternate = download
    path = weights(tmp_path, "acestep-v15-xl-turbo", True)
    (path / "model-00003-of-00004.safetensors").unlink()
    with pytest.raises(RuntimeError, match="Missing checkpoint shard"):
        module.ensure_model_downloaded(path.name, str(tmp_path))
    hub.snapshot_download.assert_not_called()
    alternate.snapshot_download.assert_not_called()


@pytest.mark.parametrize("shards", [{}, {"weight": "../outside"}, {"weight": "/absolute"}])
def test_invalid_shard_index_is_rejected(download, tmp_path, shards):
    module, hub, _ = download
    path = tmp_path / "acestep-v15-xl-turbo"
    path.mkdir()
    (path / "model.safetensors.index.json").write_text(json.dumps({"weight_map": shards}))
    with pytest.raises(RuntimeError):
        module.ensure_model_downloaded(path.name, str(tmp_path))
    hub.snapshot_download.assert_not_called()


def test_unknown_model_cannot_download_the_default_model(download, tmp_path):
    module, hub, alternate = download
    with pytest.raises(ValueError, match="Unknown checkpoint"):
        module.ensure_model_downloaded("unknown", str(tmp_path))
    hub.snapshot_download.assert_not_called()
    alternate.snapshot_download.assert_not_called()


def test_component_download_does_not_fetch_unrelated_weights(download, tmp_path, monkeypatch):
    module, hub, _ = download
    monkeypatch.setenv("ACESTEP_DOWNLOAD_SOURCE", "huggingface")
    hub.snapshot_download.side_effect = lambda **_: weights(tmp_path, "vae")
    module.ensure_model_downloaded("vae", str(tmp_path))
    hub.snapshot_download.assert_called_once_with(
        repo_id="ACE-Step/Ace-Step1.5", local_dir=str(tmp_path), allow_patterns=["vae/*"]
    )


@pytest.mark.parametrize("source", ["huggingface", "modelscope"])
def test_requested_xl_uses_its_exact_registry_entry(download, tmp_path, monkeypatch, source):
    module, hub, alternate = download
    monkeypatch.setenv("ACESTEP_DOWNLOAD_SOURCE", source)
    chosen = hub.snapshot_download if source == "huggingface" else alternate.snapshot_download
    chosen.side_effect = lambda **_: weights(tmp_path, "acestep-v15-xl-base", True)
    module.ensure_model_downloaded("acestep-v15-xl-base", str(tmp_path))
    args = chosen.call_args.kwargs
    assert args.get("repo_id", args.get("model_id")) == "ACE-Step/acestep-v15-xl-base"
    assert args["local_dir"] == str(tmp_path / "acestep-v15-xl-base")
    assert args["allow_patterns"] is None
    (alternate.snapshot_download if source == "huggingface" else hub.snapshot_download).assert_not_called()


def test_download_failure_does_not_switch_sources(download, tmp_path, monkeypatch):
    module, hub, alternate = download
    monkeypatch.setenv("ACESTEP_DOWNLOAD_SOURCE", "huggingface")
    hub.snapshot_download.side_effect = OSError("registry unavailable")
    with pytest.raises(OSError, match="registry unavailable"):
        module.ensure_model_downloaded("acestep-v15-xl-base", str(tmp_path))
    alternate.snapshot_download.assert_not_called()


def test_metadata_without_weights_is_not_a_complete_checkpoint(download, tmp_path):
    module, hub, _ = download
    path = tmp_path / "acestep-v15-xl-base"
    path.mkdir()
    (path / "config.json").write_text("{}")
    with pytest.raises(RuntimeError, match="no weights"):
        module.ensure_model_downloaded(path.name, str(tmp_path))
    hub.snapshot_download.assert_not_called()


def test_startup_uses_persistent_root_for_downloads_and_lm(dependencies, tmp_path, monkeypatch):
    _, llm = dependencies
    monkeypatch.setenv("ACESTEP_CHECKPOINTS_DIR", str(tmp_path))
    monkeypatch.setenv("ACESTEP_CONFIG_PATH", "acestep-v15-xl-turbo")
    module = load("tested_startup", OVERLAY / "startup_model_init.py")
    handler, downloaded = Mock(), Mock()
    handler.initialize_service.return_value = ("loaded", True)
    app = types.SimpleNamespace(state=types.SimpleNamespace(gpu_config=types.SimpleNamespace(gpu_memory_gb=24)))
    module.do_model_initialization(
        app=app, handler=handler, llm_handler=None, handler2=None, handler3=None,
        config_path2="", config_path3="", get_project_root=lambda: "/image",
        get_model_name=lambda name: name, ensure_model_downloaded=downloaded,
        env_bool=lambda _, default: default,
    )
    assert downloaded.call_args_list[0].args == ("acestep-v15-xl-turbo", str(tmp_path))
    assert downloaded.call_args_list[1].args == ("vae", str(tmp_path))
    assert app.state._checkpoint_dir == str(tmp_path)
    assert llm.initialize_llm_at_startup.call_args.kwargs["checkpoint_dir"] == str(tmp_path)
    assert handler.initialize_service.call_args.kwargs["config_path"] == "acestep-v15-xl-turbo"


def test_startup_download_failure_stops_handler_initialization(dependencies, tmp_path, monkeypatch):
    monkeypatch.setenv("ACESTEP_CHECKPOINTS_DIR", str(tmp_path))
    module = load("tested_startup_failure", OVERLAY / "startup_model_init.py")
    handler = Mock()
    app = types.SimpleNamespace(state=types.SimpleNamespace(gpu_config=types.SimpleNamespace(gpu_memory_gb=24)))
    with pytest.raises(OSError, match="missing"):
        module.do_model_initialization(
            app=app, handler=handler, llm_handler=None, handler2=None, handler3=None,
            config_path2="", config_path3="", get_project_root=lambda: "/image",
            get_model_name=lambda name: name, ensure_model_downloaded=Mock(side_effect=OSError("missing")),
            env_bool=lambda _, default: default,
        )
    handler.initialize_service.assert_not_called()


def test_model_switch_uses_persistent_root_for_dit_and_lm(dependencies, tmp_path, monkeypatch):
    monkeypatch.setenv("ACESTEP_CHECKPOINTS_DIR", str(tmp_path))
    module = load("tested_model_init", OVERLAY / "http/model_init_service.py")
    handler, llm, downloaded = Mock(), Mock(), Mock()
    handler.initialize_service.return_value = ("loaded", True)
    llm.initialize.return_value = ("loaded", True)
    import threading
    state = types.SimpleNamespace(
        handler=handler, llm_handler=llm, _config_path="acestep-v15-xl-turbo",
        _llm_init_lock=threading.Lock(),
    )
    result = module.initialize_models_for_request(
        state, "acestep-v15-xl-base", True, "acestep-5Hz-lm-0.6B",
        lambda: "/image", lambda name: name, downloaded, lambda _, default: default,
    )
    assert all(call.args[1] == str(tmp_path) for call in downloaded.call_args_list)
    assert llm.initialize.call_args.kwargs["checkpoint_dir"] == str(tmp_path)
    assert handler.initialize_service.call_args.kwargs["config_path"] == "acestep-v15-xl-base"
    assert result["loaded_model"] == "acestep-v15-xl-base"
    assert state._config_path == "acestep-v15-xl-base"


def test_successful_transport_without_weights_is_rejected(download, tmp_path):
    module, hub, _ = download
    with pytest.raises(RuntimeError, match="Downloaded checkpoint has no weights"):
        module.ensure_model_downloaded("acestep-v15-xl-base", str(tmp_path))
    hub.snapshot_download.assert_called_once()


def test_unknown_download_source_is_rejected(download, tmp_path, monkeypatch):
    module, hub, alternate = download
    monkeypatch.setenv("ACESTEP_DOWNLOAD_SOURCE", "unknown")
    with pytest.raises(ValueError, match="Unknown checkpoint download source"):
        module.ensure_model_downloaded("acestep-v15-xl-base", str(tmp_path))
    hub.snapshot_download.assert_not_called()
    alternate.snapshot_download.assert_not_called()
