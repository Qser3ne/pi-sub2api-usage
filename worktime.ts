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

export function createWorktimeTracker(now: () => number = Date.now) {
  let totalMs = 0;
  let runStartTs: number | null = null;

  const settle = (): boolean => {
    if (runStartTs === null) return false;
    totalMs += Math.max(0, now() - runStartTs);
    runStartTs = null;
    return true;
  };

  return {
    reset(restoredTotal = 0): void {
      totalMs = restoredTotal;
      runStartTs = null;
    },
    start(): void {
      settle(); // 防重叠：上一段未结算先结算
      runStartTs = now();
    },
    settle,
    get totalMs(): number {
      return totalMs;
    },
    get isRunning(): boolean {
      return runStartTs !== null;
    },
    currentRunMs(): number {
      return runStartTs === null ? 0 : Math.max(0, now() - runStartTs);
    },
  };
}

export type WorktimeTracker = ReturnType<typeof createWorktimeTracker>;
