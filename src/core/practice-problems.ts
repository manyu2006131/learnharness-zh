/** The native common practice pose fields, shared unchanged by plugin poses. */
import { Type } from "typebox";

export const practiceProblemInputSchema = Type.Object({
	statement: Type.String({
		description:
			"必填——学习者看到的题目内容（markdown + LaTeX）。必须自包含且" +
			"可基于本会话材料求解。绝不点明目标命题。",
	}),
	mode: Type.Union([Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")], {
		description: "必填——题目类型：recall、discrimination 或 composition（裸词，不加引号）。",
	}),
	target: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			description:
				"本题练习的命题 id，取自会话上下文的 [id] 列表——材料在知识图谱中时请附带；" +
				"不在时请完全省略（主题会话提出的是不带标记的题目）。 " +
				"名称会在接缝处规范化为 id；未知命题会被拒绝。",
		}),
	),
	modelSolution: Type.String({
		description: "必填——完整解答，按顺序列出步骤，必须在学习者看到题目之前提交。这就是揭示内容——结束时会原样展示；切勿重写。",
	}),
});
