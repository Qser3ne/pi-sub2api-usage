import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "./statusline.ts";

export { createRuntime } from "./statusline.ts";

export default function sub2apiUsageExtension(pi: ExtensionAPI): void {
  const runtime = createRuntime({ agentDir: getAgentDir() });
  pi.on("session_start", (_event, ctx) => runtime.handleEvent(ctx, ctx.model));
  pi.on("session_tree", (_event, ctx) => runtime.handleEvent(ctx, ctx.model));
  pi.on("model_select", (event, ctx) => runtime.handleEvent(ctx, event.model));
  pi.on("turn_start", (_event, ctx) => runtime.handleEvent(ctx, ctx.model));
  pi.on("session_shutdown", (_event, ctx) => runtime.shutdown(ctx));
  pi.registerCommand("sub2api-usage", {
    description: "Force-refresh sub2api usage and show the raw quota payload",
    handler: async (_args, ctx) => {
      await runtime.runManualCheck(ctx);
    },
  });
}
