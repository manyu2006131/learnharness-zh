import type { ToolCallHooks } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL, sendToUserText } from "../core/native-messages.ts";
import { sendToUserApplies } from "./tools/send-to-user.ts";

export const NARRATION_GUARD_MAX_BLOCKS = 2;

export const NARRATION_BLOCK_REASON =
	"这个响应只有旁白，没有交付面向学习者的正文。请通过 `send_to_user` 写出学习者需要的讲解或评述，然后重试这个问题。交付面向学习者的内容，而不是内部推理。";

export const SEND_TO_USER_DELIVERY_RULE =
	"## 交付你的正文\n\n" +
	"面向学习者的正文通过 `send_to_user` 交付；普通响应文本可能被转成摘要思考，而不会到达学习者。 " +
	"调用相应的问题工具前，先发送完整的讲解、示例或评述。" +
	"只有问题的回合不需要额外消息。" +
	"若某个问题的响应只有旁白而没有交付正文，可能会被拒绝，以便你补上缺失的讲解后重试。";

export function narrationGuardApplies(
	kind: string,
	model: { provider: string; id: string },
	toolsOverridden: boolean,
): boolean {
	return kind === "teacher" && sendToUserApplies(kind, model, toolsOverridden);
}

export function isNarrationBlock(block: { type: string; thinkingSignature?: string }): boolean {
	if (block.type !== "thinking" || typeof block.thinkingSignature !== "string") return false;
	try {
		return Buffer.from(block.thinkingSignature, "base64").subarray(0, 60).includes("narration");
	} catch {
		return false;
	}
}

export function questionLacksDeliveredProse(message: AssistantMessage, toolName: string, delivered = false): boolean {
	if (!(QUESTION_TOOLS as readonly string[]).includes(toolName)) return false;
	if (!message.content.some(isNarrationBlock as (b: AssistantMessage["content"][number]) => boolean)) return false;
	return !delivered && !message.content.some((b) => b.type === "text" && b.text.trim().length > 0);
}

export function makeNarrationGuard(): ToolCallHooks {
	let blocked = 0;
	// The sequential output/question tools run in call order. Credit only a
	// successful output already executed for THIS response, never a later
	// call, an older lesson, or a failed/aborted output. State is run-local.
	const delivered = new WeakSet<AssistantMessage>();
	return {
		beforeToolCall: async ({ assistantMessage, toolCall }) => {
			if (blocked >= NARRATION_GUARD_MAX_BLOCKS) return undefined;
			if (!questionLacksDeliveredProse(assistantMessage, toolCall.name, delivered.has(assistantMessage))) return undefined;
			blocked++;
			return { block: true, reason: NARRATION_BLOCK_REASON };
		},
		afterToolCall: async ({ assistantMessage, toolCall, result, isError }) => {
			if (toolCall.name === SEND_TO_USER_TOOL && !isError && !result.isError && sendToUserText(toolCall) !== undefined) {
				delivered.add(assistantMessage);
			}
			return undefined;
		},
	};
}
