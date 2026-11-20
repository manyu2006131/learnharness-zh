"use strict";

/** Desktop-dev has no tabs. Resolve only an opaque action on its own Next
 * server, then open the owner-validated provider page outside the renderer.
 * The caller must authenticate its trusted app main frame first. */
async function openWebSubscriptionBrowser(action, origin, { fetch: request = globalThis.fetch, openExternal }) {
	if (typeof action !== "string" || !/^\/api\/subscriptions\/browser\?id=[0-9a-f-]{36}$/.test(action)) throw new Error("登录操作无效。");
	const response = await request(new URL(action, origin), {
		method: "POST", redirect: "manual", credentials: "omit",
		headers: { origin, "x-learnharness-subscriptions": "1" },
		signal: AbortSignal.timeout(15000),
	});
	const target = response.headers.get("location");
	if (response.status !== 303 || !target) throw new Error("登录操作已过期。");
	const parsed = new URL(target);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("服务商页面无效。");
	await openExternal(target);
}
module.exports = { openWebSubscriptionBrowser };
