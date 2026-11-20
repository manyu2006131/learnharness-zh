import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, ToolResultMessage, Usage, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { processImage, type ProcessImageResult } from "../image-processing/index.ts";
import { Type } from "typebox";
import { resolveSourcePath } from "../tools/fs-shared.ts";
import { piEngineFor, type PiEngine, type ThinkingLevel } from "../models.ts";
import { providerEventObserver, type ProviderEventObserver } from "../provider-events.ts";
import { backgroundCaptureStream, createBackgroundCapture, type BackgroundCapture } from "../background-capture.ts";
import { workerRequestStream } from "../worker-request-admission.ts";
import type { PdfResult, PdfToolInput } from "../../core/contracts.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";
import { pdfExtract, pdfInfo, pdfProbe, pdfSearch, type PdfSearchHit } from "./pdf-ops.ts";

/**
 * The pdf-reader sub-agent (sources v0, 2026-09): reads a learner-provided
 * PDF on the teacher's behalf — a hand-rolled loop like the visual-maker's
 * (image-in-the-loop can't ride the execute-tool plumbing: rendered pages
 * are shown to THIS agent's eyes, never delivered onward — user-decided).
 *
 * System prompt = the pdf-reader skill's reading doctrine, verbatim in
 * strategy: triage with pdf_info FIRST, then size-based strategy — short
 * PDFs render all pages, medium render flagged (math/image-heavy) pages,
 * long ones search for targeted lookups before reading anything at length.
 *
 * Its final text IS the brief (researcher idiom), with (p. N) citations;
 * runPdfJob wraps it into PdfResult with pagesConsulted tracked by the loop.
 */

const INSTRUCTIONS = `你是 PDF 阅读专员。你在一个学习应用里为教师智能体工作：给定一个 PDF 路径和一个问题，代表教师阅读该文档，产出一份教师可以据此教学的、聚焦的简报，并附页码引用。

你在一个隔离的上下文中运行。任务只给你 PDF 路径和问题——这就是你所知的一切。

阅读准则——始终按此顺序：
1. 先分诊：调用 pdf_info。它返回页数以及逐页信号（text_length、image_count、math_density）。在此之前绝不读取或渲染任何内容。
2. 按文档大小选择策略：
   - 短（≤ 10 页）：提取全文；渲染每一页有实质 math_density 或图片的页面（公式与图表要用眼睛读，而不是读提取出的文本）。
   - 中（11-40 页）：提取有希望的页面；只渲染被标记的页面（公式或图片密集，或提取结果看起来单薄的页面）。
   - 长（> 40 页）：先用 pdf_search 搜索问题的关键词；只提取并渲染命中的页面。绝不从头到尾通读长文档。
3. 当某页的提取文本看起来公式或图表密集、或乱码时，渲染该页并在下结论前用眼睛阅读。
4. 渲染 DPI 指引：以文本为主的页面用 100，默认 150，密集小字用 200（公式细节、精细图表）。

工具输出可能是错误字符串（文件不可读、正则无效、无命中）。要适应：收窄页范围、修改查询、降低 DPI。如果文档确实无法回答该问题，就在简报中说明，而不是编造内容。

你最后一条助手消息就是你的全部交付物——它必须独立成立，格式如下：
用 2-6 句话（或简短小节）从文档回答教师的问题，每条断言以 (p. N) 标注页码。最后以一行“已查阅页面：N、N、…”结束，列出你提取或渲染过的每一页。`;

const MAX_ITERATIONS = 14;
/** Rendered pages per pdf_render call — the skill renders selectively; a
 *  batch cap keeps one over-eager call from flooding the vision context. */
const RENDER_BATCH_CAP = 6;
/** Extract output ceiling — narrow the spec instead of dumping a book. */
const EXTRACT_CAP = 24_000;

export interface PdfReaderOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onActivity?: (line: string) => void;
	headless?: HeadlessApi;
	maxIterations?: number;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

export interface PdfReaderInput extends PdfToolInput {}

/** The wire declarations (pi-ai Tool, TypeBox parameters). This loop owns
 *  execution itself — pdf_info/pdf_extract run via the plain pdfInfoText/
 *  pdfExtractText bodies below, pdf_search/pdf_render dispatch inline in
 *  the loop (search hits must join the citation set; renders feed the
 *  image-in-the-loop message) — so the declarations carry no execute.
 *  dpi/context_lines/literal carry the old zod `.default()`s as schema
 *  descriptions + loop-side ??-fills (the loop reads them via numOr). */
