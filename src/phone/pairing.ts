// ============================================================================
// = 配对：deviceToken 管理 + QR 内容                                          =
// 原始 AHP token 永不出电脑；手机只持自己的 deviceToken。                      =
// 每台设备一个 token，持久化到 %USERPROFILE%\.pocket-copilot\devices.json。    =
// ============================================================================

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEVICES_FILE } from '../config.js';

/** 已知设备（name 仅作展示，鉴权只看 token） */
interface DeviceRecord {
  token: string;
  name: string;
  createdAt: string;
}

let cache: DeviceRecord[] | null = null;

async function load(): Promise<DeviceRecord[]> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(DEVICES_FILE, 'utf8');
    const parsed = JSON.parse(raw) as DeviceRecord | DeviceRecord[];
    // 兼容两种历史格式：数组（新）或单个设备对象（旧版单设备）。
    if (Array.isArray(parsed)) {
      cache = parsed;
    } else if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string') {
      cache = [parsed];
    } else {
      cache = [];
    }
  } catch {
    cache = [];
  }
  return cache;
}

async function save(devices: DeviceRecord[]): Promise<void> {
  cache = devices;
  await fsp.mkdir(path.dirname(DEVICES_FILE), { recursive: true });
  await fsp.writeFile(DEVICES_FILE, JSON.stringify(devices, null, 2), 'utf8');
}

/** 校验 deviceToken 是否有效 */
export async function verifyDeviceToken(token: string): Promise<boolean> {
  if (!token) return false;
  const devices = await load();
  return devices.some((d) => d.token === token);
}

/**
 * 注册一台设备，返回 deviceToken。
 * 若 token 已存在（重复扫码）直接复用，不重复添加。
 */
export async function registerDevice(name: string): Promise<string> {
  const devices = await load();
  const existing = devices.find((d) => d.name === name);
  if (existing) return existing.token;
  const token = crypto.randomBytes(24).toString('hex');
  devices.push({ token, name, createdAt: new Date().toISOString() });
  await save(devices);
  return token;
}

/** 生成 QR 内容（Android deep link 解析后连 ws://<host>:<port>/ws 发 hello） */
export function qrPayload(host: string, port: number, deviceToken: string): string {
  return `pocket-copilot://pair?host=${encodeURIComponent(host)}&port=${port}&device=${deviceToken}`;
}
