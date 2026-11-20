import { NATIVE_SUBSCRIPTIONS } from "../core/contracts/subscriptions.ts";
import { subscriptionRequestOrigin } from "./desktop-access.ts";
import { webSubscriptionOwner, webSubscriptionsEnabled, webSubscriptionStatus } from "./web-subscriptions.ts";

// Lives in desktop-access.ts so proxy.ts can share it without loading the
// subscription runtime; re-exported for existing callers.
export { subscriptionRequestOrigin };

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
function authorized(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("x-learnharness-subscriptions") !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin;
}
function error(message: string, status: number) { return Response.json({ error: message }, { status, headers: HEADERS }); }
export async function subscriptionControlsResponse(request: Request): Promise<Response> {
	if (!webSubscriptionsEnabled()) return error("桌面占用模式下无法使用网络订阅控制。", 404);
	if (!authorized(request)) return error("订阅控制要求来自同源的 LearnHarness 请求。", 403);
	try {
		if (request.method === "GET") return Response.json(await webSubscriptionStatus(), { headers: HEADERS });
		if (request.method !== "POST") return error("不支持的方法。", 405);
		if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected JSON.", 415);
		// Bound both advertised and streamed input before parsing commands.
		if (Number(request.headers.get("content-length")) > 16384) return error("请求过大。", 413);
		const reader = request.body?.getReader();
		if (!reader) return error("Expected a command.", 400);
		const chunks: Uint8Array[] = []; let size = 0;
		try {
			for (;;) {
				const next = await reader.read(); if (next.done) break;
				size += next.value.byteLength;
				if (size > 16384) { await reader.cancel(); return error("请求过大。", 413); }
				chunks.push(next.value);
			}
		} finally { reader.releaseLock(); }
		const command: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!command || typeof command !== "object" || Array.isArray(command)) return error("命令无效。", 400);
		const fields = command as Record<string, unknown>;
		const providerId = fields.providerId;
		if (providerId !== "chatgpt" && !NATIVE_SUBSCRIPTIONS.some((provider) => provider.providerId === providerId)) return error("不支持的连接。", 400);
		const allowed = providerId === "chatgpt" ? ["login", "cancel", "select", "disconnect", "logout", "consent"] : ["login", "cancel", "respond", "open", "retry", "disconnect", "consent"];
		if (typeof fields.op !== "string" || !allowed.includes(fields.op)) return error("不支持的控制。", 400);
		return Response.json(await webSubscriptionOwner().control(providerId as string, fields, subscriptionRequestOrigin(request)!), { headers: HEADERS });
	} catch {
		return error("无法更改订阅连接。请重试或在“服务商”中重新连接。", 400);
	}
}
/** One-use same-origin navigation. Full provider authorization URLs go only to
 * a top-level browser redirect, never status JSON, the SSE bus or application JS. */
export async function subscriptionBrowserResponse(request: Request): Promise<Response> {
	if (!webSubscriptionsEnabled()) return error("Unavailable.", 404);
	const origin = subscriptionRequestOrigin(request);
	if (!origin || (request.method === "POST" ? !authorized(request) : request.headers.get("sec-fetch-site") !== "same-origin")) return error("请从 LearnHarness 打开登录。", 403);
	const id = new URL(request.url).searchParams.get("id");
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) return error("此登录操作已不再有效。", 410);
	const target = await webSubscriptionOwner().takeBrowserAction(id, origin);
	if (!target) return error("此登录操作已不再有效。", 410);
	return new Response(null, { status: 303, headers: { ...HEADERS, Location: target } });
}
