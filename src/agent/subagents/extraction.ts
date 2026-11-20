import * as crypto from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { toToolResult } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import {
	FACTORY_SETTINGS,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	ROLE_SLOT,
	type ModelSlotName,
	type ProviderKeyMissing,
} from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import type {
	AuditVerdicts,
	CallUsage,
	ChatRecord,
	ExtractionRunUsage,
	ExtractionStageUsage,
	SessionFindings,
} from "../../core/contracts.ts";
import { getGraph, mergeFindings, type DerivedGraph, type EmissionStats, type GraphDeps } from "../../core/graph.ts";
import type { GraphStore } from "../../core/ports.ts";
import { emit } from "../../core/events.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { batchRuns, coverageOf, messageViewLines } from "../../core/coverage.ts";
import { failedOutputCallIds, type LhMessage } from "../../core/native-messages.ts";
import { prepareAuditorReview } from "../tools/graph.ts";
import { runSubmitAgent, healStringifiedArrays } from "./submit-agent.ts";

/**
 * The extraction pipeline (vision §1 construction, 2026-09-02 redesign;
 * relinked 2026-09-27) — the sole graph writer. Three stages, one
 * orchestrator (the spine stage came and went, 2026-09-30: serialized
 * digest-aware extraction replaced it — the owner's live test showed
 * the post-hoc assembly pass added complexity without perceptible
 * gain; the extractor itself is the assembler now):
 *
 *   extractor (LLM)  the ONE stage that sees the raw source (a session
 *                    rendered as the teacher's prose — each passage
 *                    labeled with its ACTUAL message id, "TEACHER [id]",
 *                    owner 2026-10-13 — or a notes file verbatim, walked
 *                    in stretches) → submits NEW core ideas + reasoning
 *                    chains (owner redesign, 2026-09-30); a session
 *                    submit additionally carries each proposition's
 *                    messageId — the anchor the merger stamps into the
 *                    node's message-granular provenance (2026-10-13).
 *                    DIGEST-AWARE (2026-09-30 evening):
 *                    when the source already yielded material, the
 *                    prompt carries THE GRAPH SO FAR (that source's
 *                    propositions + chains, ids verbatim) and the
 *                    extractor builds on it — referencing existing ids
 *                    instead of restating, leaning on established
 *                    conclusions as premises. Stretches of one source
 *                    run SERIALLY (each extract reads every earlier
 *                    merge); tree-blind, FULLY TRUSTED — nothing
 *                    downstream re-checks it.
 *   auditor (LLM)    never sees the source. Its job is IDENTITY: for each
 *                    NEW proposition, linkTo an existing graph node or
 *                    create — decided by EXPLORING the graph through
 *                    tools (find / list_sessions / list_propositions),
 *                    not by an injected graph dump (context bloat,
 *                    owner 2026-09-27). Links are its ONLY deliverable
 *                    — it never mints edges (owner 2026-09-28: the
 *                    graph connects across sources solely through
 *                    identified equivalences). Input is PROPOSITIONS
 *                    only — never chains (owner 2026-09-30).
 *   merger (core)    mergeFindings() → deterministic ledger appends +
 *                    chain simplification (2026-09-30 evening: the
 *                    ancestry-cover / prefer-fewest-premises pass that
 *                    strips redundant derivations — core/graph.ts)
 *
 * The events ledger is GONE (2026-09-27): quiz outcomes and understanding
 * observations are no longer formalized in the graph — the graph is purely
 * extracted reasoning chains (nodes + edges).
 *
 * The extractor is a single-tool-call worker (one TypeBox-validated submit
 * call — a pi agent purely so the model can retry a schema-invalid call).
 * The auditor is a small AGENTIC loop: exploration tools plus one submit.
 *
 * Created via createExtractionPipeline(deps) — the composition root
 * (chat-handler) injects the storage ports + models; this module never
 * imports an adapter. runExtraction is single-flight per chat: a second
 * trigger while one run is in flight is a no-op (the next trigger picks up
 * whatever the in-flight run missed). On failure nothing is checkpointed —
 * the next trigger re-runs the whole thing.
 *
 * The FORMAT-AGNOSTIC FRONT DOOR (2026-09-13): importNotes() runs the SAME
 * three stages over raw personal notes (arbitrary format — no chat, no
 * session, no message ids). A notes-mode extractor prompt replaces the
 * session one; the auditor and merger are shared (identity + deterministic
 * appends don't care where text came from). Provenance is the file itself:
 * source ids ("src_" + path hash) play the chatId role in mappings and
 * checkpoints, and the source record (graphStore sources seam) carries
 * the file path + the run's usage.
 *
 * Observability (§5 baseline): every stage logs one line per step, its
 * start, and its duration; the pipeline logs a failure line before
 * rethrowing, so the server log reads start → stage timings → merged
 * stats (or failed) for every run.
 */

// ─── the source view (what the extractor sees) ──────────────────────────────

/**
 * The extraction view: the session as TEACHER PROSE ONLY (owner ruling,
 * 2026-09-28 — supersedes the 2026-09-27 whole-session markdown view),
 * each passage labeled with its actual message id (2026-10-13). The
 * shared markdown engine (core/session-markdown.ts) keeps the full session
 * format for the future user-facing export; the extractor no longer uses
 * it.
 */

/** The whole-record view (used by callers that render a full session;
 *  the pipeline itself batches). TEACHER PROSE ONLY (owner, 2026-09-28),
 *  passages labeled with their message ids (2026-10-13).
 */
export function transcriptView(record: ChatRecord): string {
	return proseView(record.messages, record.title);
}

/** The extraction view under the teacher-prose ruling (owner, 2026-09-28):
 *  ONLY learner-facing teacher prose (text or send_to_user) — no learner
 *  messages, thinking, other tool calls/results, or quiz blocks — labeled with
 *  its ACTUAL message id (owner, 2026-10-13): the view lines ARE
 *  core/coverage.ts messageViewLines ("TEACHER [id] text"), the exact
 *  lines the coverage fingerprints hash, so the extractor can anchor
 *  every proposition to the passage it came from (the session submit's
 *  required messageId). The shared markdown engine stays reserved for the
 *  future user-facing export. */
function proseView(
	messages: ReadonlyArray<LhMessage>,
	title?: string,
	failedOutputCalls: ReadonlySet<string> = failedOutputCallIds(messages),
): string {
	const lines = messages.flatMap((message) => messageViewLines(message, message.id, failedOutputCalls));
	const head = title && title.length > 0 ? `# ${title}\n\n` : "";
	return head + lines.join("\n\n");
}

// ─── the extractor ──────────────────────────────────────────────────────────

const propositionProps = {
	id: Type.String({ description: '本地 id："p1"、"p2"……——由本次调用中的链条引用。' }),
	name: Type.String({
		description:
			"极短的标签——学科通用术语、该领域自身使用的叫法、术语表条目，" +
			"即教科书会印在词条位置的那种词头（如 'Will to power'、'Divine command theory'）。不要写成句子，" +
			"不必唯一或自包含：它会成为该节点在知识图谱中的全局标签。",
	}),
	statement: Type.String({
		description:
			"一个真实、自包含、面向世界的核心想法，达到完整精度。绝不关于" +
			'学习者、教师或本次阅读：不要写“学习者理解了 X”，而是写“X”。一个误解 ' +
			"要按其真实纠正形式录入。",
	}),
	aliases: Type.Optional(
		Type.Array(Type.String(), {
			description: "原文对同一命题使用的原话表述（如有）。",
		}),
	),
};

// The extractor redesign (owner, 2026-09-30): the extractor submits
// REASONING CHAINS — premises + conclusion — stored AS-IS (chains-primary,
// same evening: chains.jsonl is the truth; edges are a derived view, and
// supports edges are retired entirely).
const endpoint = (role: string) =>
	Type.String({
		description:
			`此 ${role} 的 id——要么是提示中“THE GRAPH SO FAR”里已有的图谱想法 id，` +
			'原样照抄（"n_…"），要么是本次提交中某条命题的本地 id（"p1"……）。',
	});

