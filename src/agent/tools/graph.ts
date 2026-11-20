import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { getGraph, graphSessionIndex, graphSessionPropositions } from "../../core/graph.ts";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
import { createPropositionCandidateSearch, propositionCandidateBatch, type CandidateBatch, type CandidateProposition, type CandidateRequest } from "../../core/proposition-candidates.ts";

/**
 * THE PROBER'S GRAPH TOOLS (wave 7, owner-locked 2026-09-23): context
 * injection is dead — zero configuration beyond chat models. The prober
 * reads the learner's persistent knowledge map through two tools instead,
 * replacing the old injected block with on-demand eyes.
 *
 * Names + levels + dating ONLY — no statement text, no session contents
 * (owner ruling: the map's ORGANIZATION is the prober's business, its
 * prose is not). The data comes from Platform's pure core seams
 * (graphSessionIndex / graphSessionPropositions) over the same ports the
 * snapshot reads, so the prober and the learner's graph view can never
 * disagree.
 *
 * Registered on the prober ONLY when the settings gate opens
 * (graphToolsEnabled — the graph master switch AND the agent.graphTools
 * toggle); the composition root decides, the factory just receives the
 * store (absent = the gate is closed, no map tools — tests drive this).
 */

/** What the graph tools close over: the stores the session views read. */
export interface GraphToolContext {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

const listSessionsInput = Type.Object({});

const listPropositionsInput = Type.Object({
	session: Type.String({
		minLength: 1,
		description: "会话 id，须与 list_sessions 报告的完全一致（对话 id 或笔记源 id）",
	}),
});

export function proberGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	return {
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the sessions of the learner's persistent knowledge graph — every chat or imported-notes file that ever contributed a proposition, most recent first. The map is organized into birth-session clusters (propositions grouped by the session they were first learned in), and session names are those clusters' labels. " +
				"每行：会话名称、类型（chat/file）、其中诞生的命题数量、日期和 id——将该 id 传给 list_propositions。" +
				"先读这个可了解他已覆盖的内容与时间，然后再开始探查。",
			parameters: listSessionsInput,
			execute: serverExecute("list_sessions", listSessionsInput, async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "知识图谱为空——尚无会话贡献命题。";
				const lines = sessions.map((s, i) =>
					`${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}, ` +
					`born ${s.createdAt ?? "unknown date"}${s.updatedAt ? `, last active ${s.updatedAt}` : ""}) — id: ${s.id}`,
				);
				return `${sessions.length} session(s) in the knowledge graph, most recent first:\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"列出某个知识图谱会话中诞生的命题——该会话覆盖了什么。" +
				"仅名称——不含陈述文本、不含会话内容（所有者裁定 2026-09-23：地图的组织结构归你管，正文不归你管）。",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) {
					return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				}
				const lines = propositions.map((p) => `- ${p.name}`);
				return `${propositions.length} proposition(s) covered in this session:\n${lines.join("\n")}`;
			}),
		},
	};
}

// ─── the auditor's graph tools (2026-09-27 relink) ───────────────────────────

/**
 * THE AUDITOR'S TOOLSET — the extraction auditor explores the graph to
 * place new propositions instead of receiving it injected (owner ruling
 * 2026-09-27: a full-graph dump bloats context as the graph grows; the
 * auditor looks up identity candidates itself). Auditor-specific
 * versions, deliberately different from the prober's:
 *
 *   find_candidates   batched, ranked lexical lookup using the proposed
 *                     findings themselves; five candidates per finding,
 *                     explicit pagination, full statements and matched
 *                     aliases, deduplicated within the returned batch.
 *   list_sessions     the birth-session index, no timestamps.
 *   list_propositions full proposition text (optional exploration fallback).
 *
 * No timestamps anywhere: identity work needs content, not chronology.
 * Read-only, pure core seams, same ports the snapshot reads.
 */

export interface AuditorCandidateBatch {
	matches: Array<{ propositionId: string; candidateIds: string[]; nextCursor: string | null }>;
	candidates: CandidateBatch["candidates"];
}

interface CandidateLookup {
	id: string;
	hints?: readonly string[];
	cursor?: string;
}

/** Prepare the first page in code, and keep all continuations bound to this
 * audit's immutable queries. A new search cannot accidentally inherit an old
 * offset. Tokens are opaque, per-audit and stable when a request is repeated;
 * none of this suppresses previously returned records. */
export function prepareAuditorReview(ctx: GraphToolContext, propositions: readonly CandidateProposition[] = []): {
	initialCandidates: AuditorCandidateBatch;
	tools: Record<string, AgentTool<any>>;
} {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	const findInput = Type.Object({
		propositions: Type.Array(Type.Object({
			id: Type.String({ minLength: 1, description: "传入拟议发现项中的一个 id。其名称、陈述和别名会被自动检索。" }),
			hints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
				description: "可选：加入搜索的其他词或短语。纯文本，不使用通配模式。",
			})),
			cursor: Type.Optional(Type.String({ minLength: 1, description: "用 nextCursor 继续上一次查询。带 cursor 时不要提供 hints；其查询已固定。省略 cursor 以从第一页开始新搜索。" })),
		}, { additionalProperties: false }), { minItems: 1, description: "只查询需要额外定向搜索的发现项。每个 id 只写一次。" }),
	}, { additionalProperties: false });
	let search: ReturnType<typeof createPropositionCandidateSearch> | undefined;
	const continuations = new Map<string, CandidateRequest>();
	const tokens = new Map<string, string>();
	function lookup(requests: readonly CandidateLookup[]): AuditorCandidateBatch {
		const queries = requests.map((request): CandidateRequest => {
			if (request.cursor === undefined) return { id: request.id, hints: request.hints ? [...request.hints] : undefined };
			if (request.hints !== undefined) throw new Error("续查已经固定了查询。请省略 hints，或省略 cursor 以开始新的搜索。");
			const query = continuations.get(request.cursor);
			if (!query || query.id !== request.id) throw new Error("此发现项与审计的 cursor 未知。请不带 cursor 重新查询。");
			return query;
		});
		search ??= createPropositionCandidateSearch(getGraph(deps.graphStore).nodes);
		const batch = propositionCandidateBatch(search, propositions, queries);
		return {
			matches: batch.matches.map((match, index) => {
				let nextCursor: string | null = null;
				if (match.nextOffset !== null) {
					const query = { ...queries[index]!, offset: match.nextOffset };
					const key = JSON.stringify([query.id, query.hints ?? [], query.offset]);
					nextCursor = tokens.get(key) ?? randomUUID();
					tokens.set(key, nextCursor);
					continuations.set(nextCursor, query);
				}
				return { propositionId: match.propositionId, candidateIds: match.candidateIds, nextCursor };
			}),
			candidates: batch.candidates,
		};
	}
	const initialCandidates = lookup([...new Set(propositions.map((proposition) => proposition.id))].map((id) => ({ id })));
	const tools: Record<string, AgentTool<any>> = {
		find_candidates: {
			name: "find_candidates",
			label: "find_candidates",
			description:
				"为一组拟议 id 查找已有命题候选，使用其完整文本和可选提示。" +
				"按名称、陈述和别名的词重叠度排序，不匹配精确短语或通配模式。" +
				"首页已在你的输入中。新搜索返回五个排序候选；nextCursor 可继续同一查询。" +
				"每个候选的完整陈述和相关匹配别名在 candidates 中各出现一次；matches 按发现项列出其 id。" +
				"未匹配的发现项可以保持为新增；继续查证只是选项，不是必须一直搜下去。" +
				"没有跨调用抑制：重复请求会再次返回完整页面。",
			parameters: findInput,
			execute: serverExecute("find_candidates", findInput, async (input) => lookup(input.propositions)),
		},
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"列出知识图谱中的源会话——所有曾贡献过命题的对话或导入笔记文件。" +
				"每行：名称、类型、命题数量、id。将 id 传给 list_propositions 可查看会话覆盖的内容。",
			parameters: Type.Object({}),
			execute: serverExecute("list_sessions", Type.Object({}), async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "知识图谱为空——尚无会话贡献命题。";
				const lines = sessions.map((s, i) => `${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}) — id: ${s.id}`);
				return `${sessions.length} session(s):\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"列出某个会话中诞生的命题，附完整陈述文本——用于身份判定的内容级视图" +
				"（判断某条新命题是否其实就是其中之一）。",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				const nodes = new Map(getGraph(deps.graphStore).nodes.map((n) => [n.id, n]));
				const lines = propositions.map((p) => {
					const node = nodes.get(p.nodeId);
					return `- ${p.nodeId} :: ${p.name}\n  statement: ${node?.statement ?? "(unknown)"}`;
				});
				return `${propositions.length} proposition(s) born in this session:\n${lines.join("\n")}`;
			}),
		},
	};
	return { initialCandidates, tools };
}
