import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { JobRecord } from "../../core/contracts.ts";
import type { JobStore } from "../../core/ports.ts";
import { checkLearnerImage } from "./learner-image.ts";
import { resolveSourcePath } from "./fs-shared.ts";

/**
 * Async sub-agent job tools (vision §2.5; W2/W6 kinds + the pi-model
 * protocol). SERVER-EXECUTED: each call creates the job record, fires the
 * background runner (via the injected spawn seam — the agent layer never
 * imports one), and resolves IMMEDIATELY with a fire-and-forget ack. The
 * teacher's turn does NOT end at the call; the result arrives later as a
 * steer message that wakes the teacher in a new turn. See contracts.ts
 * "THE ASYNC PROTOCOL".
 */

/** What the job tools need at execute time (injected by the composition root). */
export interface JobToolContext {
	chatId: string;
	/** Creates the job record (deduped by toolCallId). */
	jobStore: JobStore;
	/** Fire the background runner for a fresh job — fire-and-forget. The
	 *  input rides along because the spawn happens MID-STREAM, before
	 *  onFinish persists the tool part — a transcript scan would race it. */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	/** Search-provider availability, retained for existing composition seams.
	 *  Research dispatch does not depend on it: web_fetch is keyless and
	 *  web_search reports a missing provider as a recoverable tool result. */
	searchAvailable?: () => boolean;
}

export const researchInputSchema = Type.Object({
	question: Type.String({
		description: "要回答的唯一个研究问题。请写得具体——研究者看不到课程的其余内容。",
	}),
	context: Type.Optional(
		Type.String({
			description: "你为什么需要它 / 课程为何需要它——用于聚焦简报。一两句话即可。",
		}),
	),
});

export const demoInputSchema = Type.Object({
	title: Type.String({ description: "演示卡片的短标题，例如“阻尼谐振子”。" }),
	brief: Type.String({
		description:
			"给构建者的精确需求：概念、参数/控件及各自作用、交互方式与视觉风格。" +
			"构建者看不到课程的其余内容——请提供它所需的一切，包括必要的公式与常数。",
	}),
});

export const visualInputSchema = Type.Object({
	brief: Type.String({
		description:
			"一张静态插图的精确需求：必须准确展示的内容——坐标、标签、比例、方向。" +
			"绘制者看不到课程的其余内容；错误或含糊的需求会产出错误的插图。" +
			"附图片时：要标注哪些特征，以及每个标签的内容。",
	}),
	image: Type.Optional(
		Type.String({
			description:
				"学习者图片文件（jpg、png、gif、webp、bmp）的路径，用于在其上标注——绘制者会在其上作图" +
				"而不是从零开始绘制。",
		}),
	),
});

export const pdfInputSchema = Type.Object({
	path: Type.String({ description: "学习者 PDF 的路径（相对或绝对），与其提供的完全一致。" }),
	question: Type.String({
		description:
			"你需要文档提供什么——要提取并形成简报的具体内容、解释或答案。" +
			"阅读者看不到课程的其余内容。",
	}),
});

/**
 * The per-call dispatch: create the job (idempotent by toolCallId), fire the
 * runner, and return the ack. Shared by all three tools — only kind differs.
 */
function dispatch(
	ctx: JobToolContext,
	kind: JobRecord["kind"],
	toolCallId: string,
	ack: string,
	input: ResearchInput | DemoInput | VisualInput | PdfInput,
): string {
	const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
	const job = existing ?? ctx.jobStore.createJob({ kind, chatId: ctx.chatId, toolCallId, input });
	if (!existing) ctx.spawn(job, input);
	return `已派发（任务 ${job.id}）。${ack}`;
}

const RESEARCH_ACK =
	"此调用即发即忘：继续本回合并继续教学——不要等待、轮询或提及等待。" +
	"研究简报就绪后会作为新消息送达，课程据此继续；使用时请引用其来源。";
const DEMO_ACK =
	"此调用即发即忘：继续本回合并继续教学——不要等待、轮询或提及等待。" +
	"测试过的演示就绪后会作为新消息送达并渲染在课程中；届时用它教学。";
const VISUAL_ACK =
	"此调用即发即忘：继续本回合并继续教学——不要等待、轮询或提及等待。" +
	"验证过的插图就绪后会作为新消息送达并渲染在课程中；届时引用它。";
const PDF_ACK =
	"此调用即发即忘：继续本回合并继续教学——不要等待、轮询或提及等待。" +
	"文档简报就绪后会作为新消息送达；请将其融入课程并引用其页码。";