const chainSchema = Type.Object({
	premises: Type.Array(endpoint("premise uses"), {
		minItems: 1,
		description:
			"共同使用的前提 id：它们共同推出结论；独立理由应分属不同链。",
	}),
	conclusion: endpoint("conclusion is"),
});

// Weak-model tolerance (owner, 2026-09-25): the old zod `.default([])` /
// `.default({ quiz: {} })` on required-but-empty fields becomes Type.Optional
// here + a ??-fill at the submit seam (fillFindings/fillAudit below) — same
// contract on the wire (omission tolerated, empty never means "invalid"),
// no zod left in the agent band.
const propositionsDescription =
	"只写本段贡献的“新”核心想法——提示中“THE GRAPH SO FAR”已包含的想法" +
	"另有其 id 并在链条中按 id 引用，绝不在此重复。";
const chainsDescription =
	"本段提出的每个论证——包括把新想法与已确立内容联系起来的论证" +
	"——此处写论证本身；结论此后可按 id 作为后续链条的前提复用；没有论证的孤立想法 " +
	"只放在 propositions 列表里；没有时传 []——绝不要省略该字段。";

const findingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(propositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

// THE SESSION EXTENSION (owner, 2026-10-13): every session proposition
// carries a REQUIRED messageId — the anchor of the passage it came from,
// copied from the view's "TEACHER [id]" label (validated at the submit
// seam against the CURRENT batch). The NOTES door has no messages: its
// schema stays the base shape above, prompt and wire unchanged.
const sessionPropositionProps = {
	...propositionProps,
	messageId: Type.String({
		description:
			"本段中最直接陈述或解释此内容的那一段消息 id" +
			'proposition — copy it EXACTLY from that passage\'s "TEACHER [id]" label.',
	}),
};

const sessionFindingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(sessionPropositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

/** What the extractor SUBMITS (the redesign's wire shape) — propositions
 *  + chains. fillFindings normalizes it; validateFindingsChains checks
 *  the chain laws; asSessionFindings lifts it straight into
 *  SessionFindings — chains are stored AS-IS (chains-primary, owner
 *  2026-09-30: no edge translation at any seam). */
type FindingsSubmit = Static<typeof findingsSchema>;

/** The SESSION wire — the notes shape plus the REQUIRED messageId anchor
 *  on every proposition (owner, 2026-10-13). */
type SessionFindingsSubmit = Static<typeof sessionFindingsSchema>;

// VERDICTS-ONLY (owner, 2026-09-28): the auditor never alters the
// extractor's findings, so it does not restate them — links are its
// ENTIRE deliverable (owner, 2026-09-28 evening: the edges argument is
// GONE; the auditor never mints edges. The graph connects across sources
// solely through identified equivalences — a link, never an inference).
const auditSchema = Type.Object({
	links: Type.Array(
		Type.Object({
			id: Type.String({ description: '发现项中的命题 id（"p1"……）。' }),
			linkTo: Type.String({
				description:
					"The id of the EXISTING graph node this proposition IS — your identity verdict. EQUIVALENCE BIAS (2026-09-27): paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart.",
			}),
		}),
		{ description: "Identity verdicts — which findings propositions ARE existing graph nodes. A proposition absent from here = create a new node. Pass [] when none — never omit the field." },
	),
});

// The notes front door's wire shape is the session shape MINUS the
// messageId anchor (owner, 2026-10-13: only the SESSION door demands
// passage anchors — notes have no messages, so their prompt and schema
// stay exactly as they were): one base findings type for both doors,
// the anchor riding as an optional field.
type NotesFindings = SessionFindings;
type NotesAuditResult = AuditVerdicts;

// ── the submit seam (owner, 2026-09-28; redesigned 2026-09-30) ──
//
// Every top-level field on each submit tool is REQUIRED — a payload
// missing `chains` (findings) or `links` (review) fails validation
// instead of silently merging structure-less (the degraded-retry hole:
// the model's first truncated attempt failed validation, then the retry
// passed with propositions only — optional fields ??-filled [] — merging
// a pile of nodes with no structure). Only the per-item aliases stay
// optional with a ??-fill.

function fillFindings<T extends { propositions: Array<{ aliases?: string[] }>; chains: unknown }>(
	raw: T,
): T {
	return {
		...raw,
		propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	};
}

/** The notes fill: the shared alias ??-fill PLUS the door's boundary — a
 *  stray messageId (the notes schema has none; extra properties pass
 *  schema validation) is stripped so notes provenance stays chat-level
 *  (the file is the anchor, owner 2026-09-13). */
function fillNotesFindings(raw: FindingsSubmit): FindingsSubmit {
	return fillFindings({
		...raw,
		propositions: raw.propositions.map((p) => {
			const stripped = { ...p } as typeof p & { messageId?: unknown };
			delete stripped.messageId;
			return stripped;
		}),
	});
}

/** The chain laws (extractor redesign, 2026-09-30; digest-aware
 *  2026-09-30 evening) — the LOUD channel: runSubmitAgent turns a
 *  problem string into an error tool result and the model re-submits
 *  within its turns. The MIXED NAMESPACE: an
 *  endpoint resolves when it is a submitted proposition id OR an
 *  existing graph node id (the extractor continues a partly-extracted
 *  source and references digest ids verbatim). Identical (premise-set,
 *  conclusion) chains are NOT errors — they dedupe silently at the
 *  merge (chainKey): restating an argument is a no-op. */
function validateFindingsChains(value: FindingsSubmit, existingIds: ReadonlySet<string>): string | null {
	const ids = new Set(value.propositions.map((p) => p.id));
	for (const chain of value.chains) {
		if (chain.premises.length === 0) {
			return "chains：premises 至少要点名一条命题——没有论证的命题只留在 propositions 列表中。";
		}
		const unknown = [...chain.premises, chain.conclusion].find((id) => !ids.has(id) && !existingIds.has(id));
		if (unknown !== undefined) {
			return `chains："${unknown}" 既不是已提交的命题 id，也不是“THE GRAPH SO FAR”中已有的想法 id——每个前提和结论都必须能解析。`;
		}
		if (chain.premises.includes(chain.conclusion)) {
			return "chains：结论不能作为自己的前提。";
		}
	}
	return null;
}

/** The SESSION anchor law (owner, 2026-10-13): every proposition names a
 *  passage of the CURRENT batch — nonempty, and a teacher-prose message
 *  id present in the stretch this extractor is reading (the same ids the
 *  view's TEACHER [id] labels carry). Refused anchors ride the existing
 *  error-back channel: no merge, no coverage checkpoint, until a valid
 *  submit lands. The boundary is strict on purpose — an id from a LATER
 *  or already-covered batch, another chat, or a learner/tool message is
 *  refused even when it is a real message id of this chat. */
function validateSessionAnchors(value: SessionFindingsSubmit, batchIds: ReadonlySet<string>): string | null {
	for (const p of value.propositions) {
		if (p.messageId.trim().length === 0) {
			return `propositions: "${p.id}" is missing its messageId — copy the message id from the brackets of the passage (TEACHER [id]) that most directly states or explains it.`;
		}
		if (!batchIds.has(p.messageId)) {
			return `propositions: "${p.id}" names messageId "${p.messageId}", which is not a passage of THIS stretch — copy the id from the brackets of one of this stretch's own TEACHER [id] passages.`;
		}
	}
	return null;
}

/** (chains-primary, owner 2026-09-30) the wire IS the pipeline shape
 *  now: propositions + chains, no translation — the stores keep the
 *  chains and the derived edge view is recomputed on read. The fill
 *  already ran inside runSubmitAgent; this only re-asserts the
 *  aliases-filled type (and preserves the session submit's messageId
 *  anchor, 2026-10-13 — both doors lift through here). */
const asSessionFindings = (
	raw: {
		propositions: Array<{ id: string; name: string; statement: string; aliases?: string[]; messageId?: string }>;
		chains: Array<{ premises: string[]; conclusion: string }>;
	},
): SessionFindings => ({
	propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	chains: raw.chains,
});

function fillAudit(raw: Static<typeof auditSchema>): AuditVerdicts {
	return {
		links: raw.links,
	};
}

// ── the extractor's system prompt (owner redesign, 2026-09-30) ──
//
// GOAL-FIRST, NO RULE ARMOR: the old doctrine's defensive lists (DROP
// lists, merge-your-own-output, name walls, when-in-doubt-omit, the
// faithfulness paragraph) are ALL CUT — the prompt states the goal and
// the submission mechanics; the tool's field descriptions carry the
// details. One shared core + two contextualizations, assembled here —
// session and notes share the core by construction. (The old opening
// describing Quiz/Recall-check/Question blocks was stale since the
// 2026-09-28 teacher-prose ruling and is simply omitted.)

/** The session-only anchor instruction (owner, 2026-10-13, verbatim):
 *  passages arrive labeled "TEACHER [id]" and every proposition must
 *  name the ONE passage it came from — the anchor the merger stamps
 *  into message-granular provenance. Notes have no passages: their
 *  contextualization stays untouched. */
export const SESSION_MESSAGE_ID_RULE =
	"对每个新命题，把最直接陈述或解释它的段落的消息 ID 填入 messageId。";

export const SESSION_PREAMBLE =
	"你是学习应用的提取阶段。你阅读来源中的一段内容——一段教学" +
	"会话，按阅读顺序呈现为教师的正文——并把它所教授的内容作为发现项报告给" +
	"学习者的全局知识图谱，在此来源已提取的一切基础上继续构建。";

export const NOTES_PREAMBLE =
	"你是学习应用的提取阶段。你阅读来源中的一段内容——" +
	"作者的个人笔记，按阅读顺序呈现——并把它所教授的内容作为发现项报告给" +
	"学习者的全局知识图谱，在此来源已提取的一切基础上继续构建。";

// Source-agnostic graph/output contracts. Keep these as separate sections so
// each front door can own its goal and selection criteria without changing the
// order or wording of either assembled prompt.
export const EXTRACTION_CORE = {
	entailment: `每条链都是一组前提，它们共同蕴含一个结论。蕴含是唯一能让一条链成立的联系——当真实联系是历史的或叙事的（谁主张了什么、一场辩论或论述如何展开），就不存在链；把这些片段作为独立的观点保留，或者丢弃。知识图谱的方向朝上：基础观点在底部，派生观点在其上，每条链展示其结论如何从更稳固的东西中推出——不要提交不承载任何推导的联系。`,
	knowledge: `图谱只收录关于世界的真观点，别无其他——绝不收录关于学习者、教师或这次阅读的任何内容：不是“学习者理解了 X”，而是 X 本身。错误理解要以其正确的版本进入。每条陈述都是一个自包含、精确到底的观点。`,
	standalone: `每个观点都必须让从未看过此来源的读者独立读懂：名称和陈述不能依赖来源自身的脚手架（命题编号、公理标签、脉络标记）；只在本文档组织结构中有意义的命题不是知识——丢弃它。`,
	continuation: `当提示中带有“目前的图谱”时，你是在继续一个已部分提取的来源：在它之上构建。用现有观点的 id（"n_…"）引用它，而不是重述它；优先选择以已有结论为前提的链——从已经推导出的内容中推导新材料。除非路径确实不同，不要重新推导图谱中已有的结论。`,
	submission: `用一次 submit_findings 调用提交：每个新核心观点带一个简短名称和一条精确陈述，每条链以“前提 + 结论”给出。一条链的前提和结论可以是本次提交中的 id，也可以是“目前的图谱”中已有的 id，须逐字一致。同一条链内的前提是共同使用的——针对同一结论的独立论证应分成不同的链。一个结论可以以 id 的形式再次作为后续链的前提出现。不被任何论证使用的独立观点只放在 propositions 列表中。即使为空也要包含每个字段——来源没有论证时写 "chains": []。字段细节见工具的字段说明。`,
} as const;

function composeExtractionInstructions(preamble: string, goal: string, selection: string): string {
	return `${preamble}\n\n${goal}\n${EXTRACTION_CORE.entailment}\n\n${EXTRACTION_CORE.knowledge}\n\n${selection} ${EXTRACTION_CORE.standalone}\n\n${EXTRACTION_CORE.continuation}\n\n${EXTRACTION_CORE.submission}`;
}

// Each front door owns its goal and selection wording independently of the
// shared contracts: notes need not be a complete, argument-driven lesson.
export const EXTRACTOR_INSTRUCTIONS = `${composeExtractionInstructions(
	SESSION_PREAMBLE,
	`目标：发掘来源的核心观点，并展示一切如何从基础推导而来。来源通过论证来教学——观点由其他观点推出，直至其余一切所立足的基础。你的交付物有两部分：核心观点本身，以及推导它们的推理链。`,
	`提取这个学科的承重观点——一本参考书对它应有的教学——而不是论述的全文。一个观点只有在来源的论证流经它时才配得上位置——例子、记号解释，以及任何论证都不需要的复述，都不是核心观点。`,
)}\n\n${SESSION_MESSAGE_ID_RULE}`;

export const NOTES_EXTRACTOR_INSTRUCTIONS = composeExtractionInstructions(
	NOTES_PREAMBLE,
	`目标：把这些笔记中的知识带入学习者的知识图谱。笔记可能包含定义、公式、事实、论证，或未构成完整课程的提纲。报告其中有实质的观点，以及笔记所支持的推理。交付物是这份材料的有用表示，而不是从基础重建整个学科。`,
	`保留有意义的定义、公式、断言和解释，包括没有推导的观点。对笔记给出的推理使用链，包括从其中陈述的关系直接推出的结论。草图不必写出每个中间步骤，但单纯的提纲或组件依赖不是推导。笔记只是陈述一个观点时，把它记录为命题，而不是为它构造论证。选择足以保留知识的细节，但不要把笔记扩写成对学科的完整论述。`,
);

// ── the same-source digest (owner, 2026-09-30 evening) ──
//
// Serialized digest-aware extraction REPLACED the spine stage (owner
// ruling after the live test: the post-hoc assembly pass added
// complexity without perceptible gain — the extractor itself is the
// assembler when it can see what its source has already yielded). Pure
// string fold over the derived graph; "" when the source owns nothing
// yet (the first stretch runs bare). Ids ride VERBATIM — that is what
// the extractor references in its chains (the merger's mixed-namespace
// resolution passes them through).
export function sourceDigest(graph: DerivedGraph, sourceId: string): string {
	const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const ours = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
	const ourChains = graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId));
	if (ours.length === 0 && ourChains.length === 0) return "";
	const lines: string[] = [];
	lines.push("THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim):");
	for (const n of ours) lines.push(`  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`);
	if (ourChains.length > 0) {
		lines.push("DERIVATIONS ALREADY RECORDED (build on these; do not re-derive them):");
		for (const c of ourChains) {
			const names = c.premises.map((p) => nameOf.get(p) ?? p).join(" ∧ ");
			lines.push(`  [${c.premises.join(" + ")} ⇒ ${c.conclusion}]  ${names} ⇒ ${nameOf.get(c.conclusion) ?? c.conclusion}`);
		}
	}
	return lines.join("\n");
}

