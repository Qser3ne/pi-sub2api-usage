# pi-sub2api-usage 设计文档

日期：2026-10-10
状态：已确认（用户已拍板四项待确认项，见"已确认的决定"）

## 意图与背景（为什么做）

用户通过 sub2api（Wei-Shaw/sub2api，订阅转 API 网关）使用 Claude / GPT 订阅：models.json
中定义了自定义 provider（`sub2api-gpt`、`sub2api-claude`），模型请求经 sub2api 实例转发。
`@narumitw/pi-usage` 的适配器注册表不认识这些自定义 provider，无法报告其真实用量。

本扩展在状态栏中 pi-usage 显示用量的位置，改为显示从 sub2api 用户接口查询到的用量
（各平台的日/周/月 USD 额度窗口、已用比例、重置倒计时），观感与 pi-usage 的 chip 一致。

## 目标

1. models.json 中标记 `sub2api: true` 的 provider 被选中为当前模型时，状态栏显示 sub2api 用量 chip。
2. 兼容 `@narumitw/pi-statusline`：通过 `ctx.ui.setStatus()` 发布，由 pi-statusline 渲染。
3. sub2api 的连接参数（token、路由、请求方式）可配置，不写死。
4. 与 pi-usage 共存：非标记 provider 时本扩展不显示任何内容，pi-usage 照常工作；两者零写冲突。

## 非目标

- 不实现 `/usage` 式交互菜单（pi-usage 已有；本扩展首版只做状态栏 chip + 一个 `/sub2api-usage`
  命令用于手动刷新/查看原始数据——命令为低优先级，可砍）。
- 不支持多个 sub2api 实例（单实例、单 token；用户两个 provider 指向同一实例）。
- 不在本地统计 token 消耗，只展示服务端权威数据。

## 反目标（做成了就算失败）

- 干扰 pi-usage：绝不写入 `"usage"` key（那是 pi-usage 的领地）。
- 高频打接口：没有缓存 TTL 与失败退避就上线。
- chip 文本超长撑爆状态栏（截断规则必须存在）。

## 约束

- pi 扩展机制：TypeScript 模块，`export default function (pi: ExtensionAPI)`；本地包通过
  `pi install <dir>` 安装，pi 直接加载 TS（无需构建发 npm）。
- 运行时 Node 22（全局 fetch / AbortController 可用）。
- 不修改 pi-usage / pi-statusline 的安装代码。
- 状态 key 独立（`sub2api-usage`），`📊` 图标内嵌在值首（pi-statusline 的
  `splitExtensionStatusIcon` 会解析值内前导图标，未知 key 也能带图标显示）。
- HTTP 超时 15s（与 pi-usage 的 DEFAULT_TIMEOUT_MS 一致）。

## 配置设计

### 1. models.json provider 标记（触发条件）

```json
"sub2api-gpt": {
  "baseUrl": "http://43.159.131.239:8080/v1",
  "api": "openai-responses",
  "sub2api": true,
  "models": [ ... ]
}
```

- `"sub2api": true` 的语义（已确认键名）：该 provider 的用量由本扩展经 sub2api 接口报告。
- 平台映射自动推导：`api === "anthropic-messages"` → `anthropic`；`api` 以 `openai` 开头 →
  `openai`；其余（gemini 等）需在设置文件的 `platformMap` 显式映射。
- 读取方式：直接读 `~/.pi/agent/models.json`（pi-usage 同样直接读自己的设置文件，属常规做法）。
  文件读取失败/解析失败视为"无标记 provider"，静默降级。

### 2. `~/.pi/agent/pi-sub2api-usage.json`（连接与行为）

```json
{
  "baseUrl": "http://43.159.131.239:8080",
  "email": "you@example.com",
  "password": "<面板登录密码>",
  "token": "<可选：手动粘贴的 access token，优先于自动登录>",
  "route": "/api/v1/user/platform-quotas",
  "method": "GET",
  "platformMap": { "sub2api-claude": "anthropic" },
  "refreshMs": 300000
}
```

- `baseUrl`：可选。缺省从当前 provider 的 baseUrl 推导（去掉尾部 `/v1`、`/v1/...` 段）。
- 凭据（二选一，都缺 → `📊 <provider> no credentials`）：
  - `token`：手动粘贴的 access token（调试/降级用）。存在时直接使用、不自动续期。
  - `email` + `password`：面板账号密码。access token 过期时自动调登录接口换新（见下节）。
- 密码/手写 token 属敏感信息：设置文件写入时提醒 chmod 600（安装脚本/README 注明；扩展自身只在
 首次创建时设置权限，不重写用户手写文件）。
- `route` / `method`：用户明确要求可配置（默认 GET /api/v1/user/platform-quotas）。method 仅
  支持 GET/POST（POST 时 body 为空对象）。
