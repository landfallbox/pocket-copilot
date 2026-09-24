# Request Schema and Commands

The runner reads the repository-root `.env` by default. Override it only when the user supplies another configuration file:

```text
python scripts/comfy_media.py --env path/to/.env health
python scripts/comfy_media.py --env path/to/.env generate --request path/to/request.json
```

## Environment

`Comfy_BASE_URL` and `Comfy_API_KEY` are required. The runner sends the key as `Authorization: Bearer <token>` for all API requests, uploads, and downloads. Use a direct-API token, not a web-login password. Session cookies and other authentication modes are no longer read.

Uppercase `COMFY_*` spellings are also accepted. Process environment variables override `.env` values.

## JSON Fields

Shared fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `mode` | yes | `t2i`, `i2i`, `t2v`, `i2v`, or `r2v` |
| `model` | no | Configured model profile name. Omit to use that mode's default profile; run `python scripts/comfy_media.py models` to list choices. |
| `prompt` | yes | Image prompt, raw video prompt, or complete H3 rewrite, depending on the selected model profile's `prompt_format` |
| `seed` | no | Integer seed; a random seed is chosen when omitted |
| `batch_size` | no | Text-to-image output count; defaults to 1 |
| `filename_prefix` | no | Safe relative Comfy output prefix |
| `output_dir` | no | Local download directory; defaults to `outputs/` in the skill |
| `timeout` | no | Wait timeout in seconds; defaults to 3600 |

Mode-specific fields:

| Mode | Required fields |
| --- | --- |
| `t2i` | integer `width`, integer `height` |
| `i2i` | `input_images` containing one or two image paths, ordered as `<image1>` then `<image2>` |
| `t2v` | `duration` from 5 to 15 seconds, `aspect_ratio`, `megapixels` |
| `i2v` | `duration` from 5 to 15 seconds, `aspect_ratio`, `megapixels`, `input_images` containing exactly one first-frame path |
| `r2v` | `duration` from 5 to 15 seconds, `aspect_ratio`, `megapixels`, `input_images` containing one to nine reference-image paths |

Paths in `input_images` are resolved relative to the request JSON file. `output_dir`, when relative, is resolved relative to the skill root.

For Qwen `i2i`, `<image1>` is the primary reference and supplies the output dimensions, rounded to multiples of 32. The runner removes the second image connection and loader when only one image is supplied, keeps the workflow batch size at one, and produces one output image. Describe each image's role explicitly in `prompt`.

### Text-to-image example

```json
{
  "mode": "t2i",
  "prompt": "A quiet snow-covered observatory at blue hour",
  "width": 1344,
  "height": 768
}
```

### Multi-image-to-image example

```json
{
  "mode": "i2i",
  "prompt": "Use <image1> as the composition and lighting reference. Replace its subject with the person from <image2>, preserving the person's facial identity, hairstyle, and clothing details.",
  "input_images": ["inputs/scene.png", "inputs/person.png"]
}
```

### Text-to-video example

The shortened placeholder below must be replaced with the complete H3 rewrite before execution.

```json
{
  "mode": "t2v",
  "prompt": "integrated_multimodal_description: ...\n\noverall_soundscape: ...\n\nnon_diegetic_music: ...",
  "duration": 5,
  "aspect_ratio": "16:9",
  "megapixels": 0.4
}
```

### Image-to-video example

```json
{
  "mode": "i2v",
  "prompt": "For the target video, at 0.00 seconds ...",
  "duration": 5,
  "aspect_ratio": "9:16",
  "megapixels": 0.4,
  "input_images": ["inputs/first-frame.png"]
}
```

### Reference-to-video example

```json
{
  "mode": "r2v",
  "prompt": "subject_definitions:\n...\n\nsummary:\n...\n\nretention_analysis:\n...\n\ndetailed_description:\n...\n\noverall_soundscape:\n...\n\nnon_diegetic_music:\n...",
  "duration": 5,
  "aspect_ratio": "16:9",
  "megapixels": 0.4,
  "input_images": ["inputs/character.png", "inputs/environment.png"]
}
```

The command prints progress to stderr and one machine-readable JSON object to stdout. A successful result includes `prompt_id`, the effective `seed`, and absolute downloaded artifact paths in `outputs`.

## Extending models

Model profiles, their workflow files, and node/input bindings are defined in `api/models.json`. To add a new ComfyUI model, add a compatible API-format workflow under `api/`, register its profile, then run:

```text
python scripts/comfy_media.py models
python scripts/comfy_media.py validate
```

See [model-config.md](model-config.md) for the profile schema, inheriting an existing profile, and examples for every supported mode.
