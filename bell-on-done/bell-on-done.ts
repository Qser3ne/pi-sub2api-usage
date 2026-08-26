// pi 扩展：agent 完成响应（agent_settled）时响铃
// 通过向本进程的控制终端写入 BEL(\x07)，由终端模拟器
// （WezTerm 的 bell 事件）负责播放提示音。
import * as fs from "node:fs";

function ringBell(): void {
	try {
		// pi 的 stdin 就是控制终端（TUI 模式），解析出真实 pty 路径
		const fd0 = fs.readlinkSync("/proc/self/fd/0");
		if (fd0.startsWith("/dev/pts/") || fd0.startsWith("/dev/tty")) {
			const fd = fs.openSync(fd0, "w");
			fs.writeSync(fd, "\x07");
			fs.closeSync(fd);
			return;
		}
	} catch {
		// fallthrough
	}
	// 兜底：直接写标准输出
	try {
		process.stdout.write("\x07");
	} catch {
		// 无终端可写时静默放弃
	}
}

export default function (pi: any) {
	pi.on("agent_settled", async () => {
		ringBell();
	});
}