- `platformMap`：providerId → platform 的显式覆盖，优先于自动推导。
- `refreshMs`：缓存 TTL，默认 300000（5 分钟）。
- 文件损坏：显示一次 warning 通知（session_start 时），并按默认值+无凭据处理。

### 3. token 生命周期（已确认：账号密码自动登录）

登录契约（已从源码核实，auth_handler.go / routes/auth.go）：

- `POST {baseUrl}/api/v1/auth/login`，body `{"email": "...", "password": "..."}`，
  无需验证码字段（实例未开启 Turnstile/腾讯验证码时直接通过）。
- 限流：20 次/分钟/IP。本扩展的登录频率 ≈ 每_ACCESS token 过期一次（默认 24h），安全。
- 响应 `data`：成功 `{access_token, refresh_token, expires_in(秒), token_type:"Bearer", user}`；
  账号开了 TOTP 2FA 时 `{requires_2fa: true, temp_token, ...}`——检测到 `requires_2fa`
  立即报错 `auth: 2FA not supported`（不支持后续 2FA 流程）。
- 登录 = 独立新会话，与浏览器面板互不影响（不使用 refresh token，避开单次轮转+家族撤销
  的互踢问题）。丢弃登录返回的 refresh_token，仅用 access_token。

运行时策略：

- access token 缓存到 `~/.pi/agent/pi-sub2api-usage-cache.json`（chmod 600），记
  `expires_at`；剩余有效期 > 60s 直接复用，否则登录换新。
- 用量请求收到 401（TOKEN_EXPIRED/INVALID_TOKEN）→ 丢弃缓存 token，重新登录一次并重试
  （single-flight，防并发重复登录）。
- 所有请求（登录+用量）发同一固定 `User-Agent: pi-sub2api-usage/<version>`，保证指纹一致
  （若实例开启 session binding，同 IP+同 UA 的一致性可满足）。

前置条件（实例侧，开发时用真实凭据 curl 实测确认；不满足时给出明确错误提示）：

- 实例未开启登录验证码（Turnstile/腾讯）；若开启，自动登录不可行，退化为手写 token 模式。
- 账号未开 TOTP 2FA；实例未开 backend mode（或用管理员账号）。

## sub2api 接口契约（已从源码核实）

请求：`GET {baseUrl}/api/v1/user/platform-quotas`，头 `Authorization: Bearer <token>`。

响应信封：`{ "code": 0, "message": "success", "data": { "platform_quotas": [ ... ] } }`，
`code !== 0` 或 HTTP 非 2xx 视为失败。

`platform_quotas[]` 每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `platform` | string | `anthropic` / `openai` / `gemini` / `antigravity` / `grok` / `kimi` / `zhipu` / `deepseek` / `minimax` |
| `daily_usage_usd` / `weekly_*` / `monthly_*` | number | 窗口已用（USD）；过期窗口服务端已归零 |
| `daily_limit_usd` / `weekly_*` / `monthly_*` | number \| null | 窗口限额；null=未设限 |
| `*_window_resets_at` | string(RFC3339) \| null | 窗口重置时刻；null=窗口已过期/无 |

按 `platform` 过滤出当前 provider 对应的一条记录；找不到记录时显示
`📊 <provider> no quota`。

## 显示设计

chip：key = `sub2api-usage`，值内嵌图标。示意：

```
📊 sub2api-gpt 62% ↻ 4h12m · wk 31% · mo 12%
```

- 主窗口（日）：百分比 = `daily_usage_usd / daily_limit_usd`；`limit` 为 null 时显示 `$1.24`
  （已用金额）。
- `↻ 4h12m`：主窗口的重置倒计时（从 `daily_window_resets_at` 计算）。
- `wk 31%`、`mo 12%`：周/月窗口百分比（无限额则 `wk $3.2`）。
- 中间态：查询中 `📊 sub2api-gpt checking`；失败 `📊 sub2api-gpt error: <截断至40字符>`（用
  `error:` 前缀而非 `err:`，以稳定命中 pi-statusline `extensionColor` 的警示色正则
  `/missing|error|fail|conflict|duplicate|unavailable/`）；401/403 → `auth failed`。
- 值整体截断上限 80 字符（防御性，正常不会触达）。
- pi-statusline 每行最多渲染 5 个 extension chip（`formatExtensionStatuses` 的
  `slice(0, 5)`）；本扩展只发布一个 chip，但用户环境中 pi-usage chip + 其他扩展 chip
  并存时有被裁掉的可能（备忘，不做处理）。
- 文本色/警示色由 pi-statusline 的 `extensionColor(key, value)` 决定（含 "err" 会转 warning 色）。

（显示哪些窗口、命名风格，见"待用户确认"节。）

## 运行时行为

事件对齐 pi-usage 的刷新时机：

