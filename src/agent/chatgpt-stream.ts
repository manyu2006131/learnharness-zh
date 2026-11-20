import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { chatGPTAbortController, chatGPTScope, chatGPTScopeCurrent, chatGPTLease, chatGPTDenial } from "./chatgpt-bridge.ts";
import type { AdmissionScope, ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { capturePreparedBackgroundPayload } from "./background-capture.ts";

const USAGE = "https://chatgpt.com/settings/usage";
export function chatGPTStreamError(message: string): string {
	if (/subscription_sharing_usage_limit_exceeded|quota|429/.test(message)) return `ChatGPT 套餐用量已达上限。请在 ${USAGE} 管理用量。未回退到 API 密钥。`;
	if (/scope|authorization_context|permission/.test(message)) return "缺少 ChatGPT 套餐权限。请在“服务商”中重新连接并授权使用套餐。未回退到 API 密钥。";
	if (/expired|invalid_grant|401|invalid_user/.test(message)) return "你的 ChatGPT 会话已过期。请在“服务商”中重新连接。未回退到 API 密钥。";
	if (/background|Background/.test(message)) return "本应用已关闭 ChatGPT 后台使用。请在“服务商”中为所有 ChatGPT 账户启用“允许后台使用”以运行此任务。未回退到 API 密钥。";
	if (/eligible|403/.test(message)) return "此 ChatGPT 账户或工作区不允许该请求。请检查 ChatGPT 设置；重新连接可能不会改变资格。";
	if (/cancel|abort|closed|disconnect/i.test(message)) return "ChatGPT 请求已取消或连接已关闭。未回退到 API 密钥。";
	if (/catalog|model/.test(message)) return "此 ChatGPT 账户无法使用所选模型。请刷新“服务商”并显式选择一个可用模型。未回退到 API 密钥。";
	if (/incomplete|terminal|interrupted|stop reason/.test(message)) return "ChatGPT 返回了不完整的响应。方便时重试；未回退到 API 密钥。";
	return "ChatGPT 请求失败。请检查网络与 ChatGPT 用量后重试。未回退到 API 密钥。";
}

/** Restrict the body at the final payload seam, even if caller samplingParams add fields. */
export function chatGPTPayload(raw: unknown, selectedModelId: string): Record<string, unknown> {
	const payload = raw as Record<string, unknown>;
	const out: Record<string, unknown> = { model: selectedModelId, store: false, stream: true };
	for (const key of ["instructions", "reasoning", "include", "text", "tool_choice", "parallel_tool_calls", "prompt_cache_key"]) {
		if (payload[key] !== undefined) out[key] = payload[key];
	}
	if (!Array.isArray(payload.input)) throw new Error("ChatGPT 要求无状态的输入历史");
	out.input = payload.input.map((item) => item?.role === "system" ? { ...item, role: "developer" } : item);
	if (Array.isArray(payload.tools) && payload.tools.length) {
		if (payload.tools.some((tool) => tool.type !== "function" && tool.type !== "custom")) throw new Error("不支持的 ChatGPT 工具能力");
		out.tools = [{ type: "namespace", name: "learnharness", description: "LearnHarness 本地学习工具", tools: payload.tools }];
	}
	return out;
}

/** Only ChatGPT history is translated. Mixed API-key history keeps its actual identity. */
export function chatGPTHistory(context: TranscriptContext, logicalModel: Model<Api>): TranscriptContext {
	// Apply Pi's normal foreign-model signature treatment BEFORE the alias
	// becomes openai, or real API-key turns could look like subscription turns.
	const messages = transformMessages(context.messages, logicalModel);
	return { ...context, messages: messages.map((m) => m.role === "assistant" && m.provider === "chatgpt" ? { ...m, provider: "openai" } : m) };
}
function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: "chatgpt", model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function chatGPTStream(background: () => boolean, lifecycle?: ChatGPTDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (logicalModel, context, options) => {
		const output = new AssistantMessageEventStream();
		const purpose = background();
		const { controller, release } = chatGPTAbortController(purpose);
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		void (async () => {
			let partial = empty(logicalModel);
			let completed = false;
			let failure = "";
			let scope: AdmissionScope | undefined;
			let committed = false;
			let terminal = false;
			const check = () => { if (signal.aborted || !scope || !chatGPTScopeCurrent(scope)) throw new Error("已取消或目录授权已变更"); };
			try {
				if (logicalModel.provider !== "chatgpt") throw new Error("ChatGPT 账户目录中没有选定的模型");
				if (Object.keys(options?.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) throw new Error("禁止覆盖授权");
				scope = chatGPTScope(logicalModel.id);
				lifecycle?.captured(scope);
				const credentials = await chatGPTLease(scope, purpose);
				check();
				// NEVER dispatch through Models under openai: that would expose ambient API-key fallback.
				const transport: Model<"openai-responses"> = { ...logicalModel, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", headers: undefined, samplingParams: undefined, compat: { ...logicalModel.compat, supportsDeveloperRole: true } };
				const delegate = options?.fetch ?? globalThis.fetch;
				const source = streamSimple(transport, chatGPTHistory(context, logicalModel), {
					...options,
					apiKey: credentials.accessToken,
					signal,
					maxRetries: 0,
					headers: { "OpenAI-Beta": null, ...options?.headers },
					fetch: (input, init) => {
						check();
						if (committed) throw new Error("ChatGPT 不会重试已受理的请求");
						lifecycle?.beforeDispatch(scope!);
						committed = true;
						return delegate(input, init);
					},
					onPayload: async (raw, model) => {
						const replacement = await options?.onPayload?.(raw, model);
						const payload = chatGPTPayload(replacement === undefined ? raw : replacement, logicalModel.id);
						check();
						capturePreparedBackgroundPayload(payload, logicalModel);
						return payload;
					},
					onProviderStreamEvent: async (raw, model) => {
						const event = raw as { type?: string; code?: string; error?: { code?: string }; response?: { error?: { code?: string }; status?: string } };
						if (event.type === "response.completed" && event.response?.status === "completed" && !event.response?.error) completed = true;
						if (["response.incomplete", "response.failed", "error"].includes(event.type ?? "") || event.response?.error) failure = event.code || event.error?.code || event.response?.error?.code || "incomplete terminal response";
						await options?.onProviderStreamEvent?.(raw, model);
					},
				});
				for await (const event of source) {
					const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
					// Copy the message, not its tool/reasoning blocks: IDs/signatures remain byte-for-byte intact.
					partial = { ...message, provider: "chatgpt" };
					if (event.type === "done") {
						if (!completed || failure) throw new Error(failure || "缺少终止事件 response.completed");
						terminal = true;
						output.push({ ...event, message: partial });
					} else if (event.type === "error") {
						throw new Error(failure || event.error.errorMessage || "ChatGPT 流错误");
					} else output.push({ ...event, partial });
				}
			} catch (err) {
				if (terminal) return;
				if (!committed) lifecycle?.noDispatch(await chatGPTDenial(scope, controller, options?.signal?.aborted === true, purpose));
				partial = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: chatGPTStreamError(err instanceof Error ? err.message : "") };
				output.push({ type: "error", reason: partial.stopReason as "error" | "aborted", error: partial });
			} finally { release(); output.end(); }
		})();
		return output;
	};
}