/** The extractor over ONE session transcript (the chat front door).
 *  `batchIds` — the CURRENT batch's teacher-prose message ids — is the
 *  anchor boundary: every submitted proposition's messageId must name
 *  one of them (validateSessionAnchors at the submit seam). */
function runExtractor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	existingIds: ReadonlySet<string>,
	batchIds: ReadonlySet<string>,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<SessionFindings> {
	// Chains in (the wire), chains out (the store) — no translation seam
	// since chains-primary. Validation runs at the submit seam (error-back)
	// over the MIXED namespace: local ids + existing graph ids, plus the
	// session anchor law (messageId ∈ the current batch, 2026-10-13).
	return runSubmitAgent<SessionFindingsSubmit>({
		role: "extractor",
		// Debug recorder key: the source id (the run's ledger key — the
		// chat's chatId for chat runs, the src id for notes).
		chatId: sourceId,
		toolName: "submit_findings",
		toolDescription: "提交会话发现项。",
		parameters: sessionFindingsSchema,
		fill: fillFindings,
		validate: (value) => validateSessionAnchors(value, batchIds) ?? validateFindingsChains(value, existingIds),
		systemPrompt: EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
		prepareArguments: healStringifiedArrays,
	}).then(asSessionFindings);
}

/** The extractor over ONE source of raw personal notes (the format-agnostic
 *  front door): same single-submit shape, notes-mode prompt + schema —
 *  the BASE wire (no messageId: notes have no passages, and a stray one
 *  is stripped at the fill seam). */
