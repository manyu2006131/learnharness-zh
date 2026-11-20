/**
 * Probe-phase contracts (the probe→teach split, docs/archive/probe-teach-split.md).
 *
 * The prober concludes its phase with `probe_done` — a server-side tool
 * whose INPUT is the learner assessment (authored by the model, streamed to
 * the learner live, durable in the transcript by the tool result itself).
 * The first `probe_done` in the transcript is the probe→planning seam: the
 * teacher agent is constructed from that point on, and the tool's execute
 * queues the handoff steer through the wake pipeline so the teacher starts
 * immediately after the prober's turn ends (auto-wake, user-decided).
 *
 * Assessment shape (v1 — refine later): the probe was a binary search per
 * dependency strand; the assessment formalizes exactly that. A list of the
 * strands the lesson will depend on, each with a free-form read of where
 * the learner's edge sits.
 */

import { Type, type Static } from "typebox";

/** One dependency strand the planned lesson will rest on. */
export interface ProbeStrand {
	/** Name/description of the strand (e.g. "the derivative as a limit"). */
	strand: string;
	/** Free-form: where the learner's edge sits on this strand — floor,
	 *  ceiling, misconceptions found, what to build from. */
	assessment: string;
}

/** The prober's read of the learner, carried by probe_done. */
export interface ProbeAssessment {
	strands: ProbeStrand[];
	/** Optional overall synthesis: the learner's apparent goal and edge. */
	summary?: string;
}

/** probe_done tool input (the assessment the prober authors). */
export interface ProbeDoneInput {
	assessment: ProbeAssessment;
}

// The TypeBox schema of that input — SINGLE SOURCE OF TRUTH, lived by the
// tool (src/agent/tools/probe.ts) and by the UI parse seam (src/core/tool-parts.ts):
// the boundary validation and the consumer parse run literally the same
// schema, so "schema-valid at the boundary" ⇔ "parseable by a consumer" is
// structural, not a convention. (Live crash 2026-09-12: the model sent
// `assessment` as a STRING; the card cast it and died on `.strands.map`.)
export const probeDoneInputSchema = Type.Object({
	assessment: Type.Object(
		{
			strands: Type.Array(
				Type.Object({
					strand: Type.String({
						description:
							"依赖线索（例如“导数作为极限”）——计划可以挂节点的一个名称。",
					}),
					assessment: Type.String({
						description:
							"他在这条线索上的掌握位置：地板（他能稳定做对的部分）、天花板（能力耗尽之处）、" +
							"发现的误解，以及课程应据此构建什么。",
					}),
				}),
				{ minItems: 1, description: "计划课程依赖的每一条线索，以及你对学习者在该线索上掌握程度的判断。" },
			),
			summary: Type.Optional(
				Type.String({
					description: "可选的总体综述：他表面上的目标，以及教学应从何处切入。",
				}),
			),
		},
		{ description: "学习者评估——探查的精炼输出。" },
	),
});

/** Schema ↔ interface lock (the old `satisfies z.ZodType` guarantee): the
 *  declaration and ProbeDoneInput can never drift apart — this only compiles
 *  when the schema's static shape IS the interface. */
export const probeDoneSchemaLock = (v: Static<typeof probeDoneInputSchema>): ProbeDoneInput => v;

/** probe_done tool output. */
export interface ProbeDoneResult {
	ok: boolean;
	/** Refusal reason when ok === false (open question, already concluded). */
	error?: string;
}

/** The probe_done ack's model-facing text (owner, context diet
 *  2026-10-09): the assessment is the CALL's arguments — durable in the
 *  transcript, streamed to the learner — so echoing it back in the
 *  result would duplicate the probe phase's largest payload in every
 *  future context. The agent sees this fixed line instead; `details`
 *  carries only {ok:true} for the record/UI. Same doctrine as
 *  CONCLUDE_ACK_TEXT. */
export const PROBE_DONE_ACK_TEXT =
	"评估已记录——现在会展示给学习者，教师将据此规划。说完结束语后结束本回合；接下来由教学阶段接管。";
