---
name: chat-with-comfy
description: Generate or edit images and generate videos through the user's configured ComfyUI API workflows. Use when the user asks to create, transform, render, or generate an image or video, including Qwen Image 2.1 image editing and MiniMax H3 video requests.
---

# Comfy Media Generation

Generate the requested media with the bundled ComfyUI API workflows and return the downloaded local artifacts to the user.

## Route the Request

- Image from text, with no input image: `t2i`.
- Image from one or two input images: `i2i`; it always produces one image.
- Video from text, with no input image: `t2v`.
- Video beginning from one supplied image: `i2v`.
- Video guided by one to nine supplied reference images: `r2v`.

The available model profiles and their workflows are defined in `api/models.json`. Omit `model` to use the mode's default profile. When the user names a model, asks which models are available, or needs a newly configured model, run `python scripts/comfy_media.py models`, verify that its mode fits the request, and include its exact profile name as the request's `model` field. See `references/model-config.md` for the extensible profile schema.

Do not silently reinterpret a reference image as a first frame. If the role is unclear, ask whether it is a starting frame (`i2v`) or a general identity/style/content reference (`r2v`).

## Collect Required Choices

Before generation, ask one concise combined question for every applicable value the user did not specify. Do not choose defaults, infer them from the prompt, or start generation until these choices are explicit:

- `t2i`: exact pixel `width` and `height`.
- `i2i`: one or two readable local input-image paths in intended `<image1>` then `<image2>` order, plus the intended role of each image. `<image1>` is the primary reference; output dimensions follow it rounded to multiples of 32.
- Any video: `duration` from 5 to 15 seconds, `aspect_ratio`, and target `megapixels`.
- `i2v`: one readable local input-image path and confirmation that it is the first frame.
- `r2v`: one to nine readable local reference-image paths and the intended role of each.

Accepted video ratios are `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, and `21:9`. Seed, batch size, output location, and filename prefix may retain the workflow/script behavior unless the user asks to control them.

## Rewrite Video Prompts When Required

Run `python scripts/comfy_media.py models` before preparing a video request when its chosen profile is not already known. If the profile's `prompt_format` is `h3_base` or `h3_reference`, first use the bundled `h3-prompt-writing` skill:

1. Read `h3-prompt-writing/SKILL.md` completely.
2. For `h3_base`, follow its base-mode reference. For `h3_reference`, follow its full-reference guide.
3. Give the rewrite the chosen duration and the role/order of every reference image.
4. Preserve the complete rewritten English structure as the Comfy request's `prompt`; do not shorten it back to the user's original prompt.

When `prompt_format` is `plain`, send a direct prompt without an H3 rewrite. For `i2i`, write a direct edit/generation instruction that identifies inputs by their ordered labels (`<image1>`, `<image2>`) and states how each should influence the single result.

## Generate

Read [references/request-schema.md](references/request-schema.md) when preparing or running a request. Use `scripts/comfy_media.py`; do not manually edit the workflow JSON or hand-roll HTTP calls.

1. Run `python scripts/comfy_media.py health` when connection/authentication has not been verified in the current environment.
2. Build a temporary UTF-8 request JSON containing all required user choices and the final prompt.
3. Optionally run `python scripts/comfy_media.py generate --request <request.json> --dry-run` to validate routing and workflow patching without contacting ComfyUI.
4. Run `python scripts/comfy_media.py generate --request <request.json>` and wait for completion. Video generation can take a long time; keep the user updated according to the host agent's progress-message conventions.
5. Parse the final JSON result and present every absolute path in `outputs` to the user. Embed generated images when the client supports local image display; provide clickable links for videos and all fallback cases.

Do not expose `.env` values, auth headers, cookies, passwords, or API tokens in messages or logs. A submitted generation is a potentially expensive external action; retry at most once for a clearly transient transport failure, and never automatically retry a job that may already have entered the Comfy queue.