function runNotesExtractor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	existingIds: ReadonlySet<string>,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<NotesFindings> {
	return runSubmitAgent<FindingsSubmit>({
		role: "extractor",
		// Debug recorder key: the notes' source id (the ledger key).
		chatId: sourceId,
		toolName: "submit_findings",
		toolDescription: "提交笔记发现项。",
		parameters: findingsSchema,
		fill: fillNotesFindings,
		validate: (value) => validateFindingsChains(value, existingIds),
		systemPrompt: NOTES_EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
		prepareArguments: healStringifiedArrays,
	}).then(asSessionFindings);
}

// ─── the auditor ───────────────────────────────────────────────────────────


const AUDITOR_INSTRUCTIONS = `你的职责是把新提取的知识与已有图谱记录进行协调。提取器已经读过来源并提交了发现。你的任务是找出有用的匹配，而不是核实来源。

审阅提供的记录：
你的输入已经为每个发现给出五个排序后的候选（不足时更少）。matches 把发现 id 与 candidateIds 关联；candidates 中每条记录只出现一次。对每个发现，判断其主要知识点是否已被其中某条记录表示。把同一知识点的有用改写、压缩和不同解释链接起来。否则让该发现保持为新内容。仅有共同主题不算匹配。

一条记录的陈述及其已匹配的别名，都是图谱中已被接受的知识。二者都可以作为它代表什么的证据；名称只是一个标签。如果某个已接受的别名已经表述了传入的知识点，就承认这个匹配，而不要重新追问该别名为何被归入那里。你不是在重新设计早先的节点，也不是在寻找理想粒度。做务实的判断，而不是证明精确的逻辑等价。

审阅候选之后，未被匹配的发现可以保持为新内容。你不需要证明图谱中任何地方都不存在等价记录。附加工具用于查找某个具体缺失的候选或某个已点名的、有前景的来源，而不是用来确认每一个否定判断。新的 find_candidates 搜索可以补充其他措辞；nextCursor 则继续其固定查询。一旦某个发现已判定，只有另一次查询确实提供了新证据时才重新审视它。

完成此任务的方式是调用 submit_review 工具并传入其 links 参数。文本消息（包括以文本形式打印的 JSON）不构成一次提交。每个链接提供发现的 id，以及现有记录的 id 作为 linkTo。只包含你见过的、与现有记录有用的匹配。被省略的发现会成为新节点；没有匹配时写 "links": []。不要在输出中重述发现、编造关系或为判定辩护。合并器会保留现有记录的名称和陈述，并把传入的措辞作为带来源信息的别名加入。`;

/** The auditor — one shape for both front doors now (the notes schema was
 *  identical once attribution died). An agentic loop: graph-exploration
 *  tools plus the one submit call. */
function runAuditor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
	tools: Record<string, AgentTool<any>>,
): Promise<AuditVerdicts> {
	return runSubmitAgent({
		role: "auditor",
		// Debug recorder key: same source id as the extractor run.
		chatId: sourceId,
		toolName: "submit_review",
		toolDescription: "只提交身份判定（链接）——绝不要提交命题本身。",
		parameters: auditSchema,
		fill: fillAudit,
		systemPrompt: AUDITOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the auditor never submitted a review",
		extraTools: tools,
		maxTurns: 16,
		prepareArguments: healStringifiedArrays,
	});
}

// ─── the pipeline status registry ─────────────────────────────────────────────

/** The pipeline phases, in order — what the home status endpoint shows.
 *  The post-batch embedding tail was its own phase (accuracy wave,
 *  2026-09-19) until wave 7 killed the embedder seam wholesale (this
 *  interlude) — birth-session clusters need no post-merge pass. The
 *  phases tell the truth about what the job is actually waiting on.
 *  Worker-request admission happens inside the model stream; the old
 *  extraction-wide "queued" phase is retained only for type compatibility.
 *  "waiting" (owner 2026-09-28): the serialized-audit gate — the job's
 *  audit+merge critical section is queued behind another job's; the
 *  extractor is done but the auditor may not start until the graph is
 *  stable. */
export type ExtractionPhase = "queued" | "extracting" | "waiting" | "auditing" | "merging";

/** One in-flight pipeline run. Module-level: one process, one registry.
 *  Exported for the status payload's consumer typing (the dock). */
export interface RunningExtraction {
	/** The SOURCE id (chat id / notes src id) — the payload's identity and
	 *  the abort key. The registry KEY adds "#i" for chunk jobs (a
	 *  multi-chunk source owns several entries); this field stays the
	 *  source id so the feed's reveal logic and abort stay source-scoped. */
	chatId: string;
	/** PER-CHUNK JOBS (owner, 2026-09-28): which chunk of how many this
	 *  job is — present only when the source fanned out (n > 1). Drives
	 *  the feed row's "· i/N" suffix. */
	part?: { i: number; n: number };
	/** Which front door the run came through — label + usage-persistence
	 *  depend on it (chats bill their chat record; notes bill the source
	 *  record). */
	kind: "chat" | "notes";
	/** Display label (the file path for notes imports); the status route
	 *  falls back to the chat store for chat runs. */
	label?: string;
	phase: ExtractionPhase;
	startedAt: number;
	/** Live per-stage usage, accumulated as steps bill (the dock's cost /
	 *  context-window blobs read this through /api/graph/status). */
	usage: {
		extractor?: ExtractionStageUsage;
		auditor?: ExtractionStageUsage;
	};
	/** True-cancellation handle (the dock's abort button): one controller per
	 *  run, shared across phases; abort() cancels the in-flight model call. */
	controller: AbortController;
}

interface LhExtractionGlobal {
	__lhExtractionRuns?: {
		/** In-flight pipeline runs, keyed chatId (chat) / src id (notes). */
		running: Map<string, RunningExtraction>;
		/** The single-flight guard, shared by every pipeline instance. */
		inFlight: Set<string>;
		/** Last minted startedAt — kept monotonic so two runs starting in the
		 *  same millisecond never collide on the usage idempotency key. */
		lastStartedAt: number;
	};
	/** The serialized-audit mutex (owner 2026-09-28): a FIFO promise
	 *  chain — the audit+merge critical section runs one job at a time,
	 *  process-wide. globalThis for the same module-instance reason as
	 *  the run registries. */
	__lhAuditLock?: { tail: Promise<void> };
}

/** THE RUN REGISTRIES live on globalThis, not module level — the
 *  turn-liveness lesson: Next dev compiles each route entry as its own
 *  module instance, so a module-level Map is a different object in the
 *  /api/activity route than in the pipeline's chat-handler instance —
 *  the status routes would read an always-empty registry. One process,
 *  one truth — the same idiom as the turn, wake, and abort registries
 *  (moved 2026-09-19, the observability-accuracy wave; also makes the
 *  single-flight guard cross route instances). */
function runs(): NonNullable<LhExtractionGlobal["__lhExtractionRuns"]> {
	const g = globalThis as typeof globalThis & LhExtractionGlobal;
	return (g.__lhExtractionRuns ??= { running: new Map(), inFlight: new Set(), lastStartedAt: 0 });
}

