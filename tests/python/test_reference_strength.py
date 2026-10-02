"""Execute reference-aware orchestration without model weights or GPU calls."""
import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[2] / "worker/overlay/acestep/core/generation/handler"


def method(file, name):
    tree = ast.parse((ROOT / file).read_text())
    function = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)
    isolated = ast.Module(body=[function], type_ignores=[])
    import typing
    namespace = {name: getattr(typing, name) for name in ("Optional", "Tuple", "List", "Dict", "Any", "Union")}
    namespace.update({"logger": Mock(), "DEFAULT_DIT_INSTRUCTION": "Generate music", "torch": SimpleNamespace(Tensor=object)})
    function.decorator_list = []
    exec(compile(isolated, str(ROOT / file), "exec"), namespace)
    return namespace[name]


resolve = method("generate_music_request.py", "_neutralize_cover_only_params")


@pytest.mark.parametrize("strength", [0, .4, .7, 1])
def test_text2music_reference_preserves_requested_strength_and_neutralizes_source_noise(strength):
    assert resolve(None, "text2music", strength, .6, "https://fixture.invalid/sample.wav") == (strength, 0)


@pytest.mark.parametrize("reference", [None, "", "   "])
@pytest.mark.parametrize("strength", [0, .4, .7, 1])
def test_text2music_without_reference_preserves_existing_neutral_defaults(reference, strength):
    assert resolve(None, "text2music", strength, .6, reference) == (1, 0)


@pytest.mark.parametrize("task", ["cover", "cover-nofsq", "repaint", "lego", "extract", "complete"])
def test_source_audio_tasks_keep_their_existing_strength_and_noise(task):
    assert resolve(None, task, .4, .6) == (.4, .6)


@pytest.mark.parametrize("strength", [0, .4, .7, 1])
def test_generate_music_forwards_actual_reference_to_resolver(strength):
    # Execute the actual entry point up to the service boundary, which captures
    # effective arguments and deliberately stops before diffusion or decoding.
    class StopBeforeGpu(Exception):
        pass
    captured = {}
    host = SimpleNamespace(model=object(), vae=object(), text_tokenizer=object(), text_encoder=object())
    host._resolve_generate_music_progress = lambda progress: progress
    host._resolve_generate_music_task = lambda **kwargs: ("text2music", kwargs["instruction"])
    host._neutralize_cover_only_params = lambda **kwargs: resolve(host, **kwargs)
    host.is_turbo_model = lambda: False
    function = method("generate_music.py", "generate_music")
    # _resolve_dcw_enabled receives a positional value; capture the already
    # resolved pair at the resolver itself instead.
    def capture(**kwargs):
        captured.update(kwargs)
        captured["effective"] = resolve(host, **kwargs)
        return captured["effective"]
    host._neutralize_cover_only_params = capture
    host._resolve_dcw_enabled = lambda value: (_ for _ in ()).throw(StopBeforeGpu())
    with pytest.raises(StopBeforeGpu):
        function(host, captions="Song", reference_audio="https://fixture.invalid/sample.wav", task_type="text2music", audio_cover_strength=strength, cover_noise_strength=.6)
    assert captured["reference_audio"] == "https://fixture.invalid/sample.wav"
    assert captured["effective"] == (strength, 0)


def real_embed():
    torch = pytest.importorskip("torch", reason="Real tensor checks execute on the installed worker CPU")
    tree = ast.parse((ROOT / "conditioning_embed.py").read_text())
    class_node = next(node for node in tree.body if isinstance(node, ast.ClassDef))
    namespace = {"torch": torch, "logger": Mock(), "List": __import__("typing").List, "Dict": __import__("typing").Dict, "Tuple": __import__("typing").Tuple}
    exec(compile(ast.Module(body=[class_node], type_ignores=[]), str(ROOT / "conditioning_embed.py"), "exec"), namespace)
    host = namespace["ConditioningEmbedMixin"]()
    host.device = "cpu"
    host.dtype = torch.float32
    host.silence_latent = torch.arange(3000, dtype=torch.float32).reshape(1, 750, 4) / 1000
    host._ensure_silence_latent_on_device = lambda: None
    host.tiled_encode = Mock(return_value=torch.full((1, 4, 750), 5.0))
    return torch, host


@pytest.mark.parametrize("strength", [0, .4, .7, 1])
def test_reference_tensor_endpoints_and_intermediate_conditioning(strength):
    torch, host = real_embed()
    reference = torch.ones(2, 30)
    actual, order = host.infer_refer_latent([[reference]], strength)
    baseline, baseline_order = host.infer_refer_latent([[torch.zeros_like(reference)]])
    full = torch.full_like(baseline, 5.0)
    expected = baseline if strength == 0 else full if strength == 1 else baseline + strength * (full - baseline)
    assert torch.equal(actual, expected)
    assert torch.equal(order, baseline_order)
    assert actual.shape == baseline.shape
    assert actual.dtype == baseline.dtype
    assert bool(torch.isfinite(actual).all())
    if strength == 0:
        host.tiled_encode.assert_not_called()


