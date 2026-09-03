/**
 * ModelNameStore：从 VS Code BYOK/customendpoint 模型注册表读取模型权威名。
 *
 * 背景：jsonl 会话头 `selectedModel.metadata.name` 是会话创建时缓存的基础名
 * （如 "Qwen 3.8 27B"），不含用户在注册表里加的展示后缀（如 "DEV"）。VS Code
 * UI 显示的权威名在 `chatLanguageModels.json`（全局静态文件）。
 *
 * 映射键：`selectedModel.identifier`，格式 `vendor/providerName/modelId`
 * （如 `customendpoint/Heimdall/Qwen3.8-27B`）。用完整 identifier 作 key 而非
 * 仅 vendor+modelId，是因为同一 vendor 下可有多个 provider 暴露同名 modelId
 * （实测 Heimdall 与 DEV 两个 provider 都有 customendpoint/Qwen3.8-27B），
 * 只有 identifier 能无歧义区分。
 *
 * 设计原则：独立数据源，可失败降级（文件缺失/格式变化静默返回 undefined）。
 */
import fsp from 'node:fs/promises';
import { CHAT_LANGUAGE_MODELS_FILE } from './config.js';
import type { ModelChoice } from './types.js';

/** 注册表结构：provider 数组，每个含 vendor + models[] */
interface RegistryModel {
  id?: string;
  name?: string;
  supportsReasoningEffort?: string[];
}
interface RegistryProvider {
  name?: string;
  vendor?: string;
  models?: RegistryModel[];
}

/** 解析注册表内容 → identifier → 权威名 映射 */
export function buildModelNameMap(content: string): Map<string, string> {
  const map = new Map<string, string>();
  let providers: RegistryProvider[];
  try {
    providers = JSON.parse(content) as RegistryProvider[];
  } catch {
    return map;
  }
  if (!Array.isArray(providers)) return map;
  for (const p of providers) {
    if (!p.vendor || !p.name) continue;
    for (const m of p.models ?? []) {
      if (!m.id || !m.name) continue;
      map.set(`${p.vendor}/${p.name}/${m.id}`, m.name);
    }
  }
  return map;
}

/** 解析注册表内容 → 模型选项列表（identifier / name / supportsReasoningEffort） */
export function buildModelList(content: string): ModelChoice[] {
  const out: ModelChoice[] = [];
  let providers: RegistryProvider[];
  try {
    providers = JSON.parse(content) as RegistryProvider[];
  } catch {
    return out;
  }
  if (!Array.isArray(providers)) return out;
  for (const p of providers) {
    if (!p.vendor || !p.name) continue;
    for (const m of p.models ?? []) {
      if (!m.id || !m.name) continue;
      out.push({
        identifier: `${p.vendor}/${p.name}/${m.id}`,
        name: m.name,
        supportsReasoningEffort: m.supportsReasoningEffort,
      });
    }
  }
  return out;
}

export class ModelNameStore {
  private names = new Map<string, string>();
  private modelList: ModelChoice[] = [];
  private timer?: NodeJS.Timeout;
  /** 映射变化时回调（供 server 触发 session_list 重推） */
  onChange?: () => void;

  /** 全量重建（读注册表文件） */
  async refresh(): Promise<void> {
    let content: string;
    try {
      content = await fsp.readFile(CHAT_LANGUAGE_MODELS_FILE, 'utf8');
    } catch {
      return; // 文件缺失：保持现状（降级）
    }
    const nextNames = buildModelNameMap(content);
    const nextList = buildModelList(content);
    if (sameMap(this.names, nextNames) && listKey(this.modelList) === listKey(nextList)) return;
    this.names = nextNames;
    this.modelList = nextList;
    this.onChange?.();
  }

  /** 按 identifier 查权威名；无则 undefined（调用方回退 metadata.name） */
  get(identifier: string): string | undefined {
    return this.names.get(identifier);
  }

  /** 全量模型选项列表（供前端模型下拉 + thinking 档位） */
  list(): ModelChoice[] {
    return this.modelList;
  }

  /** 按 identifier 查模型选项（写路径匹配 UIA 选项用） */
  getChoice(identifier: string): ModelChoice | undefined {
    return this.modelList.find((m) => m.identifier === identifier);
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 30 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** 模型列表签名（identifier+name+effort），用于变更检测 */
function listKey(list: ModelChoice[]): string {
  return list
    .map((m) => `${m.identifier}|${m.name}|${(m.supportsReasoningEffort ?? []).join(',')}`)
    .join(';');
}