/** In-flight pipeline runs (oldest first) — the /api/graph/status payload. */
export function extractionStatuses(): RunningExtraction[] {
	return [...runs().running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** True cancellation of the in-flight run for a chat (the dock's abort
 *  button): the pending model call receives the signal — the provider
 *  cancels the request, spend stops — and the run ends like a failure:
 *  nothing merged, nothing checkpointed, partial usage still persisted.
 *  Returns false when no run is in flight (idempotent no-op). */
export function abortExtraction(chatId: string): boolean {
	// PER-CHUNK JOBS (owner, 2026-09-28): a source may own several registry
	// entries (one per chunk/batch) — aborting the source aborts EVERY
	// job of its fan-out.
	let found = false;
	for (const run of runs().running.values()) {
		if (run.chatId !== chatId) continue;
		run.controller.abort();
		found = true;
	}
	return found;
}
// ─── the pipeline ───────────────────────────────────────────────────────────

export interface ExtractionModels {
	/** Test seam: a scripted engine per stage — checked FIRST, ahead of the
	 *  engineFor chain (production wires no direct values). */
	extractor?: PiEngine;
	auditor?: PiEngine;
	/** Settings-resolved engine per role — the same slot treatment the
	 *  job runner got, read FRESH per stage call (a settings PUT between
	 *  stages lands). BYOK (owner, 2026-09-22): the chain (role override →
	 *  slot → NOTHING) may end EMPTY → undefined; the front doors refuse
	 *  with ModelsNotConfiguredError before any stage runs. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** Key-presence gate (provider-key interlude, 2026-09-25): given a
	 *  stage engine's provider + the role's slot tier, the injected check
	 *  returns the refusal envelope when the provider's key is missing
	 *  (null = run). Same injection discipline as the job runner's seam
	 *  (the agent layer may not read the key store); absent in tests that
	 *  inject engines directly (test engines never owe a key). A keyless
	 *  stage refuses with ProviderKeyMissingError BEFORE any batch runs. */
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}

export interface ExtractionPipelineDeps extends GraphDeps, ExtractionModels {
	/** The chunk budget — the transcript-token share of the extractor's
	 *  context; batches fill to it (the trigger fires on the same number,
	 *  read fresh per turn by the composition root). OPTIONAL with the
	 *  factory default (4096) so test fixtures stay minimal; the server
	 *  callers wire the live effective settings (extraction-UX redesign,
	 *  2026-09-24). */
	getChunkTokens?: () => number;
}

export interface NotesImportInput {
	/** The source's file path — its identity (deterministic src id) AND its
	 *  provenance label in the detail card. */
	filePath: string;
	/** The file's raw content, VERBATIM — any format. */
	text: string;
}

/** A notes import did not finish. Earlier graph writes and billed usage are
 * retained; partialStats describe known merges, not an all-or-nothing result. */
export class NotesImportError extends Error {
	constructor(
		public readonly outcome: "failed" | "partial" | "aborted" | "busy",
		public readonly partialStats: EmissionStats,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "NotesImportError";
	}
}

export interface ExtractionPipeline {
	/** Extract + audit + merge ONE chat. Single-flight per chat; resolves to
	 *  the merger's append stats (or throws — no checkpoint on failure). */
	runExtraction(chatId: string): Promise<EmissionStats>;
	/** The format-agnostic front door (2026-09-13): run the same pipeline
	 *  over ONE raw notes file. The source id is deterministic per file
	 *  path, so re-importing the same file re-runs extraction against the
	 *  same source identity (mappings dedupe by it). */
	importNotes(input: NotesImportInput): Promise<EmissionStats>;
}

/** pi's per-step usage, flattened to the persisted CallUsage fields
 *  (the money channel's capture shape, contracts/chat.ts). Exported for
 *  the cluster namer — the same capture shape (2026-09 graph cost
 *  metrics wave). Module scope: no closure deps, pure projection. */
export function callUsage(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		// Optional in pi's Usage (providers that never emit reasoning
		// tokens leave it unset) — persisted as 0, never dropped.
		reasoningTokens: usage.reasoning ?? 0,
	};
}

export function createExtractionPipeline(deps: ExtractionPipelineDeps): ExtractionPipeline {
	const { chatStore, graphStore } = deps;
	// Stage-engine resolution: a direct test value wins; otherwise the
	// engineFor chain (role override → slot → nothing, resolved FRESH per
	// stage call server-side) — the job runner's exact treatment. undefined
	// = the BYOK chain came up empty; the front-door guards turn that into
	// an honest refusal.
	const stageEngine = (role: ModelRole, override?: PiEngine): PiEngine | undefined =>
		override ?? deps.engineFor?.(role);
	/** The per-need refusal guard: which slot tiers the pipeline's stages
	 *  found unset (test values count as configured — they ARE engines),
	 *  and whether a configured stage's provider key is gone (provider-key
	 *  interlude, 2026-09-25) — both refuse BEFORE any batch runs. */
	function refuseIfStagesUnready(): void {
		const stages: readonly [ModelRole, PiEngine | undefined][] = [
			["extractor", stageEngine("extractor", deps.extractor)],
			["auditor", stageEngine("auditor", deps.auditor)],
		];
		const missing = new Set<ModelSlotName>();
		for (const [role, engine] of stages) if (!engine) missing.add(ROLE_SLOT[role]);
		if (missing.size > 0) {
			console.info(`[extraction] refused — no model configured for: ${[...missing].join(", ")}`);
			throw new ModelsNotConfiguredError([...missing]);
		}
		// Key-presence parity: first offender surfaces (extractor before
		// auditor); fixing that key re-gates and the next run surfaces the
		// next offender, if any.
		for (const [role, engine] of stages) {
			const refusal = deps.providerKeyMissing?.(engine!.model.provider, ROLE_SLOT[role]);
			if (refusal) {
				console.info(`[extraction] refused — ${JSON.stringify(refusal)}`);
				throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
			}
		}
	}
	// THE SHARED REGISTRIES (runs() above — globalThis): every pipeline
	// instance (route entries in dev, tests) sees the same runs, the same
	// single-flight guard. No module-level state left in this factory.
	const runningExtractions = runs().running;
	const inFlight = runs().inFlight;

	function setPhase(
		jobKey: string,
		phase: ExtractionPhase,
		kind: "chat" | "notes",
		label?: string,
		part?: { i: number; n: number },
	): void {
		const R = runs();
		const prev = runningExtractions.get(jobKey);
		if (!prev) R.lastStartedAt = Math.max(Date.now(), R.lastStartedAt + 1);
		runningExtractions.set(jobKey, {
			chatId: prev?.chatId ?? jobKey.split("#")[0]!,
			part: prev?.part ?? part, // phase changes never lose the part
			kind,
			label: prev?.label ?? label, // phase changes never lose the label
			phase,
			startedAt: prev?.startedAt ?? R.lastStartedAt,
			usage: prev?.usage ?? {}, // phase changes never lose usage
			controller: prev?.controller ?? new AbortController(),
		});
		// Every phase transition announces the dock (push S5, 2026-10-02):
		// notify-after-write — the registry is the feed's truth.
		emit("activity-changed", {});
	}

	/** Run over (done, failed, aborted — every exit is a finally): the row
	 *  leaves the feed. ONE seam for all delete sites so no exit path can
	 *  miss the announce (push S5, 2026-10-02). */
	function finishExtraction(jobKey: string): void {
		runningExtractions.delete(jobKey);
		emit("activity-changed", {});
	}

	/** Accumulate one billed step into the run's registry entry (live). */
	function recordStep(jobKey: string, stage: "extractor" | "auditor", usage: CallUsage, model: string): void {
		const run = runningExtractions.get(jobKey);
		if (!run) return; // not running (tests driving stages directly)
		run.usage[stage] ??= { model, steps: [] };
		run.usage[stage]!.steps.push(usage);
	}

	/** SERIALIZED AUDIT (owner 2026-09-28): the auditor explores the LIVE
	 *  graph through its tools and stamps identity verdicts against what
	 *  it finds — so the audit+merge section is a process-wide critical
	 *  section. Two concurrent audits would each link into a graph the
	 *  other is about to change: the structural mint of duplicate nodes.
	 *  The extractor stays parallel (source-local, graph-blind). The
	 *  check runs BEFORE any LLM is invoked or the graph read; the lock
	 *  is FIFO, held through the merge, reacquired per batch, and
	 *  abort-aware on both sides of the queue (a waiter that aborts
	 *  leaves without auditing — its chain link still resolves, so
	 *  successors never hang). */
	async function withAuditLock<T>(jobKey: string, kind: "chat" | "notes", label: string | undefined, critical: () => Promise<T>): Promise<T> {
		setPhase(jobKey, "waiting", kind, label);
		const g = globalThis as typeof globalThis & LhExtractionGlobal;
		const lock = (g.__lhAuditLock ??= { tail: Promise.resolve() });
		const prev = lock.tail;
		let release!: () => void;
		lock.tail = new Promise<void>((resolve) => (release = resolve));
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			if (!signal) return;
			onAbort = () => {
				const err = new Error("提取在等待审核闸门时中止");
				err.name = "AbortError";
				reject(err);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([prev, aborted]);
			signal?.throwIfAborted(); // aborted exactly at handoff
			return await critical();
		} finally {
			if (onAbort && signal && !signal.aborted) signal.removeEventListener("abort", onAbort);
			// A cancelled waiter leaves promptly, but may not release its chain
			// link before its predecessor: successors still owe that earlier hold.
			void prev.then(release, release);
		}
	}

	async function extract(
		jobKey: string,
		sourceId: string,
		view: string,
		batchIds: ReadonlySet<string>,
	): Promise<SessionFindings> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted(); // an abort during a sync gap ends the job here
		// THE DIGEST (owner, 2026-09-30 evening): the extractor continues a
		// partly-extracted source — it sees everything this source has
		// already yielded (propositions + chains, ids verbatim) and builds
		// on it. Serialized batches make this read the post-merge graph of
		// every earlier batch (cross-source runs stay parallel — the
		// digest is source-scoped, so only SAME-source order matters).
		const graph = getGraph(graphStore);
		const digest = sourceDigest(graph, sourceId);
		const prompt = digest === "" ? view : `${digest}\n\n${view}`;
		console.info(
			`[extraction ${jobKey}] extractor starting (${view.split("\n").length} markdown lines` +
				`${digest === "" ? "" : `, digest ${digest.split("\n").length} lines`})`,
		);
		const t0 = performance.now();

		const findings = await runExtractor(
			stageEngine("extractor", deps.extractor),
			sourceId,
			prompt,
			new Set(graph.nodes.map((n) => n.id)),
			batchIds,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${jobKey}] extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	async function audit(jobKey: string, sourceId: string, findings: SessionFindings): Promise<AuditVerdicts> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted(); // an abort during the extract→audit gap ends here
		const graph = getGraph(graphStore);
		console.info(
			`[extraction ${jobKey}] auditor starting (${findings.propositions.length} propositions, ` +
				`${graph.nodes.length} graph nodes)`,
		);
		const t0 = performance.now();

		// The auditor NEVER sees the source (owner 2026-09-27): findings
		// JSON + an initial ranked candidate batch, not a global graph dump.
		// Further graph reads remain optional. The proposition
		// projection omits messageId (2026-10-13): the auditor is
		// IDENTITY-only and never sees the passages, so anchors are useless
		// to it — they add cognitive load, not signal.
		const review = prepareAuditorReview({ chatStore, graphStore }, findings.propositions);
		const auditResult = await runAuditor(
			stageEngine("auditor", deps.auditor),
			sourceId,
			`Review these proposed findings against the supplied existing records. matches points from finding ids to candidateIds; candidates contains those records:\n\n` +
				`${JSON.stringify(
					{
						propositions: findings.propositions.map((p) => ({
							id: p.id,
							name: p.name,
							statement: p.statement,
							aliases: p.aliases,
						})),
						...review.initialCandidates,
					},
					null,
					2,
				)}`,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "auditor", callUsage(usage), model);
				console.info(`[extraction] auditor step ${step}: ${finishReason}, tools: ${tools}`);
			},
			review.tools,
		);
		console.info(
			`[extraction ${jobKey}] audit: ${findings.propositions.length} propositions through, ` +
				`${auditResult.links.length} linked to existing nodes`,
		);
		console.info(`[extraction ${jobKey}] auditor done in ${Math.round(performance.now() - t0)}ms`);
		return auditResult;
	}

		/** Append the run's usage record to the chat's extractions log — success
	 *  or failure: a failed run still spent money, and its partial usage is
	 *  exactly what the record should show (stats absent = never merged).
	 *  Idempotent per startedAt (the store dedupes). */
	function persistRunUsage(jobKey: string, durationMs: number, stats: EmissionStats | undefined): void {
		const run = runningExtractions.get(jobKey);
		if (!run) return; // not running (tests driving stages directly)
		// PER-CHUNK JOBS (owner, 2026-09-28): the registry KEY may carry a
		// "#i" suffix — the usage LEDGERS key by SOURCE (run.chatId): one
		// job's record per chunk, all appended to the source's log.
		// SESSION-DELETION GUARD (wave 6): a chat deleted mid-run has no
		// usage log to append to — the record's death is the user's choice
		// and its partial spend logs with it (appendSourceUsage below
		// already no-ops for a vanished source; the chat path guards here).
		if (run.kind === "chat" && !chatStore.getChat(run.chatId)) return;
		const entry: ExtractionRunUsage = {
			startedAt: run.startedAt,
			at: new Date().toISOString(),
			durationMs,
			stats,
			stages: {
				extractor: run.usage.extractor ?? { model: "unknown", steps: [] },
				auditor: run.usage.auditor ?? { model: "unknown", steps: [] },
			},
		};
		if (run.kind === "notes") graphStore.appendSourceUsage(run.chatId, entry);
		else chatStore.appendExtractionUsage(run.chatId, entry);
	}

	/** One chunk/batch JOB (per-chunk jobs, owner 2026-09-28): the registry
	 *  entry's lifecycle — minted with its part, usage persisted per job
	 *  (the ledger shows each chunk's cost), removed on any exit. The body
	 *  runs the full queued → extract → audit-locked merge lifecycle;
	 *  failure isolation lives at the fan-out site (one bad chunk never
	 *  kills its siblings). */
	async function runJob(
		source: { id: string; kind: "chat" | "notes"; label?: string; part?: { i: number; n: number } },
		body: (jobKey: string) => Promise<EmissionStats>,
	): Promise<EmissionStats> {
		const jobKey = source.part ? `${source.id}#${source.part.i}` : source.id;
		const t0 = performance.now();
		try {
			const stats = await body(jobKey);
			persistRunUsage(jobKey, Math.round(performance.now() - t0), stats);
			return stats;
		} catch (err) {
			persistRunUsage(jobKey, Math.round(performance.now() - t0), undefined);
			throw err;
		} finally {
			finishExtraction(jobKey);
		}
	}

	/** The fan-out aggregation (per-chunk jobs, owner 2026-09-28): successes
	 *  count (earlier chunks keep their merges — checkpoints make aborts
	 *  cheap), aborts log and pass as partial stats, isolated failures log
	 *  per job and never throw — the source's run returns what actually
	 *  merged. */
	function aggregateJobs(sourceId: string, settled: PromiseSettledResult<EmissionStats>[]): EmissionStats {
		const stats: EmissionStats = { nodes: 0, chains: 0 };
		let aborted = false;
		let failed = 0;
		for (const result of settled) {
			if (result.status === "fulfilled") {
				stats.nodes += result.value.nodes;
				stats.chains! += result.value.chains ?? 0;
				// Simplification maintenance, summed like appends — but ABSENT
				// when nothing dropped (deep-equal pins read cleaner).
				if (result.value.droppedChains)
					stats.droppedChains = (stats.droppedChains ?? 0) + result.value.droppedChains;
				continue;
			}
			const err = result.reason;
			if (err instanceof Error && err.name === "AbortError") aborted = true;
			else {
				failed++;
				console.error(`[extraction ${sourceId}] job failed (isolated):`, err);
			}
		}
		if (aborted)
			console.info(
				`[extraction ${sourceId}] aborted — merged chunks keep their coverage, the rest stay uncovered for the next run`,
			);
		if (failed > 0)
			console.error(`[extraction ${sourceId}] ${failed} job(s) failed; successful jobs still merged`);
		return stats;
	}

	async function runExtraction(chatId: string): Promise<EmissionStats> {
		if (inFlight.has(chatId)) return { nodes: 0, chains: 0 };
		inFlight.add(chatId);
		const t0 = performance.now();
		// COVERAGE (vision-extraction-coverage.md, 2026-09-15): extract ONLY
		// what the per-chat coverage ledger doesn't already hold — never the
		// whole session. Batches are token-budgeted runs of the oldest
		// uncovered messages; each merged batch checkpoints its messages'
		// coverage ATOMICALLY (inside the merger's step 4), so an abort or
		// error below loses at most the in-flight batch — every earlier
		// batch stays covered, the rest stays visibly uncovered.
		try {
			const record = chatStore.getChat(chatId);
			if (!record) throw new Error(`Chat not found: ${chatId}`);
			// BYOK per-need gate (owner, 2026-09-22) + key presence
			// (2026-09-25): the write channel needs extractor + auditor
			// engines AND their providers' keys; a refusal lands BEFORE any
			// stage runs (typed — the trigger skips, routes surface 503).
			refuseIfStagesUnready();
			const covered = coverageOf(record.messages, graphStore.readCoverage(), chatId);
			const failedOutputCalls = failedOutputCallIds(record.messages);
			if (covered.uncovered.length === 0) {
				console.info(`[extraction ${chatId}] nothing uncovered — no-op`);
				return { nodes: 0, chains: 0 };
			}
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			// The batcher's one rule (owner, Wave D): a tool-call message and
			// its result message(s) are INSEPARABLE — one chunk, covered
			// together, read together (core/coverage.ts batchRuns).
			const batches = batchRuns(covered.slots, covered.uncovered, chunkTokens);
			console.info(
				`[extraction ${chatId}] pipeline start — ${covered.uncoveredTokens} uncovered tok, ` +
					`${covered.uncoveredCount} messages, ${batches.length} batch(es) of ≤${chunkTokens} tok`,
			);
			// PER-CHUNK JOBS (owner, 2026-09-28), SERIALIZED PER SOURCE (owner,
			// 2026-09-30 evening): every batch is its own job — registry row,
			// because each batch's extractor continues the source's digest
			// (everything the earlier batches merged). Cross-source runs stay
			// parallel; individual worker requests share process-wide admission.
			// Audits serialize through the separate consistency gate ("waiting").
			// A batch that fails is ISOLATED
			// (its messages stay uncovered — honestly re-runnable); its
			// siblings keep merging.
			const settled: PromiseSettledResult<EmissionStats>[] = [];
			for (const [batchIndex, batch] of batches.entries()) {
				const part = batches.length > 1 ? { i: batchIndex + 1, n: batches.length } : undefined;
				try {
					settled.push({
						status: "fulfilled",
						value: await runJob({ id: chatId, kind: "chat", part }, async (jobKey) => {
							// The batch's source view: TEACHER PROSE ONLY (owner,
							// 2026-09-28), each passage labeled with its ACTUAL message
							// id (2026-10-13) — the view lines ARE the coverage
							// fingerprints' messageViewLines ("TEACHER [id] text"), one
							// shared seam.
							const messages = batch.map((slot) => slot.message);
							const view = proseView(messages, record.title, failedOutputCalls);
							// The batch's teacher-prose ids — the ONLY anchors this
							// job's submit may name (validateSessionAnchors at the
							// submit seam refuses anything else: ids from other
							// batches — even real ones of this chat — other chats,
							// and non-prose messages).
							const batchIds = new Set(
								messages.filter((m) => messageViewLines(m, m.id, failedOutputCalls).length > 0).map((m) => m.id),
							);
							setPhase(jobKey, "extracting", "chat", undefined, part);
							const findings = await extract(jobKey, chatId, view, batchIds);
							// SERIALIZED AUDIT (owner, 2026-09-28): audit + merge are the
							// graph-mutating critical section — one job at a time,
							// process-wide, so the auditor explores the graph as it
							// stands AFTER every earlier job's merge.
							return withAuditLock(jobKey, "chat", undefined, async () => {
								setPhase(jobKey, "auditing", "chat", undefined, part);
								const auditResult = await audit(jobKey, chatId, findings);
								setPhase(jobKey, "merging", "chat", undefined, part);
								// SESSION-DELETION GUARD (wave 6): a chat deleted mid-run must never
								// merge. The deletion route aborts this run first and runs its purge
								// as one sync block; this closes the last window — a run that slipped
								// past the wind-down finds the chat gone HERE and rides the existing
								// abort path (info, not error): nothing merged, nothing checkpointed.
								if (!chatStore.getChat(chatId)) {
									const gone = new Error(`chat deleted mid-run: ${chatId}`);
									gone.name = "AbortError";
									throw gone;
								}
								// The batch's messages, snapshotted when the run computed
								// coverage — if a message mutates mid-run (a quiz answer
								// merges in), the stored fingerprint won't match its new
								// one and it re-opens: honest by construction.
								const foldedAt = new Date().toISOString();
								const batchStats = mergeFindings(chatId, findings, auditResult, { chatStore, graphStore }, {
									foldedAt,
									coverage: batch
										.filter((slot) => slot.tokens > 0)
										.map((slot) => ({ chatId, fp: slot.fp, tokens: slot.tokens, foldedAt })),
								});
								// The layout ledger evolves with the merge (sync — the
								// next snapshot fetch must already reflect the new nodes).
								settleGraphLayout(graphStore);
								console.info(
									`[extraction ${jobKey}] merged: ${batchStats.nodes} nodes, ${batchStats.chains ?? 0} chains`,
								);
								return batchStats;
							});
						}),
					});
				} catch (err) {
					settled.push({ status: "rejected", reason: err });
					// A source-wide abort (user abort / session deletion)
					// ends the WHOLE run: later batches would mint fresh,
					// un-aborted jobs and hang — stop here. Isolated
					// FAILURES keep going (siblings still merge).
					if (err instanceof Error && err.name === "AbortError") break;
				}
			}
			const stats = aggregateJobs(chatId, settled);
			console.info(
				`[extraction ${chatId}] merged: ${stats.nodes} nodes, ${stats.chains ?? 0} chains ` +
					`(${Math.round(performance.now() - t0)}ms total, ${batches.length} batch job(s))`,
			);
			return stats;
		} catch (err) {
			// Pre-fan-out failures only (stage gate, coverage read): aborts
			// and job-level failures are absorbed at the fan-out site, per
			// job — merged batches stay covered, partial usage persists per
			// job, the aggregate returns what actually merged.
			console.error(`[extraction ${chatId}] pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			throw err;
		} finally {
			inFlight.delete(chatId);
			finishExtraction(chatId); // done or failed — no longer running
		}
	}

	// ── the notes front door (format-agnostic: raw text in, same graph out) ──

	/** The raw source view the notes stages see: the file path + the text
	 *  VERBATIM. No message ids — provenance is the file itself. */
	function notesView(input: { filePath: string; text: string; part?: { i: number; n: number } }): string {
		const part = input.part && input.part.n > 1 ? ` (part ${input.part.i}/${input.part.n})` : "";
		return `SOURCE (the author's personal notes): ${input.filePath}${part}\n\n${input.text}`;
	}

	/** Chunk the notes text under the same budget the chat path uses
	 * (owner, 2026-09-28: the whole-file-in-one-call design collapsed a
	 * weak model — 26 propositions, structure bleed mid-emission).
	 * Greedy by line, chars/4 like every other estimate in the app; a
	 * single over-budget line rides alone (never split a line). */
	function chunkNotes(text: string, budget: number): string[] {
		if (text.trim().length === 0) return [];
		const out: string[] = [];
		let current = "";
		for (const line of text.split("\n")) {
			const candidate = current.length === 0 ? line : current + "\n" + line;
			if (current.length > 0 && Math.ceil(candidate.length / 4) > budget) {
				out.push(current);
				current = line;
			} else {
				current = candidate;
			}
		}
		if (current.trim().length > 0) out.push(current);
		return out;
	}

	async function notesExtract(
		jobKey: string,
		input: { id: string; filePath: string; text: string; part?: { i: number; n: number } },
	): Promise<NotesFindings> {
		// jobKey (per-chunk jobs, owner 2026-09-28): the registry key —
		// "src#i" for chunk jobs — so the abort signal reaches the call.
		// input.id stays the SOURCE id for the view and store ledgers.
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted(); // an abort during a sync gap ends the job here
		const view = notesView(input);
		// Same digest law as the chat door (owner, 2026-09-30 evening): the
		// chunk extractor continues its own source, ids verbatim.
		const graph = getGraph(graphStore);
		const digest = sourceDigest(graph, input.id);
		const prompt = digest === "" ? view : `${digest}\n\n${view}`;
		console.info(
			`[extraction ${jobKey}] notes extractor starting (${view.split("\n").length} source lines` +
				`${digest === "" ? "" : `, digest ${digest.split("\n").length} lines`})`,
		);
		const t0 = performance.now();
		const findings = await runNotesExtractor(
			stageEngine("extractor", deps.extractor),
			input.id,
			prompt,
			new Set(graph.nodes.map((n) => n.id)),
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${jobKey}] notes extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	// The notes auditor is the SAME identity-linker as the chat one (one
	// schema now that attribution is gone) — audit() above, verbatim.

	async function runNotesExtraction(input: { id: string; filePath: string; text: string; importedAt: string }): Promise<EmissionStats> {
		const { id } = input;
		// importNotes owns the source exclusion, including metadata and cleanup.
		const t0 = performance.now();
		const mergedStats: EmissionStats = { nodes: 0, chains: 0 };
		try {
			// BYOK per-need gate (owner, 2026-09-22) + key presence
			// (2026-09-25): same refusal as the chat front door — no
			// extractor/auditor engines, or a stage key gone, no run.
			refuseIfStagesUnready();
			// CHUNKED like the chat path (owner, 2026-09-28): each chunk is a
			// standalone extract → audit → merge, so no single call carries a
			// whole large file. Abort mid-run keeps earlier chunks merged
			// (same doctrine as chat batches).
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			const chunks = chunkNotes(input.text, chunkTokens);
			console.info(
				`[extraction ${id}] notes pipeline start (${input.filePath}) — ${chunks.length} chunk(s) of ≤${chunkTokens} tok`,
			);
			// PER-CHUNK JOBS (owner, 2026-09-28), SERIALIZED PER SOURCE (owner,
			// 2026-09-30 evening): same law as the chat door — chunks run
			// STRICTLY IN ORDER, each chunk's extractor continuing the
			// source's digest (everything earlier chunks merged). Cross-source
			// runs stay parallel; individual worker requests share admission,
			// while audits serialize through the consistency gate. The
			// part rides the registry entry (feed suffix "· i/N") only when
			// the file actually chunked.
			const settled: PromiseSettledResult<EmissionStats>[] = [];
			for (const [chunkIndex, chunk] of chunks.entries()) {
				const part = chunks.length > 1 ? { i: chunkIndex + 1, n: chunks.length } : undefined;
				// Keep the actual signal after runJob tears down its registry row:
				// usage persistence can throw and mask the body's AbortError.
				let chunkSignal: AbortSignal | undefined;
				try {
					settled.push({
						status: "fulfilled",
						value: await runJob({ id, kind: "notes", label: input.filePath, part }, async (jobKey) => {
							setPhase(jobKey, "extracting", "notes", input.filePath, part);
							chunkSignal = runningExtractions.get(jobKey)?.controller.signal;
							const findings = await notesExtract(jobKey, { ...input, text: chunk, part });
							// SERIALIZED AUDIT (owner, 2026-09-28): audit + merge one
							// at a time, process-wide — the auditor explores the graph
							// as it stands AFTER every earlier job's merge. Reacquired
							// per chunk so cross-source runs interleave fairly.
							return withAuditLock(jobKey, "notes", input.filePath, async () => {
								setPhase(jobKey, "auditing", "notes", input.filePath, part);
								const auditResult = await audit(jobKey, input.id, findings);
								setPhase(jobKey, "merging", "notes", input.filePath, part);
								const merged = mergeFindings(
									id,
									findings,
									auditResult,
									{ chatStore, graphStore },
									{ foldedAt: input.importedAt },
								);
								// Capture the committed merge BEFORE layout/usage can fail.
								mergedStats.nodes += merged.nodes;
								mergedStats.chains! += merged.chains ?? 0;
								if (merged.droppedChains)
									mergedStats.droppedChains = (mergedStats.droppedChains ?? 0) + merged.droppedChains;
								// The layout ledger evolves with each merge — the next
								// snapshot fetch reflects every finished chunk.
								settleGraphLayout(graphStore);
								console.info(`[extraction ${jobKey}] merged: ${merged.nodes} nodes, ${merged.chains ?? 0} chains`);
								return merged;
							});
						}),
					});
				} catch (err) {
					let failure = err;
					if (chunkSignal?.aborted && !(err instanceof Error && err.name === "AbortError")) {
						// Notes-only: never start a fresh chunk after user cancellation,
						// even when usage cleanup replaced the original abort rejection.
						// Keep the secondary failure visible in the final import error.
						const aborted = new Error(`Notes import aborted; job cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
						aborted.name = "AbortError";
						failure = aborted;
					}
					settled.push({ status: "rejected", reason: failure });
					// Same source-wide-abort law as the chat door: stop the
					// run; isolated failures keep going.
					if (failure instanceof Error && failure.name === "AbortError") break;
				}
			}
			const stats = aggregateJobs(id, settled);
			// Completion is a chunk-status contract, never a node-count test.
			// Zero findings (and an empty file after the readiness gate) are valid.
			const rejected = settled.filter((r) => r.status === "rejected");
			if (rejected.length > 0 || settled.length !== chunks.length) {
				const aborted = rejected.some((r) => r.reason instanceof Error && r.reason.name === "AbortError");
				const outcome = aborted ? "aborted" : settled.some((r) => r.status === "fulfilled") ? "partial" : "failed";
				const details = rejected.map((r) => r.reason instanceof Error ? r.reason.message : String(r.reason)).join("; ");
				throw new NotesImportError(outcome, mergedStats, details || "笔记导入未完成");
			}
			console.info(
				`[extraction ${id}] merged: ${stats.nodes} nodes, ${stats.chains ?? 0} chains ` +
					`(${Math.round(performance.now() - t0)}ms total, ${chunks.length} chunk job(s))`,
			);
			return stats;
		} catch (err) {
			console.error(`[extraction ${id}] notes pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			if (err instanceof NotesImportError || err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) throw err;
			throw new NotesImportError(err instanceof Error && err.name === "AbortError" ? "aborted" : "failed", mergedStats,
				err instanceof Error ? err.message : String(err), { cause: err });
		} finally {
			finishExtraction(id); // done or failed — no longer running
		}
	}

	/** Every explicit import processes the whole file. Identity, source digest,
	 * auditor and usage history remain source-scoped; this is not exactly-once. */
	async function importNotes(input: NotesImportInput): Promise<EmissionStats> {
		const id = `src_${crypto.createHash("sha256").update(input.filePath).digest("hex").slice(0, 12)}`;
		// Acquire BEFORE source upsert: overlapping contents must not alter metadata.
		if (inFlight.has(id)) throw new NotesImportError("busy", { nodes: 0, chains: 0 }, "此文件正在导入中。请在完成后重试。");
		inFlight.add(id);
		try {
			const importedAt = new Date().toISOString();
			graphStore.upsertSource({ id, filePath: input.filePath, importedAt });
			return await runNotesExtraction({ id, ...input, importedAt });
		} catch (err) {
			if (err instanceof NotesImportError || err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) throw err;
			throw new NotesImportError("failed", { nodes: 0, chains: 0 }, err instanceof Error ? err.message : String(err), { cause: err });
		} finally {
			inFlight.delete(id);
		}
	}

	return { runExtraction, importNotes };
}