def test_reference_strength_is_per_batch_and_does_not_persist_on_handler():
    torch, host = real_embed()
    reference = torch.ones(2, 30)
    baseline, _ = host.infer_refer_latent([[reference]], 0)
    full, _ = host.infer_refer_latent([[reference]], 1)
    again, _ = host.infer_refer_latent([[reference]])
    assert not torch.equal(baseline, full)
    assert torch.equal(full, again)
    assert not hasattr(host, "reference_audio_strength")


@pytest.mark.parametrize("strength", [-1, 1.1, float("nan"), float("inf")])
def test_invalid_reference_strength_rejected_before_encoding(strength):
    torch, host = real_embed()
    with pytest.raises(ValueError, match="Reference audio strength"):
        host.infer_refer_latent([[torch.ones(2, 30)]], strength)
    host.tiled_encode.assert_not_called()


@pytest.mark.parametrize("task", ["text2music", "cover"])
@pytest.mark.parametrize("strength", [0, .4, .7, 1])
def test_service_consumes_reference_strength_before_diffusion_without_changing_cover(task, strength):
    captured = {}
    class StopBeforeGpu(Exception):
        pass
    host = SimpleNamespace()
    host._normalize_service_generate_inputs = lambda **kwargs: {
        "captions": ["Song"], "lyrics": ["Words"], "keys": ["x"], "metas": ["{}"],
        "vocal_languages": ["en"], "repainting_start": [0], "repainting_end": [-1],
        "instructions": ["Generate music"], "audio_code_hints": [None], "seed_list": [1],
        "infer_steps": 8,
    }
    def batch(**kwargs):
        captured["batch"] = kwargs
        return kwargs
    host._prepare_batch = batch
    host.preprocess_batch = lambda batch: batch
    host._unpack_service_processed_data = lambda data: data
    host._resolve_service_seed_param = lambda seed: seed
    host._ensure_silence_latent_on_device = lambda: None
    def diffusion(**kwargs):
        captured["diffusion"] = kwargs
        raise StopBeforeGpu()
    host._build_service_generate_kwargs = diffusion
    with pytest.raises(StopBeforeGpu):
        method("service_generate.py", "service_generate")(host, captions="Song", task_type=task, audio_cover_strength=strength, cover_noise_strength=.6)
    assert captured["batch"]["task_type"] == task
    assert captured["batch"]["audio_cover_strength"] == strength
    assert captured["diffusion"]["audio_cover_strength"] == (1 if task == "text2music" else strength)
    assert captured["diffusion"]["cover_noise_strength"] == (0 if task == "text2music" else .6)


@pytest.mark.parametrize("task", ["text2music", "cover"])
def test_batch_prepares_reference_strength_and_masks_per_task(task):
    torch = pytest.importorskip("torch", reason="Real tensor checks execute on the installed worker CPU")
    tree = ast.parse((ROOT / "conditioning_batch.py").read_text())
    class_node = next(node for node in tree.body if isinstance(node, ast.ClassDef))
    import typing
    namespace = {name: getattr(typing, name) for name in ("Optional", "Tuple", "List", "Dict", "Any", "Union")}
    namespace.update({"torch": torch, "DEFAULT_DIT_INSTRUCTION": "Generate music"})
    exec(compile(ast.Module(body=[class_node], type_ignores=[]), str(ROOT / "conditioning_batch.py"), "exec"), namespace)
    host = namespace[class_node.name]()
    host.device = "cpu"; host.dtype = torch.float32; host.sample_rate = 1
    host._get_vae_dtype = lambda: torch.float32
    host._normalize_audio_code_hints = lambda hints, count: [None] * count
    host._create_fallback_vocal_languages = lambda count: ["en"] * count
    host._parse_metas = lambda metas: metas
    host._normalize_instructions = lambda instructions, count, default: [default] * count
    wavs = torch.zeros(1, 2, 30); latents = torch.zeros(1, 750, 4)
    host._prepare_target_latents_and_wavs = lambda *args, **kwargs: (wavs, latents, torch.ones(1, 750), 750, latents)
    masks = torch.zeros(1, 750, dtype=torch.bool); is_covers = torch.zeros(1, dtype=torch.bool)
    host._build_chunk_masks_and_src_latents = lambda *args, **kwargs: (masks, [], is_covers, latents, None)
    host._prepare_precomputed_lm_hints = lambda *args: None
    captured = {}
    def text(*args, **kwargs):
        captured["strength"] = args[6]
        return ([], *[torch.zeros(1, 1, dtype=torch.long) for _ in range(4)], None, None)
    host._prepare_text_conditioning_inputs = text
    baseline = host._prepare_batch(captions=["Song"], lyrics=["Words"], task_type=task, audio_cover_strength=1)
    actual = host._prepare_batch(captions=["Song"], lyrics=["Words"], task_type=task, audio_cover_strength=.4)
    assert actual["reference_audio_strength"] == (.4 if task == "text2music" else 1)
    assert captured["strength"] == (1 if task == "text2music" else .4)
    for name in ("chunk_masks", "latent_masks", "is_covers", "src_latents"):
        assert torch.equal(actual[name], baseline[name])
