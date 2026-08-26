/**
 * worktime — 统计当前会话中模型的工作时长。
 * 只累计 agent 运行期（agent_start → agent_settled），空闲不计时。
 * 通过 /worktime 命令查询；累计值持久化到会话条目，resume 后延续。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "worktime";

/** 交互式工具：执行时会阻塞等待用户输入，计时在其执行期间暂停。 */
export const INTERACTIVE_TOOLS: ReadonlySet<string> = new Set(["ask_user_question"]);

/** 该工具执行期间是否应暂停计时。 */
export function pausesTiming(toolName: string): boolean {
  return INTERACTIVE_TOOLS.has(toolName);
}

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

/** 从会话条目中找最后一条 worktime 条目，返回其 totalMs；没有则返回 0。 */
function findPersistedTotal(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === ENTRY_TYPE) {
      const d = e.data as { totalMs?: unknown } | undefined;
      if (typeof d?.totalMs === "number") return d.totalMs;
    }
  }
  return 0;
}

export default function worktime(pi: ExtensionAPI) {
  const tracker = createWorktimeTracker();

  // 持久化当前累计值；失败只警告，不影响使用。
  const persist = (ctx: ExtensionContext): void => {
    try {
      pi.appendEntry(ENTRY_TYPE, { totalMs: tracker.totalMs });
    } catch (err) {
      try {
        ctx.ui.notify(`[worktime] 持久化失败: ${String(err)}`, "error");
      } catch {
        /* notify 本身失败时静默 */
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    tracker.reset(findPersistedTotal(ctx.sessionManager.getEntries()));
  });

  pi.on("agent_start", async () => {
    tracker.start();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (tracker.settle()) persist(ctx);
  });

  // 交互式工具开始阻塞等用户时先结算并落盘（暂停计时），避免把用户思考时间算进工作时长。
  pi.on("tool_call", async (event, ctx) => {
    if (pausesTiming(event.toolName) && tracker.settle()) persist(ctx);
  });

  // 工具返回后恢复计时；若运行已被中止（已空闲）则不恢复。
  pi.on("tool_result", async (event, ctx) => {
    if (!pausesTiming(event.toolName)) return;
    if (!ctx.isIdle()) tracker.start();
  });

  // 兜底：任务中途退出（quit/reload/new/resume/fork）也把未结算段写入。
  pi.on("session_shutdown", async (_event, ctx) => {
    if (tracker.settle()) persist(ctx);
  });

  pi.registerCommand("worktime", {
    description: "查看本会话模型工作时长",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      if (tracker.totalMs > 0 || tracker.isRunning) {
        lines.push(`⏱ 本会话模型工作时长: ${formatDuration(tracker.totalMs)}`);
      } else {
        lines.push("⏱ 本会话还没有模型工作记录");
      }
      if (tracker.isRunning) {
        lines.push(`   当前已连续工作 ${formatDuration(tracker.currentRunMs())}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
