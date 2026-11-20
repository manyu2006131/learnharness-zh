import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, Tool, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { processImage, type ProcessImageResult } from "../image-processing/index.ts";
import { Type } from "typebox";
import { piEngineFor, type PiEngine, type ThinkingLevel } from "../models.ts";
import { providerEventObserver, type ProviderEventObserver } from "../provider-events.ts";
import { backgroundCaptureStream, createBackgroundCapture, type BackgroundCapture } from "../background-capture.ts";
import { workerRequestStream } from "../worker-request-admission.ts";
import type { VisualResult } from "../../core/contracts.ts";
import type { LearnerImage } from "../tools/learner-image.ts";
import { embedLearnerImage, LEARNER_IMAGE_HREF } from "../../core/learner-image-svg.ts";
import { annotationPlacementProblem } from "./annotation-svg.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";

/**
 * The visual-maker sub-agent (vision §2.5): authors ONE precise SVG from a
 * brief, renders it to a PNG with the same rasterizer the transcript
 * will use, LOOKS at the
 * result, and iterates until correct — a direct port of the vault POC's
 * svg-maker doctrine ("the one rule that matters: verify by looking").
 *
 * LOOP SHAPE (decided in the W6 brief): hand-rolled with generateText + a
 * messages array, because the loop must feed an IMAGE back to the model after
 * each render. write_svg / render_svg are declared WITHOUT execute — when the
 * model calls them generateText stops with the tool calls, and this loop
 * appends the tool results itself, followed by a user message containing the
 * rendered PNG as a file part ("Here is the current render"). ToolLoopAgent's
 * execute-tool plumbing can't express that image-in-the-loop shape cleanly.
 *
 * Doctrine enforcement in code: if the model tries to finish while the
 * current SVG has never been rendered (or changed since its last render), the
 * loop renders it anyway, shows the image, and asks the model to look before
 * finishing. Nothing is delivered without having been looked at.
 *
 * Failure semantics mirror the demo-builder: { svg: "", notes: "FAILED: …" }.
 *
 * IMAGE MODE (issue #363): with a learner image the maker annotates it
 * instead. The model sees the picture and places it with a placeholder
 * href (LEARNER_IMAGE_HREF); the loop embeds bytes only for rendering.
 * Delivered SVGs retain the placeholder and a session snapshot reference.
 * The maker receives native image content, never base64 in SVG text/edits.
 */

export interface VisualMakerInput {
	brief: string;
	/** The learner image to annotate, already bounded for storage. */
	image?: LearnerImage;
}

/** The placeholder href the model gives the learner's picture. */
export { LEARNER_IMAGE_HREF };

