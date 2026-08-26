# pi-custom-extensions

自定义 pi 扩展集合。

## 结构约定

- 每个扩展一个顶层目录，入口为目录下唯一的顶层 `.ts` 文件（优先 `<目录名>/<目录名>.ts`）
- `install.sh` 把所有扩展软链到 `~/.pi/agent/extensions/`（改代码立即生效）

## 当前扩展

| 目录 | 功能 |
|------|------|
| `start-for-finish/` | worktime：统计会话中模型工作时长（`/worktime` 查询） |
| `bell-on-done/` | agent 完成响应时响铃 |

## 安装

```bash
./install.sh
```
