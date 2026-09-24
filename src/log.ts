// 统一日志输出：时间戳 + 模块 tag（诊断断连模式用）
export function log(tag: string, msg: string): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] [${tag}] ${msg}`);
}