export function createPdfTools(_pdfPath: string): Record<string, Tool> {
	return {
		pdf_info: {
			name: "pdf_info",
			description: "此 PDF 的元数据与逐页分诊信号（页数、文本长度、图片数、公式密度）。务必先调用本工具。",
			parameters: Type.Object({}),
		},
		pdf_extract: {
			name: "pdf_extract",
			description: "从页面提取文本（范围：'all'、'1-5'、'1,3,7'、'3'）。大文档请先用 pdf_info 并缩小范围。",
			parameters: Type.Object({
				pages: Type.String({ description: "页范围，例如 'all'、'1-5'、'1,3,7'" }),
			}),
		},
		pdf_render: {
			name: "pdf_render",
			description:
				"将页面渲染为图片供你视觉阅读（公式、图表、版式）。DPI：100 文本、150 默认、200 密集小字。每次最多 6 页。",
			parameters: Type.Object({
				pages: Type.String({ description: "页范围，例如 '1-3' 或 '2,5,8'" }),
				dpi: Type.Optional(
					Type.Integer({ minimum: 72, maximum: 300, description: "渲染 DPI（100 文本 / 150 默认 / 200 密集）" }),
				),
			}),
		},
		pdf_search: {
			name: "pdf_search",
			description: "按关键词或正则（不区分大小写）搜索 PDF 文本；返回命中及上下文行。阅读长篇文档前先行使用。",
			parameters: Type.Object({
				query: Type.String({ description: "关键词或正则" }),
				context_lines: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 8, description: "每处命中的上下文行数（默认 3）" }),
				),
				literal: Type.Optional(Type.Boolean({ description: "true = treat the query literally (no regex; default false)" })),
			}),
		},
	};
}

/** pdf_info's body (the loop's dispatch target): the triage readout. */
async function pdfInfoText(pdfPath: string): Promise<string> {
	const info = await pdfInfo(pdfPath);
	const lines = [
		`文件：${info.path}`,
		`页数：${info.page_count}（平均每页文本长度：${info.mean_text_length}）`,
		...info.pages.map(
			(p) =>
				`p${p.page}: len=${p.text_length} img=${p.image_count} math=${p.math_density.toFixed(2)}`,
		),
	];
	return lines.join("\n");
}

/** pdf_extract's body: capped text extraction with the narrow-the-spec notice. */
async function pdfExtractText(pdfPath: string, pages: string): Promise<string> {
	const text = await pdfExtract(pdfPath, pages);
	if (text.length > EXTRACT_CAP) {
		return `${text.slice(0, EXTRACT_CAP)}\n\n[Output truncated at ${EXTRACT_CAP} chars — narrow the page spec and extract in smaller batches.]`;
	}
	return text;
}

function toolText(toolCallId: string, toolName: string, value: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: value }],
		isError: value.startsWith("ERROR:"),
		timestamp: Date.now(),
	};
}

/** Doctrine gate (the visual-maker's unlooked-finish rule, ported): never
 *  deliver a brief that consulted nothing — an unread PDF brief is made-up
 *  content, exactly the class of failure the gate exists for. */
const UNREAD_FINISH_MESSAGE =
	"你没有查阅 PDF 的任何页面就结束了——这样的简报是编造而非阅读。请先提取或渲染相关页面，再根据实际看到的内容撰写简报。";

