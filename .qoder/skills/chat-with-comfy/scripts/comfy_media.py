#!/usr/bin/env python3
"""Run the API-format workflows bundled with the Comfy media skill."""

from __future__ import annotations

import argparse
import copy
import ipaddress
import json
import mimetypes
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


SKILL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV = SKILL_ROOT / ".env"
MODEL_REGISTRY_PATH = SKILL_ROOT / "api" / "models.json"
VALID_MODES = frozenset({"t2i", "i2i", "t2v", "i2v", "r2v"})
MODE_REQUIRED_BINDINGS = {
    "t2i": frozenset({"prompt", "width", "height", "batch_size", "seed", "filename_prefix"}),
    "i2i": frozenset({"prompt", "seed", "batch_size", "filename_prefix"}),
    "t2v": frozenset({"prompt", "duration", "seed", "aspect_ratio", "megapixels", "filename_prefix"}),
    "i2v": frozenset({"prompt", "duration", "seed", "aspect_ratio", "megapixels", "filename_prefix"}),
    "r2v": frozenset({"prompt", "duration", "seed", "aspect_ratio", "megapixels", "filename_prefix"}),
}

ASPECT_RATIOS = {
    "1:1": "1:1 (Square)",
    "2:3": "2:3 (Portrait Photo)",
    "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)",
    "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)",
    "16:9": "16:9 (Widescreen)",
    "21:9": "21:9 (Ultrawide)",
}

BASE_H3_FIELDS = (
    "integrated_multimodal_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
)

REF_H3_FIELDS = (
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
)


class SkillError(RuntimeError):
    """Expected user-facing failure."""


class ApiError(SkillError):
    def __init__(self, status: int | None, message: str):
        self.status = status
        super().__init__(message)


@dataclass(frozen=True)
class InputBinding:
    node_id: str
    input_name: str


@dataclass(frozen=True)
class WorkflowOverride:
    binding: InputBinding
    value: Any


@dataclass(frozen=True)
class ImageSlot:
    image: InputBinding
    enabled: InputBinding | None = None
    optional_connection: InputBinding | None = None


@dataclass(frozen=True)
class ReferenceImageConfig:
    generator_node: str
    input_prefix: str
    template_node: str
    load_input: str
    initial_load_nodes: tuple[str, ...]
    max_images: int


@dataclass(frozen=True)
class ModelProfile:
    name: str
    description: str
    mode: str
    workflow: str
    is_default: bool
    default_filename_prefix: str
    prompt_format: str
    bindings: dict[str, InputBinding]
    overrides: tuple[WorkflowOverride, ...]
    image_slots: tuple[ImageSlot, ...]
    reference_images: ReferenceImageConfig | None


