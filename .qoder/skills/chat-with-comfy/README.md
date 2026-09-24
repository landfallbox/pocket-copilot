# Chat with Comfy

## 与 LLM 对话，即可生成多模态图片和视频

不需要手动打开 ComfyUI、连接节点或编写工作流 JSON。只要把创作需求告诉支持该 skill 的 LLM，它会理解你的文字、图片与参考素材，选择合适的 ComfyUI 工作流并返回生成结果。

```text
你：生成一张 1024×1024 的赛博朋克猫咪侦探海报。
LLM：调用 Chat with Comfy → ComfyUI 生成图片 → 返回本地图片路径。
```

你可以通过一次自然语言对话完成：

- 文生图、文生视频；
- 用一至两张图片进行编辑、合成或风格/身份参考；
- 指定一张图片作为视频首帧，或以多张参考图保持人物、场景与风格；
- 直接说明想用的已配置模型，或由 LLM 使用对应模式的默认模型。

LLM 只会在缺少生成所必需的信息时追问，例如图片尺寸、视频时长、画面比例或参考图的用途；确认后才提交 ComfyUI 任务。生成完成后会返回下载到本地的图片或视频文件路径。

通过自然语言对话调用已配置的 ComfyUI 工作流，生成或编辑图片、生成视频，并将下载后的本地文件路径返回给调用方。

本 skill 不是 ComfyUI 的安装器：它向一个已运行、已配置工作流节点的 ComfyUI 服务发送 API 请求。工作流位于 `api/`，请求、上传、轮询和下载由 `scripts/comfy_media.py` 完成。

## 能力

| 对话意图 | 工作流模式 | 使用的工作流 |
| --- | --- | --- |
| 纯文本生成图片 | `t2i` | `qwen_image_2_1_t2i.json` |
| 用 1–2 张图编辑/合成一张图片 | `i2i` | `qwen_image_2_1_i2i.json` |
| 纯文本生成视频 | `t2v` | `minimax_h3_t2v.json` |
| 由一张首帧图生成视频 | `i2v` | `minimax_h3_i2v.json` |
| 用 1–9 张参考图引导视频 | `r2v` | `minimax_h3_r2v.json` |

内置 MiniMax H3 视频模型会先按随附的 `h3-prompt-writing` 规范改写提示词。新 profile 可通过 `prompt_format: "plain"` 接收原始提示词。图片编辑时，`<image1>` 是主参考图，输出尺寸按主图对齐至 32 的倍数；第二张图使用 `<image2>`。

## 扩展模型

模型注册表位于 [`api/models.json`](api/models.json)。它将模型名、ComfyUI API-format 工作流、可写节点输入及默认文件名绑定在一起；脚本不再把这些映射写死在 Python 中。

新增与现有流程结构相同的模型时，只需在注册表增加继承项，通过 `overrides` 指向新模型文件；若使用全新工作流，则把 API-format JSON 放入 `api/` 并定义其 bindings。请求中添加 `"model": "模型名"` 即可选择它；省略时使用各 mode 的默认模型。

```powershell
python scripts/comfy_media.py models
python scripts/comfy_media.py validate
```

完整配置格式、节点映射要求和扩展示例见 [references/model-config.md](references/model-config.md)。

## 配置

1. 将 `.env.example` 复制为 `.env`，并填写 `Comfy_BASE_URL`。
2. 填写 `Comfy_API_KEY` Bearer token；不要把 `.env` 提交到版本库。
3. 在仓库根目录运行健康检查：

```powershell
python scripts/comfy_media.py health
```

脚本仅使用 Python 标准库。健康检查会验证服务连通性、认证状态，以及当前工作流所需的节点是否齐全。

### 认证说明

在 `.env` 中设置 `Comfy_API_KEY`，脚本统一发送 `Authorization: Bearer <token>`。使用直接 API token，不要填写网页登录密码。已移除 Session Cookie 和其他认证模式；旧认证变量不再读取。

支持大写 `COMFY_BASE_URL`、`COMFY_API_KEY`；进程环境变量优先于 `.env`。

## 在对话中使用

安装并启用这个 skill 后，直接描述目标即可。调用方会在缺少必要参数时提问，确认完整参数后才提交生成任务。

```text
生成一张 1344×768 的图片：蓝调时刻、覆雪天文台，电影感。
```

```text
用 inputs/scene.png 做构图和光线参考、用 inputs/person.png 替换画面人物；保留人物脸部、发型和服装细节。
```

```text
以 inputs/first-frame.png 作为第一帧，生成一段 5 秒、9:16、0.4 MP 的视频：镜头缓慢推进，人物回头微笑。
```

视频需要明确给出时长（5–15 秒）、画面比例和目标百万像素；`i2v` 还需要确认图片是首帧，`r2v` 则需要说明每张参考图的角色。支持的视频比例为 `1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`9:16`、`16:9` 和 `21:9`。

## 命令行使用

可直接传入请求 JSON。请求字段和完整示例见 [references/request-schema.md](references/request-schema.md)。先用 `--dry-run` 校验路由及工作流参数，不会联系 ComfyUI：

```powershell
python scripts/comfy_media.py generate --request request.json --dry-run
python scripts/comfy_media.py generate --request request.json
```

默认从仓库根目录的 `.env` 读取配置；可用 `--env path/to/.env` 指定其他文件。生成成功后，标准输出的 JSON 会包含 ComfyUI 的 `prompt_id`、实际 seed 和下载文件的绝对路径。相对的 `output_dir` 默认写入本仓库的 `outputs/`。

## 安全提示

不要在提示词、请求 JSON、终端输出或版本库中粘贴 API token、Cookie 或密码。若 ComfyUI 部署在公网，请使用 HTTPS；HTTP 会使认证信息和生成内容暴露在传输风险中。