export interface VisualMakerOptions {
	/** Test seam: scripted engine; production uses the visualMaker role. */
	engine?: PiEngine;
	headless?: HeadlessApi;
	/** Max model rounds (write/render cycles + final answer). Default 8. */
	maxIterations?: number;
	/** Live activity-line callback (updates the job record). */
	onActivity?: (line: string) => void;
	/** Kills the run mid-model-call (2026-09 real-kill abort semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: one call per loop iteration (streamSimple), folded
	 * into JobRecord.usage. */
	onUsage?: (usage: Usage) => void;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

const INSTRUCTIONS = `你是一名视觉制作者——为精确、空间性的图形担任图示作者与渲染者。你会收到一份简报，描述一个需要精确布局的想法（坐标几何、数轴、向量、函数图像、物理布局——自动布局图示无法表达的东西），然后返回一张干净、正确的 SVG。你看不到课堂；简报就是你所知的一切。

你不决定展示什么想法——教师已经决定了。你的职责是忠实、精确的构图，而高于一切的是正确性：图不能断言任何虚假之事。直角标记画在错误的角上、指向错误的向量、画在错误坐标上的点——即使渲染得很干净，也是失败。

你的三个工具：
- write_svg({ svg })——写入完整的 <svg>…</svg> 源码（覆盖此前版本）。
- edit_svg({ old_text, new_text })——在当前 SVG 中做一处精确替换：
  old_text 必须恰好出现一次，并会被 new_text 替换。请先调用 write_svg。超出一处定点修复的改动（新增元素、重排布局），请整体重新 write_svg。
- render_svg({})——把当前 SVG 栅格化为 PNG。渲染结果会作为图片出现在工具结果之后的消息里。

最重要的唯一规则：用眼睛验证。只有当你亲眼看过了渲染出的 PNG 并确认它忠实于简报，才算完成。渲染成功只证明 SVG 能被解析；它说明不了几何是否正确、图是否可读。看的时候：

- 每个坐标、角度、方向、比例是否真的正确？拿不准就重新推导几何。
- 标签是否放置清晰，没有压线或互相重叠？
- 是否有东西被 viewBox 裁掉、太小读不清、或挤在一起？
- 学习者只看这张图，能否立刻读出原本要表达的想法？

工作流：规划坐标空间（viewBox + 边距，任何东西都不碰边缘）→ write_svg → render_svg → 批判性地看 → 修复（一处修复用 edit_svg，否则 write_svg）并重新渲染，直到正确且干净。绝不在没看过最终 SVG 的渲染结果的情况下结束。

SVG 要求：
- 完整的 <svg>，带显式 width/height 且与 viewBox 匹配。
- 白色背景（<rect> 或样式），深色描边，无衬线标签，字号大方。
- 一个想法，元素最少——稀疏而大胜过拥挤而小。
- 只画简报指定的东西；绝不编造数据、数值或形状来填空。
- 朴素、干净的样式：至多一种强调色。这是解释性图示，不是艺术。

你的最终消息：给教师的 1-2 句说明（图展示了什么、有何注意事项）——绝不是 SVG 源码本身。如果你确实无法为简报画出正确的图，就在最终消息里照实说明并解释原因。`;

const IMAGE_INSTRUCTIONS = `标注学习者的图片——这份简报附有学习者自己的一张图片。你的图就是那张图片加上标注，不是一幅新画：

- 把它恰好放置一次，按原始尺寸，放在你的标注之前，使标注位于其上：
  <image href="${LEARNER_IMAGE_HREF}" x="…" y="…" width="W" height="H"/>——W×H 随图片一起给出。
  循环会替换成真实图片；绝不自己绘制或描述它的内容。
- 只使用静态 SVG 标注和内联属性：不用脚本、动画、foreignObject、样式块、外部资源或转义资源语法。允许本地 #fragment 引用。
- 在图片自身的像素坐标中标注（若为放标签而加了边距，则按你的 x/y 偏移）。
- 每个标注必须落在它所指的确切特征上——箭头指向错误部位就是虚假陈述。先在图中定位特征，再对照渲染图逐个检查标注。
- 标注必须在任何背景上都可读：粗描边、一两种高对比颜色；标签用白色光晕（stroke="white" paint-order="stroke"），或放在边距中用引线连出。
- 绝不用标签或填充遮住简报所关注的内容。
- 如果简报点名的特征不在图中，绝不猜测它在哪：留空不标，并在说明中讲明。`;

/** The wire declarations (pi-ai Tool, TypeBox parameters): this loop owns
 *  execution itself — write/edit dispatch inline below, render feeds the
 *  image-in-the-loop message — so the declarations carry no execute. */
export function createVisualTools(): Record<string, Tool> {
	return {
		write_svg: {
			name: "write_svg",
			description: "编写插图所需的完整 SVG 源码（覆盖此前版本）。",
			parameters: Type.Object({
				svg: Type.String({ description: 'Complete <svg xmlns="…">…</svg> markup.' }),
			}),
		},
		edit_svg: {
			name: "edit_svg",
			description:
				"替换当前 SVG 中的一处精确位置：old_text 必须恰好出现一次，并会被 new_text 替换。请先调用 write_svg。改动较大时，请整体重写 write_svg。",
			parameters: Type.Object({
				old_text: Type.String({ description: "要替换的精确文本——必须在当前 SVG 中恰好出现一次。" }),
				new_text: Type.String({ description: "替换文本。" }),
			}),
		},
		render_svg: {
			name: "render_svg",
			description: "将当前 SVG 渲染为 PNG 供你检查。无需参数。",
			parameters: Type.Object({}),
		},
	};
}

const LOOK_MESSAGE =
	"这是你 SVG 的当前渲染结果——请批判性地检查（几何、标签、裁切、可读性）：";
const UNLOOKED_FINISH_MESSAGE =
	"你还没有查看最终 SVG 的渲染结果就结束了。上方是其渲染图。如果正确且干净，只回复你的说明；否则调用 write_svg 修正后再次渲染。";

export async function runVisualMaker(input: VisualMakerInput, opts: VisualMakerOptions = {}): Promise<VisualResult> {
	const headless = opts.headless ?? getHeadless();
	const brief = input.brief.trim() || "(no brief)";
	const maxIterations = opts.maxIterations ?? 8;

	const reason = headless.unavailableReason();
	if (reason) {
		return { svg: "", notes: `失败：${reason}` };
	}

	const tools = createVisualTools();
	const toolDeclarations = Object.values(tools);
	const engine = opts.engine ?? piEngineFor("visualMaker");
	// BYOK (owner, 2026-09-22): the level rides the injected engine — no
	// factory pin to consult (engine.level is the resolved/clamped value).
	const reasoning = engine.level;
	const sessionId = randomUUID();
	const capture = createBackgroundCapture({ role: "visualMaker", runId: sessionId, sourceId: opts.chatId });
	const streamEngine = { ...engine, streamFn: backgroundCaptureStream(workerRequestStream(engine.streamFn), capture) };
	const learnerImage = input.image;
	const systemPrompt = learnerImage ? `${INSTRUCTIONS}\n\n${IMAGE_INSTRUCTIONS}` : INSTRUCTIONS;
	const prompt = [
		learnerImage
			? "一张待标注图片的简报（来自教师，逐字照录——这就是你所知的一切）："
			: "一张精确图示的简报（来自教师，逐字照录——这就是你所知的一切）：",
		brief,
		"",
		...(learnerImage
			? [
					`学习者的图片如下：${learnerImage.width}×${learnerImage.height} px。请用 <image href="${LEARNER_IMAGE_HREF}" … width="${learnerImage.width}" height="${learnerImage.height}"/> 放置它。`,
				]
			: []),
		"编写 SVG、渲染、查看、迭代直至正确，最后以你的说明收尾。",
	].join("\n");

	let messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	if (learnerImage) {
		const shown = await processImage(Buffer.from(learnerImage.data, "base64"), learnerImage.mimeType, {
			resizeOptions: engine.model.inputLimits?.images?.resize,
		});
		if (!shown.ok) return { svg: "", notes: `失败：把学习者的图片展示给制作者时出错——${shown.message}` };
		messages = [
			{
				role: "user",
				content: [
					{ type: "text", text: [prompt, ...shown.hints].join("\n") },
					{ type: "image", data: shown.data, mimeType: shown.mimeType },
				],
				timestamp: Date.now(),
			},
		];
	}
	/** Render-only embedding; persisted SVGs keep the small placeholder. */
	const embed = (svg: string): string => learnerImage ? embedLearnerImage(svg, learnerImage) : svg;
	const render = (svg: string) => headless.renderSvg(embed(svg), learnerImage ? { nativeOnly: true } : undefined);
	/** Image mode: the problem with an SVG that doesn't place the picture
	 *  exactly once (null = fine, and always fine without an image). */
	const placementProblem = (svg: string): string | null => {
		if (!learnerImage) return null;
		return annotationPlacementProblem(svg, learnerImage.width, learnerImage.height);
	};
	let currentSvg: string | null = null;
	/** The svg shown in the most recent render (null = never rendered). */
	let renderedSvg: string | null = null;
	let finalText = "";
	let captureError: unknown;

	try {
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			// One model call per iteration (streamSimple, no agent loop — this
			// loop owns tool execution and the image-in-the-loop injection).
			const result = await streamOnce(
				streamEngine,
				systemPrompt,
				messages,
				toolDeclarations,
				sessionId,
				reasoning,
				opts.abortSignal,
				opts.chatId ? providerEventObserver(opts.chatId, "job:visualMaker") : undefined,
				capture,
			);
			// Money channel: each iteration is one model call.
			opts.onUsage?.(result.usage);
			messages = [...messages, result];

			const toolCalls = result.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall");
			if (toolCalls.length === 0) {
				finalText = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
					.trim();
				// Doctrine gate: never deliver an unlooked SVG. If the current SVG
				// changed since its last render (or was never rendered), show it now
				// and make the model look before accepting the finish.
				if (currentSvg && renderedSvg !== currentSvg) {
					let png: Buffer;
					try {
						png = await render(currentSvg);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return { svg: "", notes: `失败：最终 SVG 渲染出错——${msg}` };
					}
					const image = await processImage(png, "image/png", { resizeOptions: engine.model.inputLimits?.images?.resize });
					opts.abortSignal?.throwIfAborted();
					if (!image.ok) return { svg: "", notes: `失败：检查最终 SVG 时出错——${image.message}` };
					opts.onActivity?.("render_svg：正在检查最终渲染");
					renderedSvg = currentSvg;
					messages = [
						...messages,
						{
							role: "user",
							content: [
								{ type: "text", text: [UNLOOKED_FINISH_MESSAGE, ...image.hints].join("\n") },
								{ type: "image", data: image.data, mimeType: image.mimeType },
							],
							timestamp: Date.now(),
						},
					];
					continue;
				}
				return finish(currentSvg, finalText, learnerImage);
			}

			const toolResults: ToolResultMessage[] = [];
			let renderImage: Extract<ProcessImageResult, { ok: true }> | null = null; // appended AFTER the tool results
			for (const call of toolCalls) {
				if (call.name === "write_svg") {
					const svg = (call.arguments as { svg?: unknown }).svg;
					if (typeof svg !== "string" || !svg.includes("<svg")) {
						toolResults.push(toolText(call.id, call.name, "错误：`svg` 字段需要完整的 <svg>…</svg> 文档。"));
						continue;
					}
					const problem = placementProblem(svg);
					if (problem) {
						toolResults.push(toolText(call.id, call.name, `错误：${problem}。`));
						continue;
					}
					currentSvg = svg;
					opts.onActivity?.(`write_svg: ${(svg.length / 1024).toFixed(1)} KB`);
					toolResults.push(toolText(call.id, call.name, `已保存（${svg.length} 字节）。请调用 render_svg 查看。`));
				} else if (call.name === "edit_svg") {
					const edit = call.arguments as { old_text?: unknown; new_text?: unknown };
					if (!currentSvg) {
						toolResults.push(toolText(call.id, call.name, "错误：没有可编辑的内容——请先调用 write_svg。"));
						continue;
					}
					if (typeof edit.old_text !== "string" || typeof edit.new_text !== "string" || !edit.old_text) {
						toolResults.push(toolText(call.id, call.name, "错误：需要非空的 old_text 和 new_text 字符串。"));
						continue;
					}
					const occurrences = currentSvg.split(edit.old_text).length - 1;
					if (occurrences === 0) {
						toolResults.push(
							toolText(
								call.id,
								call.name,
								`错误：找不到 old_text。最接近的参考行如下：\n${snippetAround(currentSvg, edit.old_text)}`,
							),
						);
						continue;
					}
					if (occurrences > 1) {
						toolResults.push(
							toolText(call.id, call.name, `错误：old_text 出现了 ${occurrences} 次——必须恰好出现一次。请多带一些上下文让它唯一。`),
						);
						continue;
					}
					const edited: string = currentSvg.replace(edit.old_text, edit.new_text);
					const problem = placementProblem(edited);
					if (problem) {
						toolResults.push(toolText(call.id, call.name, `错误：编辑未应用——${problem}。`));
						continue;
					}
					currentSvg = edited;
					opts.onActivity?.("edit_svg：已应用");
					toolResults.push(toolText(call.id, call.name, "成功——已替换 1 处。请调用 render_svg 查看修改后的 SVG。"));
				} else if (call.name === "render_svg") {
					if (!currentSvg) {
						toolResults.push(toolText(call.id, call.name, "错误：没有可渲染的内容——请先调用 write_svg。"));
						continue;
					}
					try {
						const png = await render(currentSvg);
						const image = await processImage(png, "image/png", { resizeOptions: engine.model.inputLimits?.images?.resize });
						opts.abortSignal?.throwIfAborted();
						if (!image.ok) throw new Error(image.message);
						renderImage = image;
						renderedSvg = currentSvg;
						opts.onActivity?.("render_svg：正在检查渲染");
						toolResults.push(toolText(call.id, call.name, "已渲染——PNG 会在下一条消息中给出。请查看。"));
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						opts.onActivity?.("render_svg：渲染错误");
						toolResults.push(toolText(call.id, call.name, `渲染错误（SVG 可能存在格式问题）：${msg}。请用 write_svg 修正后重新渲染。`));
					}
				} else {
					toolResults.push(toolText(call.id, call.name, `错误：未知工具 "${call.name}"。请使用 write_svg、edit_svg 或 render_svg。`));
				}
			}
			// Message order: assistant tool-calls → tool results → render image.
			for (const result of toolResults) capture?.toolResult(result);
			messages = [...messages, ...toolResults];
			if (renderImage) {
				messages = [
					...messages,
					{
						role: "user",
						content: [
							{ type: "text", text: [LOOK_MESSAGE, ...renderImage.hints].join("\n") },
							{ type: "image", data: renderImage.data, mimeType: renderImage.mimeType },
						],
						timestamp: Date.now(),
					},
				];
			}
		}
	} catch (err) {
		captureError = err;
		const msg = err instanceof Error ? err.message : String(err);
		return { svg: "", notes: `失败：制作者崩溃了——${msg}` };
	} finally {
		capture?.finish(captureError);
	}

