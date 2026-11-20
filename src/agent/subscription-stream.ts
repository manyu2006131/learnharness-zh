import { normalizeContext, type Api, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions, type StreamFunction, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { NATIVE_SUBSCRIPTIONS, type NativeSubscriptionScope } from "../core/contracts/subscriptions.ts";
import { nativeSubscriptionId, nativeSubscriptionBackgroundAllowed, subscriptionScope, subscriptionScopeCurrent, subscriptionAdmissionScope, subscriptionLease, subscriptionAbortController, subscriptionDenial } from "./subscription-bridge.ts";
import { markUnadmittedUsage, type SubscriptionDispatchLifecycle } from "./subscription-request-cycle.ts";
import { capturePreparedBackgroundPayload } from "./background-capture.ts";

export function nativeSubscriptionError(provider: string, message: string): string {
	const label = NATIVE_SUBSCRIPTIONS.find((p) => p.logicalId === provider)?.label ?? "订阅";
	const suffix = "未回退到 API 密钥。";
	if (/background/i.test(message)) return `${label} 的后台使用已在此应用中关闭。请在“服务商”中启用后再运行此任务。${suffix}`;
	if (/quota|429|limit/i.test(message)) return `${label} 用量已达上限。请检查服务商账户后稍后重试。${suffix}`;
	if (/expired|invalid_grant|401|refresh/i.test(message)) return `${label} 授权无法刷新。请在“服务商”中重试或重新连接。${suffix}`;
	if (/cancel|abort|closed|disconnect/i.test(message)) return `${label} 请求已取消或连接已关闭。${suffix}`;
	if (/catalog|model|stale|changed/i.test(message)) return `所选 ${label} 模型或连接不可用。请刷新“服务商”并显式选择一个可用模型。${suffix}`;
	return `${label} 请求失败。请检查连接、账户权限与服务商限额后重试。${suffix}`;
}
export function subscriptionHistory(context: TranscriptContext, logical: Model<Api>, nativeId: string): TranscriptContext {
	const messages = transformMessages(context.messages, logical);
	return { ...context, messages: messages.map((message) => message.role === "assistant" && message.provider === logical.provider ? { ...message, provider: nativeId } : message) };
}
function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
/** Direct native provider dispatch bypasses Models' ambient credential resolution entirely. */
export function nativeSubscriptionStream(provider: Provider, background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (logicalModel, context, options) => {
		const output = new AssistantMessageEventStream();
		const nativeId = nativeSubscriptionId(logicalModel.provider);
		if (!nativeId || provider.id !== nativeId) {
			const error = { ...empty(logicalModel), errorMessage: nativeSubscriptionError(logicalModel.provider, "model unavailable") }; markUnadmittedUsage(error.usage); lifecycle?.noDispatch("other");
			output.push({ type: "error", reason: "error", error }); output.end(); return output;
		}
		const purpose = background();
		const { controller, release } = subscriptionAbortController(nativeId, purpose);
		const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		void (async () => {
			let partial = empty(logicalModel), scope: NativeSubscriptionScope | undefined;
			let committed = false, terminal = false;
			const check = () => {
				if (signal.aborted || !scope || !subscriptionScopeCurrent(scope)) throw new Error("已取消或连接已变更");
				if (purpose && !nativeSubscriptionBackgroundAllowed(nativeId)) throw new Error("background use disabled");
			};
			try {
				if (Object.keys(options?.headers ?? {}).some((key) => ["authorization", "x-api-key", "api-key", "host"].includes(key.toLowerCase()))) throw new Error("禁止覆盖授权");
				scope = subscriptionScope(nativeId, logicalModel.id); lifecycle?.captured(subscriptionAdmissionScope(scope));
				const auth = await subscriptionLease(scope, purpose); check();
				const authKeys = new Set(Object.keys(auth.headers ?? {}).map((key) => key.toLowerCase()));
				if (Object.keys(options?.headers ?? {}).some((key) => authKeys.has(key.toLowerCase()))) throw new Error("禁止覆盖授权");
				const nativeModel = provider.getModels().find((model) => model.id === logicalModel.id && model.api === logicalModel.api);
				if (!nativeModel) throw new Error("原生模型不可用");
				const transport = { ...nativeModel, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) };
				const fetch = options?.fetch ?? globalThis.fetch;
				const source = provider.streamSimple(transport, subscriptionHistory(normalizeContext(context), logicalModel, nativeId), {
					...options, apiKey: auth.apiKey, headers: { ...options?.headers, ...auth.headers }, signal, maxRetries: 0,
					fetch: (input, init) => {
						check(); if (committed) throw new Error("订阅请求在派发后不会重试");
						lifecycle?.beforeDispatch(subscriptionAdmissionScope(scope!)); committed = true; return fetch(input, init);
					},
					onPayload: async (raw, model) => {
						const replacement = await options?.onPayload?.(raw, model); check();
						if (replacement === undefined) {
							capturePreparedBackgroundPayload(raw, logicalModel);
							return raw;
						}
						if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) throw new Error("模型负载覆盖无效");
						const payload = { ...replacement, model: (raw as { model: string }).model };
						capturePreparedBackgroundPayload(payload, logicalModel);
						return payload;
					},
				});
				for await (const event of source) {
					check();
					const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
					partial = { ...message, provider: logicalModel.provider };
					if (event.type === "error") throw new Error(event.error.errorMessage ?? "原生流失败");
					if (event.type === "done") { if (!terminal) { terminal = true; output.push({ ...event, message: partial }); } }
					else if (!terminal) output.push({ ...event, partial });
				}
				if (!terminal) throw new Error("原生流在终止响应前结束");
			} catch (error) {
				if (terminal) return;
				if (!committed) { markUnadmittedUsage(partial.usage); lifecycle?.noDispatch(await subscriptionDenial(scope, controller, options?.signal?.aborted === true, purpose)); }
				partial = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: nativeSubscriptionError(logicalModel.provider, error instanceof Error ? error.message : "") };
				output.push({ type: "error", reason: partial.stopReason as "error" | "aborted", error: partial });
			} finally { release(); output.end(); }
		})();
		return output;
	};
}
