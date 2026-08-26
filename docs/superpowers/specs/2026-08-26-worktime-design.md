# worktime 扩展设计文档

- 日期：2026-08-26
- 状态：已批准（方案 C）

## 目标

实现一个 Pi 扩展，统计**当前会话**中模型的工作时长。只累计模型实际工作的时间段；用户思考、空闲等待不计入。

## 需求（已与用户确认）

1. 「模型在工作」= 整个 agent 运行期：从用户提交消息到本轮完全结束（`agent_start` → `agent_settled`），包括流式生成、工具调用执行、自动重试和压缩重试。
2. 展示方式：仅通过 `/worktime` 命令查询，不使用状态栏 / widget。
3. 持久化：通过 `pi.appendEntry()` 写入会话文件，pi 重启后 `/resume` 能延续累计值。
4. 统计范围：仅当前会话，不做跨会话汇总。

## 架构

单文件 TypeScript 扩展 `worktime.ts`，无 npm 依赖，导出默认工厂函数。

核心是两段式计时器：

```
agent_start ──► 记录 runStartTs = Date.now()
                    │
agent_settled ──► totalMs += now - runStartTs; runStartTs = null
                    │
                    └─► pi.appendEntry("worktime", { totalMs })  持久化累计值
```

### 状态

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalMs` | `number` | 会话内模型工作的累计毫秒数 |
| `runStartTs` | `number \| null` | 当前运行段的起始时间戳；`null` 表示空闲 |

### 事件处理

| 事件 | 行为 |
|------|------|
| `session_start` | 重置内存状态；遍历 `ctx.sessionManager.getEntries()`，取最后一条自定义类型为 `"worktime"` 的条目恢复 `totalMs` |
| `agent_start` | 若 `runStartTs !== null`（防重叠），先按 `agent_settled` 逻辑结算旧段；然后记录新 `runStartTs` |
| `agent_settled` | 结算：`totalMs += now - runStartTs`，置空 `runStartTs`，写入持久化条目 |
| `session_shutdown` | 兜底：若仍有未结算段（如任务中途退出），先结算再写入条目 |

### 命令

`/worktime`：
- 空闲时显示：`⏱ 本会话模型工作时长: X小时Y分Z秒`
- 运行中时附加一行当前段的实时时长
- 无任何记录时提示尚未开始计时

### 持久化格式

自定义会话条目：`customType = "worktime"`，data 为 `{ totalMs: number }`。
每次结算覆盖式追加一条新条目，加载时只认最后一条，无需更新旧条目。

## 错误处理

- 所有持久化写入用 try/catch 包裹，失败时 `ctx.ui.notify` 警告但不中断正常使用。
- 计时逻辑为纯数值运算，不会抛错。
- 防重叠保护保证 steering/follow-up 连续触发 `agent_start` 时不会重复或丢失计时段。

## 边界情况

- 任务运行中直接退出进程：由 `session_shutdown` 兜底结算（SIGKILL 级强杀除外，接受少量丢失）。
- `/new`、`/resume`、`/fork`：`session_shutdown` → `session_start` 流程天然重置/恢复状态。
- print 模式（`-p`）：命令不可用但计时无害。

## 测试方式

手动验证清单：

1. 新会话发一个真实任务，完成后 `/worktime`，数值应接近任务实际耗时且小于会话总时长。
2. 空闲放置 1 分钟后再查询，数值不变（验证空闲不计时）。
3. 退出 pi 后 `/resume` 同一会话，`/worktime` 显示之前的累计值；继续工作后能累加。
4. 在任务运行中执行 `/worktime`，能看到当前段实时时长。