	// Iteration limit: deliver the last written SVG only if it was looked at.
	if (currentSvg && renderedSvg === currentSvg) {
		return finish(currentSvg, finalText || "已达迭代上限——交付最后一次验证过的 SVG。", learnerImage);
	}
	return { svg: "", notes: `失败：达到迭代上限（${maxIterations}）时仍没有经过验证的 SVG。` };
}

function toolText(toolCallId: string, toolName: string, value: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: value }],
		isError: value.startsWith("错误：") || value.startsWith("渲染错误"),
		timestamp: Date.now(),
	};
}

/** One raw model call (no agent loop): drain the event stream to the final
 *  AssistantMessage; provider errors and aborts throw so the loop's catch
 *  path keeps its old generateText semantics. */
async function streamOnce(
	engine: PiEngine,
	systemPrompt: string,
	messages: Message[],
	tools: Tool[],
	sessionId: string,
	reasoning: ThinkingLevel | undefined,
	abortSignal?: AbortSignal,
	onProviderStreamEvent?: ProviderEventObserver,
	capture?: BackgroundCapture,
): Promise<AssistantMessage> {
	// 0.87.1: provider-facing contexts are TranscriptContexts — the prompt
	// and tool declarations fold into a leading system message.
	// normalizeContext is the library's only Context→TranscriptContext entry.
	const stream = engine.streamFn(engine.model, normalizeContext({ systemPrompt, messages, tools }), {
		sessionId,
		reasoning: reasoning && reasoning !== "off" ? reasoning : undefined,
		signal: abortSignal,
		onProviderStreamEvent: onProviderStreamEvent as never,
	} as never);
	for await (const event of stream) {
		if (event.type === "done") { capture?.reply(event.message); return event.message; }
		if (event.type === "error") {
			capture?.reply(event.error);
			if (event.reason === "aborted") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}
	throw new Error("the model stream ended without a result");
}

/** A 3-line numbered context window around the closest fuzzy match for a
 *  failed edit — enough for the model to see what went wrong and retry
 *  (the pi svg_tools snippetAround semantics). */
function snippetAround(svg: string, target: string): string {
	const words = target.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "(empty old_text)";
	const lines = svg.split("\n");
	let bestAt = -1;
	let bestScore = -1;
	for (let i = 0; i < lines.length; i++) {
		const score = words.filter((w) => lines[i]!.includes(w)).length;
		if (score > bestScore) {
			bestScore = score;
			bestAt = i;
		}
	}
	if (bestAt < 0) return "(no similar line found)";
	const from = Math.max(0, bestAt - 1);
	const to = Math.min(lines.length, bestAt + 2);
	return lines
		.slice(from, to)
		.map((line, idx) => `${from + idx + 1} | ${line}`)
		.join("\n");
}

function finish(svg: string | null, finalText: string, image?: LearnerImage): VisualResult {
	if (!svg) {
		return {
			svg: "",
			notes: `失败：制作者从未写入 SVG。${finalText ? `（${finalText.slice(0, 300)}）` : ""}`,
		};
	}
	return { svg, notes: finalText || undefined, ...(image ? { image: { path: image.path, snapshotId: image.snapshotId } } : {}) };
}
