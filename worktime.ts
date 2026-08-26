/**
 * worktime — 统计当前会话中模型的工作时长。
 * 只累计 agent 运行期（agent_start → agent_settled），空闲不计时。
 * 通过 /worktime 命令查询；累计值持久化到会话条目，resume 后延续。
 */

/** 把毫秒格式化为「X小时Y分Z秒」。 */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}小时`);
  if (h > 0 || m > 0) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return parts.join("");
}
