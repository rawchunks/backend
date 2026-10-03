"""Preserve upstream training registration with one durable role-aware runtime."""
from acestep.api.train_api_models import initialize_training_state
from acestep.api.train_api_dataset_scan_load_routes import register_training_dataset_scan_load_routes
from acestep.api.train_api_dataset_sample_routes import register_training_dataset_sample_routes
from acestep.api.training import register_training_routes, register_dataset_jobs


def register_training_api_routes(app, verify_api_key, wrap_response, start_tensorboard=None,
    stop_tensorboard=None, temporary_llm_model=None, atomic_write_json=None, append_jsonl=None):
    register_training_routes(app, verify_api_key, wrap_response)
    register_dataset_jobs(app, verify_api_key, wrap_response)
    register_training_dataset_scan_load_routes(app, verify_api_key, wrap_response)
    register_training_dataset_sample_routes(app, verify_api_key, wrap_response)
