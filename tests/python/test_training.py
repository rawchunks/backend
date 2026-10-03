"""Exercise durable training control flow and artifact validation without a GPU."""
import asyncio
import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

OVERLAY = Path(__file__).resolve().parents[2] / "worker/overlay/acestep"


@pytest.fixture
def training(monkeypatch):
    for name, path in [("acestep", OVERLAY), ("acestep.api", OVERLAY/"api"),
            ("acestep.api.jobs", OVERLAY/"api/jobs"), ("acestep.api.http", OVERLAY/"api/http")]:
        package = types.ModuleType(name)
        package.__path__ = [str(path)]
        monkeypatch.setitem(sys.modules, name, package)
    for name in ("acestep.api.training", "acestep.api.jobs.durable", "acestep.api.gpu", "acestep.api.http.query_result_service"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    return importlib.import_module("acestep.api.training")


def state(tmp_path):
    return types.SimpleNamespace(training_artifact_root=str(tmp_path), role="training", training_checkpoints={
        model: {"fingerprint": "a"*64, "timetable": {"timestep_mu": -.4,"timestep_sigma": 1.,"data_proportion": .5}}
        for model in ("acestep-v15-xl-turbo", "acestep-v15-xl-sft")})


@pytest.mark.parametrize("model", ["acestep-v15-xl-turbo", "acestep-v15-xl-sft"])
def test_options_publish_defaults_and_exact_timetable(training, tmp_path, model):
    options = training.training_options(state(tmp_path))
    selected = next(item for item in options["models"] if item["model"] == model)
    assert selected["checkpoint_fingerprint"] == "a"*64
    config = selected["training_config"]
    assert (config["lora_rank"], config["lora_alpha"], config["train_epochs"], config["learning_rate"],config["gradient_accumulation"]) == (64,128,10,1e-4,4)
    assert config["gradient_checkpointing"] is True
    assert config["timestep_mu"] == -.4


@pytest.mark.parametrize("body", [{}, {"source_audio_url":"https://audio/file", "tensor_dir":"/tensors"},
    {"source_audio_url":"file:///etc/file"}, {"tensor_dir":"/tensors", "training_config":{"learning_rate":float("nan")}},
    {"tensor_dir":"/tensors", "training_config":{"gradient_checkpointing":False}},
    {"tensor_dir":"/tensors", "model":"acestep-v15-turbo"}])
def test_invalid_training_input_fails_closed(training,tmp_path,body):
    with pytest.raises(ValueError):
        training.prepare_training_request(state(tmp_path),body)


def test_timetable_and_fingerprint_are_locked(training,tmp_path):
    with pytest.raises(ValueError,match="timetable"):
        training.prepare_training_request(state(tmp_path),{"tensor_dir":"/tensors","training_config":{"timestep_mu":3}})
    with pytest.raises(ValueError,match="fingerprint"):
        training.prepare_training_request(state(tmp_path),{"tensor_dir":"/tensors","checkpoint_fingerprint":"b"*64})


def test_explicit_lyrics_and_vocal_state_survive_labeling(training):
    lyrics = "[Verse]\nKeep every bracket\n[Chorus]\nAnd every line"
    result = training._merge_metadata({"raw_lyrics":lyrics,"lyrics":lyrics,"is_instrumental":False,"caption":"Original","bpm":95},
        {"lyrics":"Wrong", "caption":"Changed", "bpm":110,"keyscale":"C major","is_instrumental":True})
    assert (result["lyrics"],result["raw_lyrics"],result["is_instrumental"],result["caption"],result["bpm"]) == (lyrics,lyrics,False,"Original",95)
    assert result["keyscale"] == "C major"


def test_instrumental_marker_cannot_complete_missing_vocal_transcription(training):
    with pytest.raises(RuntimeError,match=r"Vocal sample labeling returned only \[Instrumental\]"):
        training._merge_metadata({"is_instrumental":False},{"lyrics":"  [Instrumental]\n","is_instrumental":True})
    assert training._merge_metadata({"is_instrumental":True},{"lyrics":"[Instrumental]"})["lyrics"] == "[Instrumental]"
    # Supplied lyric bytes remain authoritative even when the LM contradicts them.
    supplied="[Verse]\n[Instrumental]\nKeep this literal line"
    assert training._merge_metadata({"is_instrumental":False,"raw_lyrics":supplied},{"lyrics":"[Instrumental]"})["lyrics"] == supplied
    assert training._merge_metadata({"is_instrumental":False},{"lyrics":"[Verse]\nActual words"})["lyrics"] == "[Verse]\nActual words"


def test_dataset_sample_does_not_invent_an_instrumental_lyric_default():
    import importlib.util
    name="tested_training_sample_models"
    spec=importlib.util.spec_from_file_location(name,OVERLAY/"training/dataset_builder_modules/models.py")
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module
    try:
        spec.loader.exec_module(module)
        assert module.AudioSample(is_instrumental=False).lyrics == ""
        supplied="[Verse]\nEvery bracket and line"
        sample=module.AudioSample.from_dict({"is_instrumental":False,"lyrics":supplied,"raw_lyrics":supplied})
        assert (sample.lyrics,sample.raw_lyrics,sample.is_instrumental) == (supplied,supplied,False)
    finally:
        sys.modules.pop(name,None)


def update(kind,step=1,loss=.3,msg="message"):
    return types.SimpleNamespace(kind=kind,step=step,loss=loss,msg=msg,steps_per_epoch=1)


@pytest.mark.parametrize("updates,pattern", [([update("fail")],"message"),([update("complete",step=0)],"positive"),
    ([update("complete",loss=float("nan"))],"nonfinite"),([update("step")],"did not complete"),
    ([update("step",step=2),update("complete",step=1)],"regressed")])
def test_trainer_failure_cannot_publish(training,updates,pattern):
    trainer = types.SimpleNamespace(train=lambda **_: iter(updates), training_config=types.SimpleNamespace(max_epochs=1))
    store = Mock();store.client.hget.return_value=None
    with pytest.raises(RuntimeError,match=pattern):
        training.consume_updates(trainer,{"should_stop":False},store,"job")


def test_cancellation_cannot_be_mistaken_for_completion(training):
    trainer = types.SimpleNamespace(train=lambda **_: iter([update("complete")]), training_config=types.SimpleNamespace(max_epochs=1))
    store = Mock();store.client.hget.return_value="1"
    with pytest.raises(RuntimeError,match="cancelled"):
        training.consume_updates(trainer,{"should_stop":False},store,"job")


def test_positive_finite_optimizer_steps_record_metrics(training):
    trainer = types.SimpleNamespace(train=lambda **_: iter([update("step"),update("complete")]), training_config=types.SimpleNamespace(max_epochs=1))
    store=Mock();store.client.hget.return_value=None
    assert training.consume_updates(trainer,{"should_stop":False},store,"job") == (1,.3)
    assert store._update.call_args.args[1]["total_steps"] == 1


def test_train_start_idempotency_and_query_artifact_contract(training,tmp_path):
    app=FastAPI();app.state.training_checkpoints=state(tmp_path).training_checkpoints
    app.state.training_artifact_root=str(tmp_path)
    queue=Mock();queue.admit.return_value=(types.SimpleNamespace(job_id="same-task"),1)
    app.state.job_queue=queue;store=Mock();app.state.job_store=store
    record=types.SimpleNamespace(job_id="same-task",status="succeeded",result={"artifact":{"manifest":"manifest.json"}},
        created_at=1,progress=1,stage="succeeded",step=5,total_steps=5,loss=.1,error=None,progress_text="")
    store.get.return_value=record
    training.register_training_routes(app,lambda:None,lambda data,**_: {"data":data})
    with TestClient(app) as client:
        response=client.post("/v1/training/start",json={"model":"acestep-v15-xl-turbo","source_audio_url":"https://audio.example/source.wav"},headers={"Idempotency-Key":"same-task"})
        assert response.status_code == 200
        assert response.json()["data"]["task_id"] == "same-task"
        assert queue.admit.call_args.kwargs["job_id"] == "same-task"
        assert queue.admit.call_args.kwargs["kind"] == "training"
        result=client.post("/v1/training/query_result",json={"task_id_list":["same-task"]}).json()["data"][0]
        assert result["artifact"]["manifest"] == "manifest.json"
        assert (result["stage"],result["step"],result["loss"]) == ("succeeded",5,.1)
        assert client.post("/v1/training/export",json={"lora_output_dir":"/older"}).status_code == 400
        assert client.get("/v1/training/artifact/same-task/unknown.pt").status_code == 404


def test_missing_tensor_input_is_an_explicit_admission_error(training,tmp_path):
    app=FastAPI();app.state.training_checkpoints=state(tmp_path).training_checkpoints
    app.state.training_artifact_root=str(tmp_path);app.state.job_queue=Mock();app.state.job_store=Mock()
    training.register_training_routes(app,lambda:None,lambda data,**_: {"data":data})
    with TestClient(app) as client:
        response=client.post("/v1/training/start",json={"model":"acestep-v15-xl-turbo","tensor_dir":str(tmp_path/"missing")})
    assert response.status_code == 400
    assert response.json()["detail"] == "Tensor input directory is unavailable"
    app.state.job_queue.admit.assert_not_called()


def test_artifact_serves_only_exact_validated_files(training,tmp_path):
    output=tmp_path/"job"/"artifact";output.mkdir(parents=True)
    for name in ("adapter_config.json","adapter_model.safetensors"):(output/name).write_bytes(b"data")
    request={"model":"acestep-v15-xl-turbo","checkpoint_fingerprint":"a"*64,"training_config":{}}
    artifact=training._make_artifact(state(tmp_path),"job",request,output,{"optimizer_steps":1,"final_loss":.1,"effective_update_norm":.5})
    record=types.SimpleNamespace(job_id="job",status="succeeded",stage="succeeded",progress=1,error=None,result={"artifact":artifact})
    app=FastAPI();app.state.training_artifact_root=str(tmp_path);app.state.job_store=Mock();app.state.job_store.get.return_value=record
    training.register_training_routes(app,lambda:None,lambda data,**_: {"data":data})
    with TestClient(app) as client:
        assert client.get("/v1/training/artifact/job/manifest.json").status_code == 200
        (output/"adapter_model.safetensors").write_bytes(b"tampered")
        assert client.get("/v1/training/artifact/job/adapter_model.safetensors").status_code == 409


def test_generation_forwarding_has_no_local_fallback(training,monkeypatch):
    monkeypatch.setenv("ACESTEP_ROLE","generation");monkeypatch.delenv("ACESTEP_TRAINING_URL",raising=False)
    app=FastAPI();called=Mock()
    training.register_role_middleware(app)
    @app.post("/v1/training/start")
    async def local(): called();return {}
    with TestClient(app) as client:
        assert client.post("/v1/training/start",json={}).status_code == 503
    called.assert_not_called()


def test_training_role_blocks_generation_entrypoints(training,monkeypatch):
    monkeypatch.setenv("ACESTEP_ROLE","training")
    app=FastAPI();training.register_role_middleware(app)
    @app.post("/release_task")
    async def generate():return {}
    with TestClient(app) as client:
        assert client.post("/release_task",json={}).status_code == 409


def test_state_initializes_dataset_attributes(training,monkeypatch):
    monkeypatch.delitem(sys.modules,"acestep.api.train_api_models",raising=False)
    module=importlib.import_module("acestep.api.train_api_models")
    app=FastAPI();module.initialize_training_state(app)
    assert app.state.dataset_builder is None and app.state.dataset_json_path is None
    app.state.dataset_builder="existing";module.initialize_training_state(app)
    assert app.state.dataset_builder == "existing"


def test_generation_manifest_pair_validates_before_admission(training,monkeypatch):
    constants=types.ModuleType("acestep.constants");constants.DEFAULT_DIT_INSTRUCTION="instruction"
    monkeypatch.setitem(sys.modules,"acestep.constants",constants)
    monkeypatch.delitem(sys.modules,"acestep.api.http.release_task_models",raising=False)
    cls=importlib.import_module("acestep.api.http.release_task_models").GenerateMusicRequest
    valid=cls(model="acestep-v15-xl-turbo",lora_manifest_url="https://store/manifest.json",lora_manifest_digest="a"*64)
    assert valid.lora_manifest_digest == "a"*64
    for params in ({"lora_manifest_url":"https://store/manifest.json"},{"lora_manifest_digest":"a"*64},
        {"lora_path":"/adapter","lora_manifest_url":"https://store/manifest.json","lora_manifest_digest":"a"*64}):
        with pytest.raises(ValueError):cls(**params)


def test_decode_audio_preserves_full_file_and_refuses_too_long(training,tmp_path,monkeypatch):
    source=tmp_path/"source.m4a";source.write_bytes(b"compressed")
    destination=tmp_path/"decoded.wav"
    calls=[]
    def run(command,**kwargs):
        calls.append(command)
        if command[0] == "ffprobe":return types.SimpleNamespace(stdout=json.dumps({"streams":[{"channels":2,"duration":"12"}]}))
        destination.write_bytes(b"decoded");return types.SimpleNamespace(stdout="")
    monkeypatch.setattr(training.subprocess,"run",run)
    audio=types.ModuleType("soundfile");audio.info=lambda _: types.SimpleNamespace(frames=576000,samplerate=48000)
    monkeypatch.setitem(sys.modules,"soundfile",audio)
    assert training.decode_audio(source,destination) == 12
    command=calls[-1]
    assert "-t" not in command and "-af" not in command and "-ar" not in command
    monkeypatch.setattr(training.subprocess,"run",lambda *_args,**_kwargs:types.SimpleNamespace(stdout=json.dumps({"streams":[{"channels":2,"duration":"241"}]})))
    with pytest.raises(ValueError,match="240"):training.decode_audio(source,destination)


def test_role_startup_reuses_namespace_without_generation_handlers(training,monkeypatch,tmp_path):
    # Runtime constructions are exercised with explicit role and store doubles.
    monkeypatch.setenv("ACESTEP_ROLE","training")
    monkeypatch.delitem(sys.modules,"acestep.api.lifespan_runtime",raising=False)
    module=importlib.import_module("acestep.api.lifespan_runtime")
    handler=Mock();lm=Mock();app=FastAPI();store=Mock()
    runtime=module.initialize_lifespan_runtime(app=app,store=store,queue_maxsize=10,avg_window=4,
        initial_avg_job_seconds=1,get_project_root=lambda:str(tmp_path),initialize_training_state_fn=lambda _:None,
        ace_handler_cls=handler,llm_handler_cls=lm)
    try:
        handler.assert_not_called()
        assert runtime.handler is None and runtime.handler2 is None and runtime.handler3 is None
        assert app.state.role == "training"
    finally:runtime.executor.shutdown()


def test_recovered_audio_job_rebuilds_tensors_and_publishes_labeling_stage(training,monkeypatch,tmp_path):
    current=state(tmp_path)
    store=Mock();store.client.hget.return_value=None
    source=tmp_path/"original.aiff";source.write_bytes(b"original")
    root=tmp_path/"recovered-task";tensors=root/"tensors";tensors.mkdir(parents=True)
    (tensors/"sample-0.pt").write_bytes(b"prior-attempt")
    (tensors/"sample-0.tmp.pt").write_bytes(b"partial-attempt")

    def decode(_source,destination):
        # Recovered optimizer counters belong to the prior attempt and reset.
        fields=store._update.call_args.args[1]
        assert fields["stage"] == "running"
        assert (fields["step"],fields["total_steps"],fields["loss"],fields["progress"]) == (0,0,None,.01)
        destination.write_bytes(b"complete-decoded-audio")
        return 1.5

    def label(_state,samples,_model,_store,_task_id):
        assert store._update.call_args.args[1]["stage"] == "labeling"
        assert store._update.call_args.args[1]["total_steps"] == 1
        return samples

    def preprocess(**kwargs):
        output=Path(kwargs["output_dir"])
        assert not output.exists()
        output.mkdir()
        (output/"sample-0.pt").write_bytes(b"new-attempt")
        return {"processed":1,"failed":0,"total":1}

    async def run(_state,function,*args):
        return function(*args)

    monkeypatch.setattr(training,"decode_audio",decode)
    monkeypatch.setattr(training,"label_samples",label)
    monkeypatch.setattr(training,"run_gpu",run)
    package=types.ModuleType("acestep.training_v2");package.__path__=[]
    module=types.ModuleType("acestep.training_v2.preprocess");module.preprocess_audio_files=preprocess
    monkeypatch.setitem(sys.modules,"acestep.training_v2",package)
    monkeypatch.setitem(sys.modules,"acestep.training_v2.preprocess",module)
    current._checkpoint_dir="/exact-checkpoints"
    request={"operation":"preprocess","model":"acestep-v15-xl-turbo","samples":[{"audio_path":str(source),"is_instrumental":False}]}
    asyncio.run(training.execute_training_job(current,store,"recovered-task",request))
    assert list(tensors.iterdir()) == [tensors/"sample-0.pt"]
    assert (tensors/"sample-0.pt").read_bytes() == b"new-attempt"
    assert json.loads((root/"dataset.json").read_text())["samples"][0]["duration"] == 1.5
    store.mark_succeeded.assert_called_once_with("recovered-task",{"processed":1,"failed":0,"total":1,"tensor_dir":str(tensors)})

@pytest.mark.parametrize("cancel_at", ["decode", "label", "dataset_write", "preprocess"])
def test_dataset_cancellation_blocks_persistence_builder_and_terminal_success(training, monkeypatch, tmp_path, cancel_at):
    from copy import deepcopy
    source = tmp_path / "input.wav"
    source.write_bytes(b"audio")
    sample = {"audio_path": str(source), "caption": "Exact", "lyrics": "[Verse]\nWords", "raw_lyrics": "[Verse]\nWords",
        "bpm": 100, "keyscale": "C major", "timesignature": "4", "is_instrumental": False}
    builder = types.SimpleNamespace(samples=[types.SimpleNamespace(to_dict=lambda: deepcopy(sample))])
    original_samples = builder.samples
    runtime = state(tmp_path / "jobs")
    runtime.dataset_builder = builder
    runtime.dataset_json_path = "original.json"
    runtime._checkpoint_dir = str(tmp_path)
    cancelled = False
    store = Mock()
    store.client.hget.side_effect = lambda *_: "1" if cancelled else None
    def decode(_source, target):
        nonlocal cancelled
        target.write_bytes(b"decoded")
        if cancel_at == "decode": cancelled = True
        return 1.5
    def label(_state, samples, _model, _store, _id):
        nonlocal cancelled
        if cancel_at == "label": cancelled = True
        return samples
    def write(_path, _data):
        nonlocal cancelled
        if cancel_at == "dataset_write": cancelled = True
    def preprocess(**_):
        nonlocal cancelled
        cancelled = True
        return {"processed": 1, "failed": 0}
    async def gpu(_state, function, *args): return function(*args)
    monkeypatch.setattr(training, "decode_audio", decode)
    # Exercise the real complete-metadata fast path for cancellation during decode.
    if cancel_at != "decode": monkeypatch.setattr(training, "label_samples", label)
    writer = Mock(side_effect=write)
    monkeypatch.setattr(training, "_write_json", writer)
    monkeypatch.setattr(training, "run_gpu", gpu)
    module = types.ModuleType("acestep.training_v2.preprocess")
    module.preprocess_audio_files = preprocess
    monkeypatch.setitem(sys.modules, "acestep.training_v2.preprocess", module)
    model = types.ModuleType("acestep.training.dataset_builder")
    model.AudioSample = types.SimpleNamespace(from_dict=lambda item: item)
    monkeypatch.setitem(sys.modules, "acestep.training.dataset_builder", model)
    request = {"operation": "preprocess" if cancel_at == "preprocess" else "label", "model": "acestep-v15-xl-turbo", "samples": [sample]}
    with pytest.raises(RuntimeError, match="cancelled"):
        asyncio.run(training.execute_training_job(runtime, store, "cancel-test", request))
    if cancel_at in ("decode", "label"): writer.assert_not_called()
    assert builder.samples is original_samples
    assert runtime.dataset_json_path == "original.json"
    store.mark_succeeded.assert_not_called()