const RESEARCH_DESCRIPTION =
	"派发一个后台网络研究代理：事实核查、最新数据，或你不确定的冷门细节。" +
	"该调用是异步且即发即忘——会立即返回，本回合继续；研究简报稍后送达，" +
	"作为新消息到达后课程据此继续。使用简报时请引用其来源。" +
	"绝不要用于你烂熟于心的内容、内部推理或数学。";
const DEMO_DESCRIPTION =
	"派发一个后台子代理，负责构建并无头测试交互式教学工具——单文件 HTML" +
	"演示（参数扫描、仿真、动画、采样），在课程中实时渲染。当概念是动态的时使用它：" +
	"需要扫动、动画或采样的内容，亲身体验胜过文字描述。" +
	"该调用是异步且即发即忘——会立即返回，本回合继续；测试过的演示稍后送达，" +
	"作为新消息到达。请写精确的需求：概念、控件、交互、风格。";
const VISUAL_DESCRIPTION =
	"派发一个后台子代理，手工绘制一张精确的 SVG 插图、渲染、查看渲染结果并迭代" +
	"直至正确。用于自动布局图表无法处理的精确空间图像：坐标几何、数轴、向量、" +
	"函数图像、物理布局。流程图/关系/分类请改用内联 mermaid。" +
	"传入 `image`（学习者的图片文件）则改为让绘制者在该图上标注——箭头、描边、标签。本地图片路径受文件访问设置约束；可用 ls 查看允许的文件夹。" +
	"该调用是异步且即发即忘——会立即返回，本回合继续；验证过的插图稍后送达，" +
	"作为新消息到达。";
const PDF_DESCRIPTION =
	"派发一个后台子代理，代你阅读学习者提供的 PDF（分诊、定向提取、可视化页面" +
	"阅读以处理公式和图表），并返回带页码引用的简报。当学习者给你 PDF 路径" +
	"且你需要其内容用于课程时使用。该调用是异步且即发即忘——会立即返回，本回合" +
	"继续；简报稍后作为新消息送达。若只是快速查看纯文本或图片文件，请直接使用 read 工具" +
	"而不要派发。本地 PDF 路径受文件访问设置约束；可用 ls 查看允许的文件夹。";

/**
 * Per-request job tool registry: each tool closes over the composition root's
 * context (chatId + jobStore + the spawn seam), so concurrent chats never
 * share state. chat-handler wires it each turn; tests wire their own.
 *
 * Research remains available without a search-provider key; the role's
 * existing user-toggle filtering still applies outside this registry.
 */
export function jobTools(ctx: JobToolContext): Record<string, AgentTool<any>> {
	return {
		research: {
			name: "research",
			label: "research",
			description: RESEARCH_DESCRIPTION,
			parameters: researchInputSchema,
			execute: serverExecute("research", researchInputSchema, (input, { toolCallId }) =>
				dispatch(ctx, "research", toolCallId, RESEARCH_ACK, input),
			),
		},
		demo: {
			name: "demo",
			label: "demo",
			description: DEMO_DESCRIPTION,
			parameters: demoInputSchema,
			execute: serverExecute("demo", demoInputSchema, (input, { toolCallId }) => dispatch(ctx, "demo", toolCallId, DEMO_ACK, input)),
		},
		visual: {
			name: "visual",
			label: "visual",
			description: VISUAL_DESCRIPTION,
			parameters: visualInputSchema,
			// An unusable image path fails the CALL (no job is created), so the
			// teacher corrects the path in the same turn.
			execute: serverExecute("visual", visualInputSchema, async (input, { toolCallId, signal }) => {
				if (!ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId) && input.image !== undefined) await checkLearnerImage(input.image);
				signal?.throwIfAborted();
				return dispatch(ctx, "visual", toolCallId, VISUAL_ACK, input);
			}),
		},
		pdf: {
			name: "pdf",
			label: "pdf",
			description: PDF_DESCRIPTION,
			parameters: pdfInputSchema,
			execute: serverExecute("pdf", pdfInputSchema, (input, { toolCallId }) => {
				// Admission uses the current boundary; the queued reader checks
				// again at job start. Preserve raw args/history and replay IDs.
				if (!ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId)) resolveSourcePath(input.path);
				return dispatch(ctx, "pdf", toolCallId, PDF_ACK, input);
			}),
		},
	};
}

export type ResearchInput = Static<typeof researchInputSchema>;
export type DemoInput = Static<typeof demoInputSchema>;
export type VisualInput = Static<typeof visualInputSchema>;
export type PdfInput = Static<typeof pdfInputSchema>;
