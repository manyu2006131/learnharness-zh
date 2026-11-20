import { spawn } from "node:child_process";
import { getClaudeBinary } from "./binary.ts";
import { inspectClaudeInstallation, readClaudeVersion, type ReadClaudeVersion } from "./installation.ts";
import type { RunClaude } from "./stream.ts";

export class ClaudeLaunchError extends Error {}

/** Injectable seams keep all verification offline; production uses the installed CLI. */
export function createClaudeLauncher({
	findBinary = getClaudeBinary,
	readVersion = readClaudeVersion,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	readVersion?: ReadClaudeVersion;
	spawnProcess?: typeof spawn;
} = {}): RunClaude {
	return async (args, options) => {
		if (options.signal?.aborted) throw new ClaudeLaunchError("请求已中止");
		const binary = findBinary();
		if (!binary) return null;
		const status = await inspectClaudeInstallation(() => binary, readVersion);
		if (status.state === "update-required") {
			throw new ClaudeLaunchError(`Claude Code ${status.version} requires an update. LearnHarness requires at least ${status.minimumVersion}; update Claude Code outside LearnHarness.`);
		}
		if (status.state !== "meets-minimum") {
			throw new ClaudeLaunchError("无法检查 Claude Code 版本。请在 LearnHarness 之外检查安装后重试。");
		}
		if (options.signal?.aborted) throw new ClaudeLaunchError("请求已中止");
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
	};
}