export async function runPdfReaderAgent(
	input: PdfReaderInput,
	opts: PdfReaderOptions = {},
): Promise<PdfResult> {
	const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
	let pdfPath = input.path;
	let openError: string | null;
	// Source denial is an ordinary upfront PDF failure, before parsing,
	// rendering or any model request (including direct reader invocations).
	try {
		pdfPath = resolveSourcePath(input.path);
		openError = await probeReadable(pdfPath);
	} catch (err) {
		openError = err instanceof Error ? err.message : String(err);
	}
	if (openError) {
		return { path: pdfPath, question: input.question, brief: `PDF 失败：${openError}`, pagesRead: [], pagesConsulted: [] };
	}
	const headless = opts.headless ?? getHeadless();
	// No Chrome gate (Wave E, 2026-10-10): pdf_render is native now
	// (pdfjs paints into @napi-rs/canvas in-process) — the whole pdf-reader
	// runs browser-free; text tools always worked without one.

	const tools = createPdfTools(pdfPath);
	const toolDeclarations = Object.values(tools);
	const engine = opts.engine ?? piEngineFor("pdfReader");
	// BYOK (owner, 2026-09-22): the level rides the injected engine — no
	// factory pin to consult (engine.level is the resolved/clamped value).
	const reasoning = engine.level;
	const sessionId = randomUUID();
	const capture = createBackgroundCapture({ role: "pdfReader", runId: sessionId, sourceId: opts.chatId });
	const streamEngine = { ...engine, streamFn: backgroundCaptureStream(workerRequestStream(engine.streamFn), capture) };
	const prompt = [
		`PDF path: ${pdfPath}`,
		`问题（教师需要从这份文档中得到什么）：${input.question || "（没有问题——给出结构性概览）"}`,
		"",
		"按你的准则阅读文档，然后以要求的格式产出最终简报。",
	].join("\n");

	let messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	/** Every page the reader extracted or rendered (the citation set). */
	const consulted = new Set<number>();
	/** Pages genuinely READ — extract or render output entered the loop.
	 *  Search-hit context lines consult but don't read (the "78 pages
	 *  consulted" overstatement split, sources v1 2026-09-19). */
	const read = new Set<number>();
	let finalText = "";
	let nudged = false;
	let captureError: unknown;

	try {
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const result = await streamOnce(
				streamEngine,
				INSTRUCTIONS,
				messages,
				toolDeclarations,
				sessionId,
				reasoning,
				opts.abortSignal,
				opts.chatId ? providerEventObserver(opts.chatId, "job:pdfReader") : undefined,
				capture,
			);
			// Money channel: each iteration is one model call.
			opts.onUsage?.(result.usage);
			messages = [...messages, result];

			const toolCalls = result.content.filter(
				(c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall",
			);
			if (toolCalls.length === 0) {
				finalText = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
					.trim();
				// The gate stays on CONSULTED, not read: search-hit context
				// lines are genuine consultation (anti-fabrication duty) — a
				// search-only brief is honest. pagesRead is the UI's honest
				// count, not a delivery gate.
				if (consulted.size === 0 && !nudged) {
					nudged = true;
					messages = [
						...messages,
						{ role: "user", content: UNREAD_FINISH_MESSAGE, timestamp: Date.now() },
					];
					continue;
				}
				return { path: pdfPath, question: input.question, brief: finalText || "(no brief text)", pagesRead: [...read].sort((a, b) => a - b), pagesConsulted: [...consulted].sort((a, b) => a - b) };
			}

			const toolResults: ToolResultMessage[] = [];
			/** Rendered pages this batch, appended as images AFTER the tool
			 *  results — the visual-maker's image-in-the-loop idiom. */
			let renderedImages: { page: number; image: ProcessImageResult }[] | null = null;

			for (const call of toolCalls) {
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				try {
					if (call.name === "pdf_info") {
						opts.onActivity?.("pdf_info: triaging");
						const r = await pdfInfoText(pdfPath);
						toolResults.push(toolText(call.id, call.name, String(r)));
					} else if (call.name === "pdf_extract") {
						const spec = String(args.pages ?? "all");
						opts.onActivity?.(`pdf_extract: ${spec}`);
						const r = await pdfExtractText(pdfPath, spec);
						toolResults.push(toolText(call.id, call.name, String(r)));
						for (const p of specNumbers(spec, Infinity)) {
							consulted.add(p);
							read.add(p);
						}
					} else if (call.name === "pdf_search") {
						const query = String(args.query ?? "");
						const contextLines = numOr(args.context_lines, 3);
						const literal = Boolean(args.literal);
						opts.onActivity?.(`pdf_search: "${query}"`);
						// Direct call (not the tool's execute): the loop needs the hits'
						// pages — a hit's context lines ARE consultation, so they join
						// the citation set (the unread-finish gate counts them).
						const { hits } = await pdfSearch(pdfPath, query, { contextLines, literal });
						for (const h of hits) consulted.add(h.page);
						const cap = hits.slice(0, 40);
						const body =
							cap.length === 0
								? "无命中。"
								: cap.map((h) => `=== 第 ${h.page} 页，第 ${h.line} 行 ===\n${h.context}`).join("\n") +
									(hits.length > cap.length ? `\n\n[还有 ${hits.length - cap.length} 条命中——请收窄查询。]` : "");
						toolResults.push(toolText(call.id, call.name, body));
					} else if (call.name === "pdf_render") {
						const spec = String(args.pages ?? "1");
						const dpi = numOr(args.dpi, 150);
						const wanted = specNumbers(spec, RENDER_BATCH_CAP);
						opts.onActivity?.(`pdf_render: ${spec} @${dpi}dpi`);
						const pages = await headless.renderPdfPages(pdfPath, wanted, { dpi });
						const processed: { page: number; image: ProcessImageResult }[] = [];
						for (const p of pages) {
							const image = await processImage(p.png, "image/png", { resizeOptions: engine.model.inputLimits?.images?.resize });
							opts.abortSignal?.throwIfAborted();
							processed.push({ page: p.page, image });
							// Only images actually delivered to the model count as read.
							if (image.ok) {
								consulted.add(p.page);
								read.add(p.page);
							}
						}
						if (pages.length === 0) {
							toolResults.push(toolText(call.id, call.name, "错误：未渲染任何页面（页范围没有匹配到内容？）"));
						} else {
							renderedImages = [...(renderedImages ?? []), ...processed];
							toolResults.push(
								toolText(
									call.id,
									call.name,
									`已按 ${dpi} DPI 渲染 ${pages.length} 页——下方是处理后的图片或明确的省略说明。请仔细阅读图片（公式、图表、版式）。`,
								),
							);
						}
					} else {
						toolResults.push(toolText(call.id, call.name, `错误：未知工具“${call.name}”`));
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					toolResults.push(toolText(call.id, call.name, `ERROR: ${msg}`));
				}
			}

			for (const result of toolResults) capture?.toolResult(result);
			messages = [...messages, ...toolResults];
			if (renderedImages) {
				messages = [
					...messages,
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `已渲染的页面，按顺序（${renderedImages.map((p) => `p${p.page}`).join(", ")}）：`,
							},
							...renderedImages.flatMap(({ page, image }) => image.ok
								? [
									{ type: "text" as const, text: [`Page ${page}`, ...image.hints].join("\n") },
									{ type: "image" as const, data: image.data, mimeType: image.mimeType },
								]
								: [{ type: "text" as const, text: `Page ${page}: ${image.message}` }]),
						],
						timestamp: Date.now(),
					},
				];
			}
		}
	} catch (err) {
		captureError = err;
		const msg = err instanceof Error ? err.message : String(err);
		return { path: pdfPath, question: input.question, brief: `PDF 失败：读取器崩溃——${msg}`, pagesRead: [...read].sort((a, b) => a - b), pagesConsulted: [...consulted].sort((a, b) => a - b) };
	} finally {
		capture?.finish(captureError);
	}

	// Iteration limit: deliver whatever was honestly consulted (never invention).
	return {
		path: pdfPath,
		question: input.question,
		brief: finalText || `PDF 失败：达到迭代上限（${maxIterations} 次）仍未生成摘要。`,
		pagesRead: [...read].sort((a, b) => a - b),
		pagesConsulted: [...consulted].sort((a, b) => a - b),
	};
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Parse a page spec into concrete page numbers, capped. */
function specNumbers(spec: string, cap: number): number[] {
	// total = Infinity: bounds come from the document at execution time; the
	// cap alone protects the batch.
	const parts = spec.trim().toLowerCase() === "all" ? [`${cap}`] : spec.split(",");
	const out = new Set<number>();
	for (const part of parts) {
		const p = part.trim();
		if (!p) continue;
		if (p.includes("-")) {
			const [s, e] = p.split("-", 2) as [string, string];
			const start = Math.max(1, parseInt(s, 10) || 1);
			const end = Math.min(parseInt(e, 10) || start, start + cap - 1);
			for (let pg = start; pg <= end && out.size < cap; pg++) out.add(pg);
		} else {
			const pg = parseInt(p, 10);
			if (Number.isFinite(pg) && pg >= 1 && out.size < cap) out.add(pg);
		}
	}
	return [...out].sort((a, b) => a - b);
}

function numOr(v: unknown, dflt: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** Cheap upfront readability probe — real parsing happens inside the tools. */
async function probeReadable(pdfPath: string): Promise<string | null> {
	try {
		const fs = await import("node:fs/promises");
		const stat = await fs.stat(pdfPath);
		if (!stat.isFile()) return "not a regular file";
		if (stat.size === 0) return "文件为空";
		// parse probe: pdfProbe throws pdfjs's precise error for garbage files
		await pdfProbe(pdfPath);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** One raw model call (no agent loop): the visual-maker's streamOnce,
 *  duplicated here because its module keeps it private. */
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
				const abortedErr = err as Error & { name: string };
				abortedErr.name = "AbortError";
				throw abortedErr;
			}
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}
	throw new Error("the model stream ended without a result");
}