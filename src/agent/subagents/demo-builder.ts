import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { serverExecute } from "../tool-execute.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import type { DemoResult } from "../../core/contracts.ts";
import { getHeadless, type DemoRunResult, type HeadlessApi } from "./headless.ts";
import { healToolRecord } from "../tools/heal.ts";

/**
 * The demo-builder sub-agent (vision §2 interactive demos + §2.5 "sub-agents
 * verify; they never one-shot"): given a brief it writes a self-contained
 * single-file HTML/JS demo, TESTS IT HEADLESSLY (run_demo), and iterates
 * fix → re-run until clean — before anything reaches the lesson.
 *
 * Shape: a ToolLoopAgent with two executable tools (write_demo / run_demo) —
 * the engine is injectable (tests use a scripted faux engine) and the headless
 * API is injectable (tests use a fake; production uses the app's own
 * Chromium browser service, system Chrome as fallback).
 *
 * Failure semantics (decided in the W6 brief): `tested: true` means "the
 * verify loop ran"; on failure the result is { title, html: "", tested: true,
 * notes: "FAILED: <reason>" } — the card renders the failure note, no iframe.
 * The job wrapper treats html === "" as failure and marks the job error.
 */

export interface DemoBuilderInput {
	title: string;
	brief: string;
}

export interface DemoBuilderOptions {
	/** Test seam: scripted engine; production uses the demoBuilder role. */
	engine?: PiEngine;
	headless?: HeadlessApi;
	/** Max agent steps (each write/run/fix is one step). Default 24 ≈ 6 cycles. */
	maxSteps?: number;
	/** Live activity-line callback (updates the job record). */
	onActivity?: (line: string) => void;
	/** Kills the run mid-model-call (2026-09 real-kill abort semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: one call per agent step, folded into JobRecord.usage. */
	onUsage?: (usage: Usage) => void;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

const INSTRUCTIONS = `你是一名演示构建者——学习应用内部的专业子代理。你会收到一份交互式教学仪器的简报，并交付一个运行它的自包含 HTML 文档。你看不到课堂；简报就是你所知的一切。

运行契约（文档在沙箱 iframe 中运行，sandbox="allow-scripts"，不透明源）：
- 单文件。原生 JS + Canvas 2D 或 SVG。当确实有帮助时允许 CDN 导入（例如绘图或数学库）——但优先零依赖；如果 CDN 导入失败，责任在你。
- 禁用 localStorage、sessionStorage 或 document.cookie——沙箱会让它们抛错。
- 父窗口会自动把 iframe 调整为文档高度；就按正常的流式布局构建。让演示铺满宽度，并合理设定自身高度。

构建质量：
- 演示必须直接服务于简报：简报点名的每个控件都必须存在并确实起作用。
- 控件需要标签；滑块/输入需要显示当前值。学习者应能无需指导地操作。
- 交互要足够流畅；动画用 requestAnimationFrame，需要时不要用 setInterval。
- 中性暗色适配：给演示区域选一个干净的浅色背景，使其在任何卡片上都清晰可读。

本院铁律——绝不交付未测试的东西：
1. 用 write_demo 写入完整 HTML 文档。
2. 调用 run_demo。它会在无头浏览器中加载文件，等待约 2 秒，并报告控制台错误、未捕获异常（window.onerror）和失败请求。可选传入 probe：一个在页面中求值的 JS 表达式（例如 "typeof window.simulate === 'function'" 或某个状态断言），以做更深的检查。
3. 如果 run_demo 报告问题，修正文档并再次 write_demo，然后再次 run_demo。迭代到 run_demo 报告通过为止。
4. 只有这时才结束。你的最终消息是给教师的 1-3 句说明（演示展示了什么、有哪些控件、可以怎么试）——绝不是 HTML 本身。

绝不宣称你没见过的成功：一次通过的 run_demo 是“完成”的唯一定义。`;

interface BuilderState {
	html: string | null;
	/** The html that the last run_demo tested (null = never tested). */
	testedHtml: string | null;
	lastResult: DemoRunResult | null;
}

const writeDemoInput = Type.Object({
	html: Type.String({ description: "完整的 HTML 文档：<!doctype html>…</html>，所有 JS 内联。" }),
});

const runDemoInput = Type.Object({
	probe: Type.Optional(
		Type.String({
			description:
				"可选的 JS 表达式，页面稳定后在页面中求值，例如 \"document.querySelectorAll('input').length\"。",

		}),
	),
});

export function createDemoBuilderTools(
	state: BuilderState,
	headless: HeadlessApi,
	onActivity?: (line: string) => void,
): Record<string, AgentTool<any>> {
	return healToolRecord({
		write_demo: {
			name: "write_demo",
			label: "write_demo",
			description:
				"编写演示所需的完整自包含 HTML 文档（覆盖此前版本）。" +
				"之后务必用 run_demo 进行无头测试。",
			parameters: writeDemoInput,
			execute: serverExecute("write_demo", writeDemoInput, async ({ html }) => {
				if (!html || html.trim().length === 0) return "错误：文档为空——请写出完整的 HTML。";
				state.html = html;
				onActivity?.(`write_demo: ${(html.length / 1024).toFixed(1)} KB`);
				return `已保存（${html.length} 字节）。现在调用 run_demo 测试——绝不交付未测试的东西。`;
			}),
		},
		run_demo: {
			name: "run_demo",
			label: "run_demo",
			description:
				"在浏览器中无头执行当前演示，报告控制台错误、未捕获异常和失败请求。" +
				"可选：传入探查表达式以断言页面状态。",
			parameters: runDemoInput,
			execute: serverExecute("run_demo", runDemoInput, async ({ probe }) => {
				if (!state.html) return "错误：没有可运行的内容——请先调用 write_demo。";
				const reason = headless.unavailableReason();
				if (reason) return `无头环境不可用：${reason}`;
				let result: DemoRunResult;
				try {
					result = await headless.runDemo(state.html, probe ? { probe } : undefined);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					onActivity?.("run_demo：浏览器错误");
					return `无头环境错误（重试可能有帮助）：${msg}`;
				}
				state.testedHtml = state.html;
				state.lastResult = result;
				onActivity?.(
					result.ok ? "run_demo：干净" : `run_demo: ${summarizeCounts(result)}`,
				);
				return formatRunResult(result);
			}),
		},
	});
}

function summarizeCounts(result: DemoRunResult): string {
	const counts = [
		result.consoleErrors.length > 0 ? `${result.consoleErrors.length} 个控制台错误` : null,
		result.pageErrors.length > 0 ? `${result.pageErrors.length} 个页面错误` : null,
		result.failedRequests.length > 0 ? `${result.failedRequests.length} 个失败请求` : null,
	].filter(Boolean);
	return counts.length > 0 ? counts.join("、") : "正常";
}

function formatRunResult(result: DemoRunResult): string {
	if (result.ok) {
		const probe =
			result.probeResult !== undefined
				? ` 探查结果：${JSON.stringify(result.probeResult) ?? "undefined"}。`
				: "";
		return `通过：无控制台错误、无未捕获异常、无失败请求。${probe}满意的话就用你的说明收尾；否则继续改进并重新测试。`;
	}
	const sections: string[] = [`未通过：${summarizeCounts(result)}。`];
	if (result.consoleErrors.length > 0)
		sections.push(`控制台错误：\n${result.consoleErrors.slice(0, 10).map((e) => `- ${e}`).join("\n")}`);
	if (result.pageErrors.length > 0)
		sections.push(`未捕获异常：\n${result.pageErrors.slice(0, 10).map((e) => `- ${e}`).join("\n")}`);
	if (result.failedRequests.length > 0)
		sections.push(`失败请求：\n${result.failedRequests.slice(0, 10).map((r) => `- ${r}`).join("\n")}`);
	sections.push("修正文档（write_demo）并重新测试（run_demo）。");
	return sections.join("\n");
}

/** Short summary of a run for failure notes. */
function failureSummary(result: DemoRunResult | null): string {
	if (!result) return "从未测试";
	const details = [...result.consoleErrors, ...result.pageErrors, ...result.failedRequests].slice(0, 5);
	return details.length > 0 ? `${summarizeCounts(result)} — ${details.join(" | ")}` : summarizeCounts(result);
}

export async function runDemoBuilder(input: DemoBuilderInput, opts: DemoBuilderOptions = {}): Promise<DemoResult> {
	const headless = opts.headless ?? getHeadless();
	const title = input.title.trim() || "交互动画演示";
	const brief = input.brief.trim() || "（无简报）";
	const notes = (text: string) => (text.trim() ? text.trim() : undefined);

	const reason = headless.unavailableReason();
	if (reason) {
		return { title, html: "", tested: true, notes: `失败：${reason}` };
	}

	const state: BuilderState = { html: null, testedHtml: null, lastResult: null };

	const prompt = [
		`演示标题：${title}`,
		`简报（你所知的全部课堂信息——来自教师，逐字照录）：`,
		brief,
		"",
		"构建演示，用 run_demo 测试，迭代至通过，最后以你的说明收尾。",
	].join("\n");

	let finalText = "";
	try {
		const result = await runSubagent(Object.values(createDemoBuilderTools(state, headless, opts.onActivity)), {
			role: "demoBuilder",
			engine: opts.engine,
			systemPrompt: INSTRUCTIONS,
			prompt,
			maxTurns: opts.maxSteps ?? 24,
			abortSignal: opts.abortSignal,
			onUsage: (usage) => opts.onUsage?.(usage),
			onToolStart: (toolName) => opts.onActivity?.(toolName),
			chatId: opts.chatId,
		});
		finalText = result.text;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { title, html: "", tested: true, notes: `失败：构建者崩溃了——${msg}` };
	}

	// The model produced nothing.
	if (!state.html) {
		return {
			title,
			html: "",
			tested: true,
			notes: `失败：构建者从未写入演示。${finalText ? `（${finalText.slice(0, 300)}）` : ""}`,
		};
	}

	// The verify gate: the delivered html must have a clean headless run —
	// even when the model claims success or forgets the final run_demo.
	if (state.testedHtml !== state.html || !state.lastResult?.ok) {
		opts.onActivity?.("最终验证");
		let verify: DemoRunResult;
		try {
			verify = await headless.runDemo(state.html);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { title, html: "", tested: true, notes: `失败：最终验证崩溃了——${msg}` };
		}
		state.lastResult = verify;
		if (!verify.ok) {
			return {
				title,
				html: "",
				tested: true,
				notes: `失败：演示始终未通过无头验证（${failureSummary(verify)}）。`,
			};
		}
	}

	return { title, html: state.html, tested: true, notes: notes(finalText) };
}