def emit_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for number, raw_line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise SkillError(f"Invalid .env entry at {path}:{number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def config_error(context: str, message: str) -> SkillError:
    return SkillError(f"Invalid model configuration ({context}): {message}")


def config_string(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise config_error(context, "must be a non-empty string")
    return value.strip()


def parse_binding(value: Any, context: str) -> InputBinding:
    if not isinstance(value, dict):
        raise config_error(context, "must be an object with node and input")
    return InputBinding(
        node_id=config_string(value.get("node"), f"{context}.node"),
        input_name=config_string(value.get("input"), f"{context}.input"),
    )


def merge_model_config(
    name: str,
    all_models: dict[str, Any],
    stack: tuple[str, ...] = (),
) -> dict[str, Any]:
    if name in stack:
        chain = " -> ".join((*stack, name))
        raise config_error(name, f"extends contains a cycle: {chain}")
    raw = all_models.get(name)
    if not isinstance(raw, dict):
        raise config_error(name, "must be an object")
    parent_name = raw.get("extends")
    if parent_name is None:
        return copy.deepcopy(raw)
    parent_name = config_string(parent_name, f"{name}.extends")
    if parent_name not in all_models:
        raise config_error(name, f"extends references unknown model {parent_name!r}")

    merged = merge_model_config(parent_name, all_models, (*stack, name))
    # A derived profile is never a default unless it explicitly opts in.
    merged.pop("default", None)
    inherited_overrides = merged.get("overrides", [])
    child = copy.deepcopy(raw)
    child.pop("extends", None)
    if "overrides" in child:
        child["overrides"] = [*inherited_overrides, *child["overrides"]]
    merged.update(child)
    return merged


def parse_model_profile(name: str, value: dict[str, Any]) -> ModelProfile:
    context = f"models.{name}"
    mode = config_string(value.get("mode"), f"{context}.mode")
    if mode not in VALID_MODES:
        raise config_error(context, f"mode must be one of: {', '.join(sorted(VALID_MODES))}")

    workflow = config_string(value.get("workflow"), f"{context}.workflow")
    workflow_path = Path(workflow)
    api_root = (SKILL_ROOT / "api").resolve()
    if workflow_path.is_absolute() or ".." in workflow_path.parts or workflow_path.suffix.lower() != ".json":
        raise config_error(f"{context}.workflow", "must be a relative JSON file under api/")
    try:
        (api_root / workflow_path).resolve().relative_to(api_root)
    except ValueError:
        raise config_error(f"{context}.workflow", "must stay under api/") from None

    raw_bindings = value.get("bindings")
    if not isinstance(raw_bindings, dict):
        raise config_error(f"{context}.bindings", "must be an object")
    bindings = {
        field: parse_binding(binding, f"{context}.bindings.{field}")
        for field, binding in raw_bindings.items()
        if isinstance(field, str)
    }
    if len(bindings) != len(raw_bindings):
        raise config_error(f"{context}.bindings", "field names must be strings")
    missing_bindings = MODE_REQUIRED_BINDINGS[mode] - bindings.keys()
    if missing_bindings:
        raise config_error(context, f"missing bindings: {', '.join(sorted(missing_bindings))}")

    raw_overrides = value.get("overrides", [])
    if not isinstance(raw_overrides, list):
        raise config_error(f"{context}.overrides", "must be an array")
    overrides: list[WorkflowOverride] = []
    for index, override in enumerate(raw_overrides):
        if not isinstance(override, dict) or "value" not in override:
            raise config_error(f"{context}.overrides[{index}]", "must contain node, input, and value")
        overrides.append(
            WorkflowOverride(
                binding=parse_binding(override, f"{context}.overrides[{index}]"),
                value=override["value"],
            )
        )

    raw_slots = value.get("image_slots", [])
    if not isinstance(raw_slots, list):
        raise config_error(f"{context}.image_slots", "must be an array")
    image_slots: list[ImageSlot] = []
    for index, slot in enumerate(raw_slots):
        if not isinstance(slot, dict):
            raise config_error(f"{context}.image_slots[{index}]", "must be an object")
        image_slots.append(
            ImageSlot(
                optional_connection=(
                    parse_binding(slot["optional_connection"], f"{context}.image_slots[{index}].optional_connection")
                    if "optional_connection" in slot else None
                ),
                image=parse_binding(slot.get("image"), f"{context}.image_slots[{index}].image"),
                enabled=(
                    parse_binding(slot["enabled"], f"{context}.image_slots[{index}].enabled")
                    if "enabled" in slot
                    else None
                ),
            )
        )
    if mode == "i2i" and not 1 <= len(image_slots) <= 10:
        raise config_error(f"{context}.image_slots", "i2i requires between one and ten slots")
    if mode == "i2v" and len(image_slots) != 1:
        raise config_error(f"{context}.image_slots", "i2v requires exactly one slot")
    if mode not in {"i2i", "i2v"} and image_slots:
        raise config_error(f"{context}.image_slots", f"is not used by mode {mode}")

    reference_images: ReferenceImageConfig | None = None
    raw_references = value.get("reference_images")
    if mode == "r2v":
        if not isinstance(raw_references, dict):
            raise config_error(f"{context}.reference_images", "is required for r2v")
        initial_nodes = raw_references.get("initial_load_nodes")
        if not isinstance(initial_nodes, list) or not initial_nodes:
            raise config_error(f"{context}.reference_images.initial_load_nodes", "must be a non-empty array")
        if not all(isinstance(node, str) and node.strip() for node in initial_nodes):
            raise config_error(f"{context}.reference_images.initial_load_nodes", "must contain non-empty node IDs")
        max_images = raw_references.get("max_images", 9)
        if isinstance(max_images, bool) or not isinstance(max_images, int) or not 1 <= max_images <= 64:
            raise config_error(f"{context}.reference_images.max_images", "must be an integer between 1 and 64")
        reference_images = ReferenceImageConfig(
            generator_node=config_string(raw_references.get("generator_node"), f"{context}.reference_images.generator_node"),
            input_prefix=config_string(raw_references.get("input_prefix"), f"{context}.reference_images.input_prefix"),
            template_node=config_string(raw_references.get("template_node"), f"{context}.reference_images.template_node"),
            load_input=config_string(raw_references.get("load_input"), f"{context}.reference_images.load_input"),
            initial_load_nodes=tuple(initial_nodes),
            max_images=max_images,
        )
    elif raw_references is not None:
        raise config_error(f"{context}.reference_images", f"is not used by mode {mode}")

    prompt_format = str(value.get("prompt_format", "plain")).strip().lower()
    if prompt_format not in {"plain", "h3_base", "h3_reference"}:
        raise config_error(f"{context}.prompt_format", "must be plain, h3_base, or h3_reference")
    if prompt_format == "h3_base" and mode not in {"t2v", "i2v"}:
        raise config_error(f"{context}.prompt_format", "h3_base is only valid for t2v or i2v")
    if prompt_format == "h3_reference" and mode != "r2v":
        raise config_error(f"{context}.prompt_format", "h3_reference is only valid for r2v")

    default_filename_prefix = safe_prefix(value.get("default_filename_prefix"), name)
    is_default = value.get("default", False)
    if not isinstance(is_default, bool):
        raise config_error(f"{context}.default", "must be true or false")
    return ModelProfile(
        name=name,
        description=str(value.get("description", "")).strip(),
        mode=mode,
        workflow=workflow_path.as_posix(),
        is_default=is_default,
        default_filename_prefix=default_filename_prefix,
        prompt_format=prompt_format,
        bindings=bindings,
        overrides=tuple(overrides),
        image_slots=tuple(image_slots),
        reference_images=reference_images,
    )


def load_model_profiles() -> dict[str, ModelProfile]:
    try:
        registry = json.loads(MODEL_REGISTRY_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SkillError(f"Model configuration is missing: {MODEL_REGISTRY_PATH}") from None
    except json.JSONDecodeError as error:
        raise SkillError(
            f"Model configuration JSON is invalid at {MODEL_REGISTRY_PATH}:{error.lineno}:{error.colno}: {error.msg}"
        ) from None
    if not isinstance(registry, dict) or registry.get("schema_version") != 1:
        raise SkillError("Model configuration must be an object with schema_version set to 1")
    raw_models = registry.get("models")
    if not isinstance(raw_models, dict) or not raw_models:
        raise SkillError("Model configuration must contain a non-empty models object")
    if not all(isinstance(name, str) and name.strip() for name in raw_models):
        raise SkillError("Model configuration model names must be non-empty strings")
    profiles = {
        name: parse_model_profile(name, merge_model_config(name, raw_models))
        for name in raw_models
    }
    for mode in VALID_MODES:
        defaults = [profile.name for profile in profiles.values() if profile.mode == mode and profile.is_default]
        if len(defaults) != 1:
            raise SkillError(
                f"Model configuration must define exactly one default model for {mode}; found: {', '.join(defaults) or 'none'}"
            )
    return profiles


def select_model_profile(mode: str, model: Any, profiles: dict[str, ModelProfile]) -> ModelProfile:
    if mode not in VALID_MODES:
        raise SkillError(f"mode is required and must be one of: {', '.join(sorted(VALID_MODES))}")
    if model is None:
        return next(profile for profile in profiles.values() if profile.mode == mode and profile.is_default)
    if not isinstance(model, str) or not model.strip():
        raise SkillError("model must be a non-empty configured model name")
    profile = profiles.get(model.strip())
    if profile is None:
        raise SkillError(f"Unknown model {model!r}; run 'python scripts/comfy_media.py models' to list configured models")
    if profile.mode != mode:
        raise SkillError(f"Model {profile.name!r} supports {profile.mode}, not requested mode {mode}")
    return profile


def first_value(source: dict[str, str], *names: str) -> str:
    for name in names:
        if name in os.environ:
            return os.environ[name].strip()
    for name in names:
        if name in source:
            return source[name].strip()
    return ""


def public_http_warning(base_url: str) -> str | None:
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme != "http" or not parsed.hostname:
        return None
    host = parsed.hostname
    if host in {"localhost", "localhost.localdomain"}:
        return None
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "ComfyUI uses unencrypted HTTP on a non-local hostname; credentials and media can be intercepted."
    if address.is_loopback or address.is_private:
        return None
    return "ComfyUI uses unencrypted HTTP on a public address; credentials and media can be intercepted."


@dataclass
class Settings:
    base_url: str
    api_key: str
    warnings: list[str]

    @classmethod
    def load(cls, env_path: Path) -> "Settings":
        source = parse_dotenv(env_path)
        base_url = first_value(source, "COMFY_BASE_URL", "Comfy_BASE_URL").rstrip("/")
        if not base_url:
            raise SkillError(f"Comfy_BASE_URL is missing from {env_path}")
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise SkillError("Comfy_BASE_URL must be an absolute http:// or https:// URL")
        if parsed.username or parsed.password:
            raise SkillError("Do not place credentials inside Comfy_BASE_URL; use Comfy_API_KEY")
        api_key = first_value(source, "COMFY_API_KEY", "Comfy_API_KEY")
        if not api_key or any(char.isspace() for char in api_key):
            raise SkillError("Comfy_API_KEY must contain a non-empty Bearer token without whitespace")
        warning = public_http_warning(base_url)
        return cls(base_url=base_url, api_key=api_key, warnings=[warning] if warning else [])

    def auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    def auth_summary(self) -> dict[str, Any]:
        return {"mode": "bearer", "api_key_configured": bool(self.api_key)}


class ComfyClient:
    def __init__(self, settings: Settings, timeout: float = 30.0):
        self.settings = settings
        self.timeout = timeout
        self.default_headers = {
            "Accept": "application/json",
            "User-Agent": "chat-with-comfy/1.0",
            **settings.auth_headers(),
        }

    def _url(self, path: str, query: dict[str, str] | None = None) -> str:
        url = f"{self.settings.base_url}/{path.lstrip('/')}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        return url

    def request_bytes(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        query: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> tuple[bytes, int, str]:
        request_headers = dict(self.default_headers)
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(
            self._url(path, query),
            data=body,
            headers=request_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                return response.read(), response.status, response.headers.get_content_type()
        except urllib.error.HTTPError as error:
            response_body = error.read(4096).decode("utf-8", errors="replace").strip()
            detail = response_body or error.reason or "HTTP request failed"
            raise ApiError(error.code, f"HTTP {error.code} for {path}: {detail}") from None
        except urllib.error.URLError as error:
            raise ApiError(None, f"Cannot reach ComfyUI at {self.settings.base_url}: {error.reason}") from None
        except TimeoutError:
            raise ApiError(None, f"Timed out connecting to ComfyUI at {self.settings.base_url}") from None

    def request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> tuple[dict[str, Any], int]:
        body = None
        headers: dict[str, str] = {}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        raw, status, _ = self.request_bytes(
            method,
            path,
            body=body,
            headers=headers,
            timeout=timeout,
        )
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ApiError(status, f"ComfyUI returned invalid JSON for {path}: {error}") from None
        if not isinstance(parsed, dict):
            raise ApiError(status, f"ComfyUI returned a non-object JSON response for {path}")
        return parsed, status

    def health(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "ok": False,
            "reachable": False,
            "authenticated": False,
            "base_url": self.settings.base_url,
            "auth": self.settings.auth_summary(),
            "warnings": self.settings.warnings,
        }
        try:
            stats, status = self.request_json("GET", "/system_stats")
        except ApiError as error:
            result["reachable"] = error.status is not None
            result["status"] = error.status
            if error.status in {401, 403}:
                result["message"] = (
                    "ComfyUI is reachable but authentication failed. For ComfyUI-Login, set Comfy_API_KEY to the exact direct-API Bearer token printed at server startup."
                )
            else:
                result["message"] = str(error)
            return result

        result.update(
            {
                "reachable": True,
                "authenticated": True,
                "status": status,
                "system": {
                    "os": stats.get("system", {}).get("os"),
                    "python_version": stats.get("system", {}).get("python_version"),
                    "device_count": len(stats.get("devices", [])),
                },
            }
        )
        required_nodes = sorted({
            node["class_type"]
            for profile in load_model_profiles().values()
            for node in load_workflow(profile).values()
        })
        try:
            _, queue_status = self.request_json("GET", "/queue")
            object_info, object_status = self.request_json("GET", "/object_info")
        except ApiError as error:
            result["message"] = f"Core health endpoint succeeded, but API capability checks failed: {error}"
            return result
        node_status = {name: name in object_info for name in required_nodes}
        result.update(
            {
                "ok": all(node_status.values()),
                "queue_status": queue_status,
                "object_info_status": object_status,
                "required_nodes": node_status,
            }
        )
        if not result["ok"]:
            result["message"] = "ComfyUI is reachable, but one or more required workflow nodes are missing."
        return result

    def upload_image(self, path: Path) -> str:
        suffix = path.suffix.lower() or ".bin"
        upload_name = f"skill_{uuid.uuid4().hex}{suffix}"
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        boundary = f"----ComfySkill{uuid.uuid4().hex}"

        chunks = []
        fields = {"type": "input", "overwrite": "true"}
        for name, value in fields.items():
            chunks.append(
                (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                    f"{value}\r\n"
                ).encode("utf-8")
            )
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="image"; filename="{upload_name}"\r\n'
                f"Content-Type: {mime_type}\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(path.read_bytes())
        chunks.append(f"\r\n--{boundary}--\r\n".encode("ascii"))

        raw, status, _ = self.request_bytes(
            "POST",
            "/upload/image",
            body=b"".join(chunks),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            timeout=max(self.timeout, 120.0),
        )
        try:
            response = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ApiError(status, f"Invalid upload response for {path.name}: {error}") from None
        if not isinstance(response, dict) or not response.get("name"):
            raise ApiError(status, f"Upload response did not contain a filename for {path.name}")
        subfolder = str(response.get("subfolder", "")).strip("/\\")
        name = str(response["name"]).replace("\\", "/")
        return f"{subfolder}/{name}" if subfolder else name

    def submit(self, workflow: dict[str, Any]) -> str:
        client_id = str(uuid.uuid4())
        response, _ = self.request_json(
            "POST",
            "/prompt",
            {"prompt": workflow, "client_id": client_id},
            timeout=max(self.timeout, 120.0),
        )
        prompt_id = response.get("prompt_id")
        if not isinstance(prompt_id, str) or not prompt_id:
            node_errors = response.get("node_errors")
            raise ApiError(None, f"ComfyUI did not return prompt_id; node_errors={node_errors!r}")
        return prompt_id

    def wait_for_history(
        self,
        prompt_id: str,
        *,
        timeout: float,
        poll_interval: float = 2.0,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last_report = 0.0
        while time.monotonic() < deadline:
            try:
                history, _ = self.request_json("GET", f"/history/{prompt_id}")
            except ApiError as error:
                if error.status == 404:
                    history = {}
                else:
                    raise
            record = history.get(prompt_id)
            if isinstance(record, dict):
                status = record.get("status", {})
                if isinstance(status, dict) and status.get("status_str") == "error":
                    messages = status.get("messages")
                    raise SkillError(f"ComfyUI execution failed: {messages!r}")
                if "outputs" in record:
                    return record
            now = time.monotonic()
            if now - last_report >= 30:
                progress(f"Waiting for ComfyUI job {prompt_id} ...")
                last_report = now
            time.sleep(poll_interval)
        raise SkillError(
            f"Timed out after {timeout:g}s waiting for prompt {prompt_id}. The job may still be queued or running; do not resubmit it automatically."
        )

    def download_output(self, item: dict[str, str], destination: Path) -> Path:
        filename = item.get("filename", "")
        if not filename:
            raise SkillError("ComfyUI output item is missing filename")
        query = {
            "filename": filename,
            "subfolder": item.get("subfolder", ""),
            "type": item.get("type", "output"),
        }
        data, _, _ = self.request_bytes(
            "GET",
            "/view",
            query=query,
            timeout=max(self.timeout, 300.0),
        )
        destination.mkdir(parents=True, exist_ok=True)
        safe_name = Path(filename.replace("\\", "/")).name
        target = destination / safe_name
        if target.exists():
            target = destination / f"{target.stem}_{uuid.uuid4().hex[:8]}{target.suffix}"
        target.write_bytes(data)
        return target.resolve()


def require_int(request: dict[str, Any], field: str, minimum: int, maximum: int) -> int:
    value = request.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SkillError(f"{field} is required and must be an integer")
    if not minimum <= value <= maximum:
        raise SkillError(f"{field} must be between {minimum} and {maximum}")
    return value


def require_float(request: dict[str, Any], field: str, minimum: float, maximum: float) -> float:
    value = request.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SkillError(f"{field} is required and must be a number")
    result = float(value)
    if not minimum <= result <= maximum:
        raise SkillError(f"{field} must be between {minimum:g} and {maximum:g}")
    return result


def normalize_ratio(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SkillError("aspect_ratio is required for video generation")
    compact = value.strip()
    if compact in ASPECT_RATIOS:
        return ASPECT_RATIOS[compact]
    for label in ASPECT_RATIOS.values():
        if compact == label:
            return label
    raise SkillError(f"Unsupported aspect_ratio {value!r}; choose one of: {', '.join(ASPECT_RATIOS)}")


def safe_prefix(value: Any, default: str) -> str:
    if value is None:
        return default
    if not isinstance(value, str) or not value.strip():
        raise SkillError("filename_prefix must be a non-empty string")
    normalized = value.strip().replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts:
        raise SkillError("filename_prefix must be a safe relative path without '..'")
    return normalized


def validate_prompt_format(profile: ModelProfile, prompt: str) -> None:
    if profile.prompt_format == "plain":
        return
    fields = REF_H3_FIELDS if profile.prompt_format == "h3_reference" else BASE_H3_FIELDS
    missing = [field for field in fields if field not in prompt]
    if missing:
        raise SkillError(
            f"Prompt for model {profile.name!r} is not a complete H3 rewrite; missing fields: "
            + ", ".join(missing)
        )
    positions = [prompt.index(field) for field in fields]
    if positions != sorted(positions):
        raise SkillError("H3 prompt fields are not in the order required by h3-prompt-writing")


def resolve_input_images(
    request: dict[str, Any],
    profile: ModelProfile,
    request_dir: Path,
) -> list[Path]:
    mode = profile.mode
    raw_images = request.get("input_images", [])
    if not isinstance(raw_images, list) or not all(isinstance(item, str) for item in raw_images):
        raise SkillError("input_images must be a JSON array of local file paths")
    if mode in {"t2i", "t2v"} and raw_images:
        raise SkillError(f"mode {mode} does not accept input_images")
    if mode == "i2i" and not 1 <= len(raw_images) <= len(profile.image_slots):
        raise SkillError(f"model {profile.name!r} requires between one and {len(profile.image_slots)} input images")
    if mode == "i2v" and len(raw_images) != 1:
        raise SkillError("mode i2v requires exactly one first-frame image")
    if mode == "r2v":
        assert profile.reference_images is not None
        if not 1 <= len(raw_images) <= profile.reference_images.max_images:
            raise SkillError(
                f"model {profile.name!r} requires between one and {profile.reference_images.max_images} reference images"
            )
    resolved: list[Path] = []
    for raw_path in raw_images:
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            path = request_dir / path
        path = path.resolve()
        if not path.is_file():
            raise SkillError(f"Input image does not exist or is not a file: {path}")
        resolved.append(path)
    return resolved


@dataclass
class PreparedRequest:
    mode: str
    model_profile: ModelProfile
    prompt: str
    seed: int
    timeout: float
    output_dir: Path
    input_images: list[Path]
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    aspect_ratio: str | None = None
    megapixels: float | None = None
    filename_prefix: str | None = None
    batch_size: int = 1


def prepare_request(raw: dict[str, Any], request_dir: Path) -> PreparedRequest:
    mode = raw.get("mode")
    profiles = load_model_profiles()
    profile = select_model_profile(mode, raw.get("model"), profiles)
    prompt = raw.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise SkillError("prompt is required and must be a non-empty string")
    prompt = prompt.strip()

    seed_value = raw.get("seed")
    if seed_value is None:
        seed = secrets.randbelow(2**53)
    elif isinstance(seed_value, bool) or not isinstance(seed_value, int) or seed_value < 0:
        raise SkillError("seed must be a non-negative integer")
    else:
        seed = seed_value

    timeout = float(raw.get("timeout", 3600))
    if timeout <= 0:
        raise SkillError("timeout must be greater than zero")

    output_dir_value = raw.get("output_dir")
    if output_dir_value is None:
        output_dir = SKILL_ROOT / "outputs"
    elif not isinstance(output_dir_value, str) or not output_dir_value.strip():
        raise SkillError("output_dir must be a non-empty path string")
    else:
        output_dir = Path(output_dir_value).expanduser()
        if not output_dir.is_absolute():
            output_dir = SKILL_ROOT / output_dir
    output_dir = output_dir.resolve()

    images = resolve_input_images(raw, profile, request_dir)
    if mode == "t2i":
        width = require_int(raw, "width", 16, 16384)
        height = require_int(raw, "height", 16, 16384)
        if width % 16 or height % 16:
            raise SkillError("t2i width and height must both be multiples of 16")
        batch_size_value = raw.get("batch_size", 1)
        if isinstance(batch_size_value, bool) or not isinstance(batch_size_value, int):
            raise SkillError("batch_size must be an integer")
        if not 1 <= batch_size_value <= 64:
            raise SkillError("batch_size must be between 1 and 64")
        return PreparedRequest(
            mode=mode,
            model_profile=profile,
            prompt=prompt,
            seed=seed,
            timeout=timeout,
            output_dir=output_dir,
            input_images=images,
            width=width,
            height=height,
            filename_prefix=safe_prefix(raw.get("filename_prefix"), profile.default_filename_prefix),
            batch_size=batch_size_value,
        )

    if mode == "i2i":
        return PreparedRequest(
            mode=mode,
            model_profile=profile,
            prompt=prompt,
            seed=seed,
            timeout=timeout,
            output_dir=output_dir,
            input_images=images,
            filename_prefix=safe_prefix(raw.get("filename_prefix"), profile.default_filename_prefix),
        )

    validate_prompt_format(profile, prompt)
    duration = require_float(raw, "duration", 5.0, 15.0)
    megapixels = require_float(raw, "megapixels", 0.1, 16.0)
    ratio = normalize_ratio(raw.get("aspect_ratio"))
    return PreparedRequest(
        mode=mode,
        model_profile=profile,
        prompt=prompt,
        seed=seed,
        timeout=timeout,
        output_dir=output_dir,
        input_images=images,
        duration=duration,
        aspect_ratio=ratio,
        megapixels=megapixels,
        filename_prefix=safe_prefix(raw.get("filename_prefix"), profile.default_filename_prefix),
    )


def workflow_path(profile: ModelProfile) -> Path:
    return (SKILL_ROOT / "api" / profile.workflow).resolve()


def load_workflow(profile: ModelProfile) -> dict[str, Any]:
    path = workflow_path(profile)
    try:
        workflow = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SkillError(f"Workflow file is missing: {path}") from None
    except json.JSONDecodeError as error:
        raise SkillError(f"Workflow JSON is invalid at {path}:{error.lineno}:{error.colno}: {error.msg}") from None
    if not isinstance(workflow, dict):
        raise SkillError(f"Workflow must be a JSON object: {path}")
    return workflow


def set_input(workflow: dict[str, Any], node_id: str, field: str, value: Any) -> None:
    try:
        workflow[node_id]["inputs"][field] = value
    except (KeyError, TypeError):
        raise SkillError(f"Workflow node mapping is stale: node {node_id!r} input {field!r} is missing") from None


def set_binding(workflow: dict[str, Any], binding: InputBinding, value: Any) -> None:
    set_input(workflow, binding.node_id, binding.input_name, value)


def set_profile_value(workflow: dict[str, Any], profile: ModelProfile, field: str, value: Any) -> None:
    try:
        binding = profile.bindings[field]
    except KeyError:
        raise SkillError(f"Model {profile.name!r} does not configure a binding for {field!r}") from None
    set_binding(workflow, binding, value)


def patch_workflow(prepared: PreparedRequest, uploaded_images: list[str]) -> dict[str, Any]:
    profile = prepared.model_profile
    workflow = copy.deepcopy(load_workflow(profile))
    for override in profile.overrides:
        set_binding(workflow, override.binding, override.value)

    set_profile_value(workflow, profile, "prompt", prepared.prompt)
    set_profile_value(workflow, profile, "seed", prepared.seed)
    set_profile_value(workflow, profile, "filename_prefix", prepared.filename_prefix)

    if prepared.mode == "t2i":
        set_profile_value(workflow, profile, "width", prepared.width)
        set_profile_value(workflow, profile, "height", prepared.height)
        set_profile_value(workflow, profile, "batch_size", prepared.batch_size)
        return workflow

    if prepared.mode == "i2i":
        set_profile_value(workflow, profile, "batch_size", 1)
        for index, slot in enumerate(profile.image_slots):
            if index >= len(uploaded_images) and slot.optional_connection is not None:
                connection = slot.optional_connection
                del workflow[connection.node_id]["inputs"][connection.input_name]
                del workflow[slot.image.node_id]
                continue
            uploaded_name = uploaded_images[index] if index < len(uploaded_images) else ""
            set_binding(workflow, slot.image, uploaded_name)
            if slot.enabled is not None:
                set_binding(workflow, slot.enabled, index < len(uploaded_images))
        return workflow

    set_profile_value(workflow, profile, "aspect_ratio", prepared.aspect_ratio)
    set_profile_value(workflow, profile, "megapixels", prepared.megapixels)
    set_profile_value(workflow, profile, "duration", prepared.duration)

    if prepared.mode == "i2v":
        set_binding(workflow, profile.image_slots[0].image, uploaded_images[0])
    elif prepared.mode == "r2v":
        assert profile.reference_images is not None
        references = profile.reference_images
        try:
            generator_inputs = workflow[references.generator_node]["inputs"]
        except (KeyError, TypeError):
            raise SkillError(
                f"Workflow node mapping is stale: reference generator {references.generator_node!r} is missing"
            ) from None
        if not isinstance(generator_inputs, dict):
            raise SkillError(
                f"Workflow node mapping is stale: reference generator {references.generator_node!r} has invalid inputs"
            )
        for key in list(generator_inputs):
            if key.startswith(references.input_prefix):
                del generator_inputs[key]
        try:
            template = copy.deepcopy(workflow[references.template_node])
        except KeyError:
            raise SkillError(
                f"Workflow node mapping is stale: reference template {references.template_node!r} is missing"
            ) from None
        for index, uploaded_name in enumerate(uploaded_images):
            if index < len(references.initial_load_nodes):
                node_id = references.initial_load_nodes[index]
            else:
                node_id = f"skill-ref-{index}"
                workflow[node_id] = copy.deepcopy(template)
            set_input(workflow, node_id, references.load_input, uploaded_name)
            generator_inputs[f"{references.input_prefix}{index}"] = [node_id, 0]
    return workflow


def output_items(record: dict[str, Any]) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def walk(value: Any) -> Iterable[dict[str, str]]:
        if isinstance(value, dict):
            if isinstance(value.get("filename"), str):
                yield {
                    "filename": value["filename"],
                    "subfolder": str(value.get("subfolder", "")),
                    "type": str(value.get("type", "output")),
                }
            for child in value.values():
                yield from walk(child)
        elif isinstance(value, list):
            for child in value:
                yield from walk(child)

    for item in walk(record.get("outputs", {})):
        key = (item["filename"], item["subfolder"], item["type"])
        if key not in seen:
            seen.add(key)
            found.append(item)
    return found


def validate_workflows() -> dict[str, Any]:
    try:
        profiles = load_model_profiles()
    except SkillError as error:
        return {"ok": False, "model_configuration_error": str(error), "workflows": {}}
    details: dict[str, Any] = {}
    ok = True
    for name, profile in profiles.items():
        try:
            workflow = load_workflow(profile)
            missing: list[str] = []
            required_bindings = [*profile.bindings.values(), *(item.binding for item in profile.overrides)]
            required_bindings.extend(slot.image for slot in profile.image_slots)
            required_bindings.extend(slot.enabled for slot in profile.image_slots if slot.enabled is not None)
            required_bindings.extend(slot.optional_connection for slot in profile.image_slots if slot.optional_connection is not None)
            for binding in required_bindings:
                node_id = binding.node_id
                node = workflow.get(node_id)
                if not isinstance(node, dict):
                    missing.append(f"node:{node_id}")
                    continue
                inputs = node.get("inputs", {})
                if not isinstance(inputs, dict) or binding.input_name not in inputs:
                    missing.append(f"input:{node_id}.{binding.input_name}")
            if profile.reference_images is not None:
                references = profile.reference_images
                generator = workflow.get(references.generator_node)
                if not isinstance(generator, dict) or not isinstance(generator.get("inputs"), dict):
                    missing.append(f"node:{references.generator_node}")
                for node_id in {references.template_node, *references.initial_load_nodes}:
                    node = workflow.get(node_id)
                    if not isinstance(node, dict):
                        missing.append(f"node:{node_id}")
                    elif not isinstance(node.get("inputs"), dict) or references.load_input not in node["inputs"]:
                        missing.append(f"input:{node_id}.{references.load_input}")
            details[name] = {
                "mode": profile.mode,
                "default": profile.is_default,
                "file": str(workflow_path(profile)),
                "node_count": len(workflow),
                "missing_mappings": missing,
            }
            ok = ok and not missing
        except SkillError as error:
            ok = False
            details[name] = {"error": str(error)}
    return {"ok": ok, "workflows": details}


def list_models() -> dict[str, Any]:
    profiles = load_model_profiles()
    return {
        "ok": True,
        "models": [
            {
                "name": profile.name,
                "description": profile.description,
                "mode": profile.mode,
                "default": profile.is_default,
                "prompt_format": profile.prompt_format,
                "workflow": profile.workflow,
            }
            for profile in profiles.values()
        ],
    }


def load_request_file(value: str) -> tuple[dict[str, Any], Path]:
    if value == "-":
        content = sys.stdin.read()
        request_dir = Path.cwd()
        source = "stdin"
    else:
        path = Path(value).expanduser().resolve()
        content = path.read_text(encoding="utf-8-sig")
        request_dir = path.parent
        source = str(path)
    try:
        request = json.loads(content)
    except json.JSONDecodeError as error:
        raise SkillError(f"Invalid request JSON in {source}:{error.lineno}:{error.colno}: {error.msg}") from None
    if not isinstance(request, dict):
        raise SkillError("Request JSON must be an object")
    return request, request_dir


def command_generate(args: argparse.Namespace, settings: Settings) -> int:
    raw_request, request_dir = load_request_file(args.request)
    prepared = prepare_request(raw_request, request_dir)

    if args.dry_run:
        placeholders = [f"dry-run-input-{index + 1}.png" for index in range(len(prepared.input_images))]
        workflow = patch_workflow(prepared, placeholders)
        emit_json(
            {
                "ok": True,
                "dry_run": True,
                "mode": prepared.mode,
                "model": prepared.model_profile.name,
                "workflow": prepared.model_profile.workflow,
                "node_count": len(workflow),
                "seed": prepared.seed,
                "input_images": [str(path) for path in prepared.input_images],
                "output_dir": str(prepared.output_dir),
            }
        )
        return 0

    client = ComfyClient(settings)
    uploaded_images: list[str] = []
    for index, image_path in enumerate(prepared.input_images, 1):
        progress(f"Uploading input image {index}/{len(prepared.input_images)}: {image_path.name}")
        uploaded_images.append(client.upload_image(image_path))

    workflow = patch_workflow(prepared, uploaded_images)
    progress(f"Submitting {prepared.mode} workflow to ComfyUI")
    prompt_id = client.submit(workflow)
    progress(f"Submitted prompt_id={prompt_id}")
    record = client.wait_for_history(prompt_id, timeout=prepared.timeout)
    items = output_items(record)
    if not items:
        raise SkillError(f"ComfyUI completed prompt {prompt_id} but returned no downloadable output files")

    job_output_dir = prepared.output_dir / prompt_id
    downloaded: list[str] = []
    for item in items:
        path = client.download_output(item, job_output_dir)
        downloaded.append(str(path))
        progress(f"Downloaded: {path}")

    emit_json(
        {
            "ok": True,
            "mode": prepared.mode,
            "model": prepared.model_profile.name,
            "workflow": prepared.model_profile.workflow,
            "prompt_id": prompt_id,
            "seed": prepared.seed,
            "outputs": downloaded,
        }
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env",
        default=str(DEFAULT_ENV),
        help="Path to .env configuration (default: skill-root .env)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("health", help="Test authenticated ComfyUI connectivity")
    subparsers.add_parser("validate", help="Validate bundled workflow JSON and node mappings")
    subparsers.add_parser("models", help="List configured model profiles")

    generate = subparsers.add_parser("generate", help="Generate and download media")
    generate.add_argument("--request", required=True, help="UTF-8 request JSON path, or - for stdin")
    generate.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and patch the workflow without contacting ComfyUI",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "validate":
            result = validate_workflows()
            emit_json(result)
            return 0 if result["ok"] else 2
        if args.command == "models":
            emit_json(list_models())
            return 0

        settings = Settings.load(Path(args.env).expanduser().resolve())
        if args.command == "health":
            result = ComfyClient(settings).health()
            emit_json(result)
            return 0 if result["ok"] else 2
        if args.command == "generate":
            return command_generate(args, settings)
        parser.error("Unknown command")
    except (SkillError, OSError) as error:
        emit_json({"ok": False, "error": str(error)})
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