- `session_start` / `session_tree` / `model_select` / `turn_start`：触发刷新（带缓存判断）。
- 刷新流程：当前 provider 无标记 → `setStatus(key, undefined)` 清除，结束；有标记 →
  缓存新鲜则直接发布，否则发请求。
- 缓存：TTL `refreshMs`（默认 5 分钟），key 为 `providerId:platform`。
- 失败退避：30s 内不重试（与 pi-usage FAILURE_BACKOFF_MS 一致）。
- 倒计时重绘：chip 中含 `↻` 时每 60s 重新格式化发布（重算倒计时文本，不打接口）。
- `session_shutdown`：清全部定时器、控制器，`setStatus(key, undefined)`。
- 旧上下文保护：所有异步发布前检查会话代次（generation 计数），过期丢弃（参考 pi-usage 的
  statusGeneration 模式，简化版）。

## 组件结构

```
pi-sub2api-usage/            # 仓库根（本 repo）
├── package.json             # name: pi-sub2api-usage；pi 扩展声明（main 或 pi.extensions）
├── tsconfig.json
├── src/
│   ├── index.ts             # 扩展入口：事件绑定、刷新调度、状态发布
│   ├── settings.ts          # 读 models.json 标记 + pi-sub2api-usage.json，归一化
│   ├── auth.ts              # 登录换 token、token 缓存文件、401 重试（single-flight）
│   ├── sub2api.ts           # 用量 HTTP 客户端：fetch、信封解析、platform_quotas 过滤
│   ├── format.ts            # chip 文本格式化（百分比、倒计时、截断）
│   └── statusline.ts        # setStatus 发布、代次管理、定时器
├── test/                    # node:test 单元测试
│   ├── settings.test.ts
│   ├── auth.test.ts         # 登录/缓存/401 重试，注入 fetch mock
│   ├── sub2api.test.ts      # 信封/配额/错误路径，注入 fetch mock
│   └── format.test.ts
└── docs/superpowers/specs/  # 本文档
```

无第三方运行时依赖（仅 `@earendil-works/pi-coding-agent` 的类型，devDependency）。

## 测试

- 单元：settings 归一化（缺字段/坏 JSON/平台推导/覆盖）、信封与配额解析（null limit、
  null resets、code!=0、HTTP 401/500、超时）、格式化（各窗口组合、无限额、过期、截断）。
- 集成（手动）：对真实实例 `curl -H "Authorization: Bearer …"` 核对响应；`pi -e ./` 临时
  挂载，切 provider（sub2api-gpt ↔ zai）观察 chip 出现/消失/不冲突；`pi list` 确认安装。

## 已确认的决定（用户 2026-10-10 拍板）

1. **token 生命周期**：账号密码自动登录（配置 email+password；手写 token 作为可选优先
   降级通道）。
2. **显示格式**：全窗口显示 `📊 <provider> 62% ↻ 4h12m · wk 31% · mo 12%`（限额缺失时
   退化为已用金额 `$6.2`）。
3. **显示范围**：仅当前 provider（与 pi-usage 行为一致）。
4. **标记键名**：`"sub2api": true`。

## 留给实现者的决定（builder 的）

- `setStatus(key, undefined)` 是否从 map 移除 key（影响 chip 顺序）——读 pi 源码验证即可。
- `platformMap` 与自动推导冲突时的优先级实现细节（文档已定：显式覆盖优先）。
- `/sub2api-usage` 命令是否进首版（默认：进，仅打印原始 JSON + 强制刷新，工作量小）。

---

## 修订 A（2026-10-10，用户指定）：数据源转向

联调时用户澄清：所需"用量"是**上游订阅账号的额度窗口**（管理后台 /admin/accounts 选中账号的"查询额度"），不是用户级平台限额。

- 数据源：`GET {baseUrl}/api/v1/admin/accounts/{id}/usage?source=passive|active`（管理员 JWT，登录流程复用 3 节）
- 响应：`data.five_hour` / `data.seven_day` 窗口，各含 `utilization`（已用百分比 0–100+）与 `resets_at`（RFC3339 或 null）
- 配置变化：settings 弃用 `platformMap`，新增 `accounts`（providerId → 账号 ID）与 `usageSource`（默认 passive，不打上游）；`route` 变为含 `{id}` 占位符的模板（保留"路由+请求方式可配置"）
- 显示格式改为复刻 pi-usage codex 风格：`📊 sub2api-claude 20% ↻ 4h12m 16% ↻ 3d13h`（5h 窗口 + 7d 窗口，各带 ↻ 倒计时；窗口为 null 时跳过该段，两者皆 null 显示 `no usage`）
- 实测：账号 3589（claude 自用，OAuth）返回真实数据；apikey 中继型账号（3569/3587/10/9）该接口 500，无窗口语义
