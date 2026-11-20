import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SEND_TO_USER_TOOL } from "../../core/native-messages.ts";
import { CLAUDE_CODE_PROVIDER } from "../claude-code/constants.ts";
import { serverExecute } from "../tool-execute.ts";

/** Claude models get the output tool (their plain text may be summarized
 *  into thinking). Matches Claude across providers (including OpenRouter),
 *  not the API transport. The side-question agent uses this directly. */
export function needsSendToUser(model: { provider: string; id: string }): boolean {
	return model.provider === CLAUDE_CODE_PROVIDER || model.id.toLowerCase().includes("claude");
}

/** One availability rule for the tool and its teacher-only delivery guard.
 * Practice uses ordinary final prose; explicit registries remain caller-owned. */
export function sendToUserApplies(
	kind: string,
	model: { provider: string; id: string },
	toolsOverridden: boolean,
): boolean {
	return (kind === "prober" || kind === "teacher") && !toolsOverridden && needsSendToUser(model);
}

const sendToUserInput = Type.Object({
	message: Type.String({
		minLength: 1,
		pattern: "\\S",
		description: "要展示给学习者的完整内容。支持 Markdown 和 LaTeX。",
	}),
});

/** Claude's documented verbatim mid-turn output channel. Availability is
 * model-gated at the shared conversation-agent construction boundary;
 * the native call remains in history, and the view renders its message. */
export const sendToUserTool: AgentTool<typeof sendToUserInput> = {
	name: SEND_TO_USER_TOOL,
	label: SEND_TO_USER_TOOL,
	description:
		"## 必需的输出通道——始终使用 `send_to_user`\n\n" +
		"**所有面向学习者的消息都必须通过 `send_to_user` 发送。** 包括讲解、教学、" +
		"反馈、纠正、提示、开场、进度消息和最终回复。 " +
		"短消息或回合结束时也不例外。\n\n" +
		"普通回复文本可能被转换为摘要式思考，而不会送达学习者。" +
		"**绝不要依赖普通回复文本来与学习者沟通。思考不等于交付。**\n\n" +
		"把完整消息放进 `message`。支持 Markdown 和 LaTeX。 " +
		"不要在普通回复文本中重复它。\n\n" +
		"问题内容仍应放在相应的问题工具中；把随附的教学或" +
		"评述通过 `send_to_user` 发送后再调用该工具。\n\n" +
		"此工具不会暂停或结束你的回合。需要时继续使用其他工具。" +
		"交付最终消息后，结束回合，不要附带其他普通回复文本。",
	parameters: sendToUserInput,
	executionMode: "sequential",
	execute: serverExecute(SEND_TO_USER_TOOL, sendToUserInput, () => "已收到待展示的消息。"),
};
