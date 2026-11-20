import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PLUGIN_ID_PATTERN, parsePluginManifest } from "../core/plugins.ts";
import { validatePluginSchema } from "../core/plugin-validation.ts";
import { createPluginQuestionParameters, preparePluginQuestionType } from "../core/plugin-questions.ts";
import type { PluginQuestionVariant } from "../core/plugin-questions.ts";
import type { NativePluginQuestionDefinition } from "../agent/plugin-question-tools.ts";
import { preparePluginProblemType, createPluginProblemParameters, type NativePluginProblemDefinition } from "../core/plugin-problems.ts";
import type { NativePluginProblemContribution } from "../agent/plugin-problem-tools.ts";
import type { PluginAgentKind, PluginBackendContext, PluginBackendModule, PluginCleanup, PluginFrontendContext, PluginInfo, PluginInference, PluginInstructions, PluginLearningData, PluginManifest, PluginNotification, PluginToolContext, PluginTools } from "../core/plugins.ts";
import type { PluginAgentService } from "../core/plugin-agents.ts";
import type { PluginWorkerService } from "../core/plugin-workers.ts";
import type { ServerEvent } from "../core/events.ts";
import { safePluginDataDirectory } from "../store/plugin-data-paths.ts";

/** Expected host/transport failure. Exceptions thrown by plugin handlers stay ordinary 500 errors. */
export class PluginHostError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message); this.name = "PluginHostError";
		Object.defineProperty(this, Symbol.for("learnharness.plugin-host-error"), { value: true });
	}
}
/** Works across Next module instances holding the same process-global host. */
export function isPluginHostError(error: unknown): error is { status: number; message: string } {
	if (!error || typeof error !== "object") return false;
	try {
		const value = error as Record<string | symbol, unknown>;
		return value[Symbol.for("learnharness.plugin-host-error")] === true &&
			typeof value.message === "string" && typeof value.status === "number" &&
			[400, 404, 409, 413, 500, 503].includes(value.status);
	} catch { return false; }
}

export interface PluginHostDependencies {
	directory: string;
	/** App-owned flat built packages and a separate writable data root. */
	core?: { directory: string; dataDirectory: string; ids: readonly string[] };
	appVersion: string;
	createServices(info: { manifest: PluginManifest; directory: string; dataDirectory: string; signal: AbortSignal; cleanup: (fn: PluginCleanup) => void }): {
		learning: PluginLearningData; inference: PluginInference; agents: PluginAgentService; workers: PluginWorkerService;
		createBackgroundTool: PluginBackendContext["createBackgroundTool"];
	};
	/** One process-wide pure converter; no backend services are needed for uploads. */
	convertDocument?: (request: Request, signal: AbortSignal) => ReturnType<PluginFrontendContext["documents"]["toMarkdown"]>;
	onChange?: () => void;
	onNotification?: (notification: PluginNotification) => void;
	subscribeEvents?: (listener: (event: ServerEvent) => void) => () => void;
	/** Startup installation/recovery failures, including failures before a package directory exists. */
	installationErrors?: Record<string, string>;
}
interface Instructions { agents: Set<PluginAgentKind>; text: string }
interface Tools { agents: Set<PluginAgentKind>; create: PluginTools["create"] }
type QuestionDefinition = NativePluginQuestionDefinition;
/** Frozen per-turn provenance, admitted atomically with ordinary package contributions. */
export interface PluginQuestionContribution {
	pluginId: string;
	definition: QuestionDefinition;
	variant: PluginQuestionVariant;
	signal: AbortSignal;
	requireActive(): void;
}
export type PluginQuestionResolution =
	| { status: "available"; definition: QuestionDefinition; signal: AbortSignal; requireActive(): void }
	| { status: "incompatible" }
	| { status: "unavailable" };
export type PluginProblemResolution =
	| { status: "available"; definition: NativePluginProblemDefinition; signal: AbortSignal; requireActive(): void }
	| { status: "incompatible" | "unavailable" };
export interface PluginAgentContributions { instructions: string[]; tools: AgentTool<any>[]; questionTypes?: PluginQuestionContribution[]; problemTypes?: NativePluginProblemContribution[] }
interface Activation {
	controller: AbortController;
	cleanups: PluginCleanup[];
	handlers: Map<string, (input: unknown) => unknown | Promise<unknown>>;
	instructions: Set<Instructions>;
	tools: Set<Tools>;
	questions: Map<string, QuestionDefinition>;
	problems: Map<string, NativePluginProblemDefinition>;
	ready: boolean;
}
interface Package {
	info: PluginInfo;
	rootDirectory: string;
	directory: string;
	files: Map<string, Buffer>;
	activation?: Activation;
	backend?: PluginBackendModule;
	restart?: string;
	blocked?: boolean;
	contributionWarning?: string;
}
interface State { version: 1; enabled: Record<string, boolean> }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const operationId = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
// Common native provider subset: no punctuation, leading digit, or >64-char names.
const nativeToolName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const agentKinds: readonly PluginAgentKind[] = ["prober", "teacher", "practice"];
function targets(agents: PluginAgentKind[]): Set<PluginAgentKind> {
	if (!Array.isArray(agents) || !agents.length || !agents.every(agent => agentKinds.includes(agent))) throw new Error("插件贡献需要显式非空的 prober/teacher/practice 目标");
	return new Set(agents);
}
const safeSegment = (p: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p);

function readState(filename: string): State {
	if (!exists(filename)) return { version: 1, enabled: Object.create(null) };
	if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error("Unsafe plugins-state.json");
	const value: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filename, "utf8"));
	if (!object(value) || value.version !== 1 || !object(value.enabled)) throw new Error("Invalid or unsupported plugins-state.json");
	const enabled: Record<string, boolean> = Object.create(null);
	for (const [id, flag] of Object.entries(value.enabled)) {
		if (!PLUGIN_ID_PATTERN.test(id) || typeof flag !== "boolean") throw new Error("plugins-state.json 中的启用条目无效");
		enabled[id] = flag;
	}
	return { version: 1, enabled };
}
function writeState(filename: string, state: State): void {
	const temp = `${filename}.${randomUUID()}.tmp`;
	try {
		const fd = fs.openSync(temp, "wx", 0o600);
		try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(temp, filename);
	} finally { if (exists(temp)) fs.unlinkSync(temp); }
}
function regularFile(root: string, relative: string): string {
	const segments = relative.split("/");
	if (!segments.every(safeSegment)) throw new Error("插件文件路径无效");
	let current = root;
	if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("不安全的插件目录");
	const realRoot = fs.realpathSync(/* turbopackIgnore: true */ root);
	for (let i = 0; i < segments.length; i++) {
		current = path.join(current, segments[i]!);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || (i === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("符号链接和非文件不能作为插件资源");
		const real = fs.realpathSync(/* turbopackIgnore: true */ current);
		if (!real.startsWith(realRoot + path.sep)) throw new Error("插件文件逃逸出其包目录");
	}
	return current;
}
function pluginRoot(directory: string): void {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("不安全的插件目录");
}
function snapshot(rootDirectory: string, id: string, appVersion: string, origin: "core" | "community"): Package {
	pluginRoot(rootDirectory);
	const directory = origin === "core" ? rootDirectory : path.join(/* turbopackIgnore: true */ rootDirectory, "dist");
	if (!exists(directory)) throw new Error("缺少插件构建产物：需要 dist/manifest.json。请将插件构建到 dist/，或在其中安装已构建的包。");
	pluginRoot(directory);
	const files = new Map<string, Buffer>();
	const manifestBytes = fs.readFileSync(/* turbopackIgnore: true */ regularFile(directory, "manifest.json"));
	const manifest = Object.freeze(parsePluginManifest(JSON.parse(manifestBytes.toString("utf8")), id, appVersion));
	function collect(relative: string): void {
		for (const name of fs.readdirSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ directory, relative)).sort()) {
			if (!safeSegment(name) || (!relative && name === "data")) continue;
			const file = relative ? `${relative}/${name}` : name;
			const stat = fs.lstatSync(path.join(directory, file));
			if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in plugin package files: ${file}`);
			if (stat.isDirectory()) {
				if (file === "assets" || file.startsWith("assets/")) collect(file);
			} else if (stat.isFile()) files.set(file, fs.readFileSync(/* turbopackIgnore: true */ regularFile(directory, file)));
			else throw new Error(`Invalid plugin file: ${file}`);
		}
	}
	collect("");
	for (const entry of [manifest.main, manifest.backend, manifest.styles]) if (entry && !files.has(entry)) throw new Error(`Missing plugin entry: ${entry}`);
	const hash = createHash("sha256");
	for (const [file, bytes] of files) { hash.update(`${file.length}:${file}:${bytes.length}:`); hash.update(bytes); }
	return { rootDirectory, directory, files, info: { id, origin, manifest, enabled: false, status: "disabled", revision: hash.digest("hex") } };
}
const mimeTypes: Record<string, string> = {
	".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

/** Injectable, trusted-local-code host. Importing this module does no IO. */
export function createPluginHost(deps: PluginHostDependencies) {
	// Installed packages/state are runtime inputs, not build-time dependencies.
	const directory = path.resolve(/* turbopackIgnore: true */ deps.directory);
	const stateFile = path.resolve(/* turbopackIgnore: true */ directory, "..", "plugins-state.json");
	const core = deps.core ? { ...deps.core, ids: Object.freeze([...deps.core.ids]) } : undefined;
	const coreIds = new Set(core?.ids ?? []);
	if (core && (coreIds.size !== core.ids.length || core.ids.some(id => typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)))) throw new Error("核心插件目录无效");
	if (core) {
		const code = path.resolve(/* turbopackIgnore: true */ core.directory);
		const data = path.resolve(/* turbopackIgnore: true */ core.dataDirectory);
		const relative = path.relative(code, data);
		if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Core plugin data must be outside app-owned code");
	}
	const coreData = core ? { directory: core.dataDirectory, ids: core.ids } : undefined;
	let conflicts: { id: string; error: string }[] = [];
	const packages = new Map<string, Package>();
	const questionControllers = new WeakMap<QuestionDefinition, AbortController>();
	const problemControllers = new WeakMap<NativePluginProblemDefinition, AbortController>();
	let initialized = false, disposed = false;
	let serial: Promise<unknown> = Promise.resolve();
	let disposing: Promise<void> | undefined;
	const assertOpen = () => { if (disposed) throw new PluginHostError(503, "插件宿主已释放"); };
	const change = () => { if (disposed) return; try { deps.onChange?.(); } catch { /* Observers do not own host lifecycle. */ } };
	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = serial.then(fn); serial = result.catch(() => {}); return result;
	};
	const get = (id: string) => { const pkg = packages.get(id); if (!pkg) throw new PluginHostError(404, `Unknown plugin: ${id}`); return pkg; };
	const live = (pkg: Package, activation: Activation) => !disposed && pkg.activation === activation && !activation.controller.signal.aborted;

	async function deactivate(pkg: Package): Promise<string[]> {
		const activation = pkg.activation;
		if (!activation) return [];
		pkg.activation = undefined; // Invalidate callbacks BEFORE abort listeners and cleanup run.
		activation.ready = false;
		activation.handlers.clear();
		activation.instructions.clear();
		activation.tools.clear();
		activation.questions.clear();
		activation.problems.clear();
		activation.controller.abort();
		const failures: string[] = [];
		for (const cleanup of activation.cleanups.splice(0).reverse()) {
			try { await cleanup(); } catch (e) { failures.push(errorText(e)); }
		}
		return failures;
	}
	async function activate(pkg: Package): Promise<void> {
		assertOpen();
		if (!pkg.info.manifest || pkg.blocked || pkg.restart) {
			pkg.info.status = "error";
			return;
		}
		const manifest = pkg.info.manifest;
		const activation: Activation = { controller: new AbortController(), cleanups: [], handlers: new Map(), instructions: new Set(), tools: new Set(), questions: new Map(), problems: new Map(), ready: false };
		pkg.activation = activation;
		const requireLive = () => { if (!live(pkg, activation)) throw new Error("插件激活已失效"); };
		const cleanup = (fn: PluginCleanup) => {
			if (typeof fn !== "function") throw new Error("插件清理函数必须是函数");
			if (live(pkg, activation)) activation.cleanups.push(fn);
			else { try { Promise.resolve(fn()).catch(() => {}); } catch { /* Late cleanup still gets a chance to release resources. */ } }
		};
		try {
			if (manifest.backend) {
				pluginRoot(pkg.rootDirectory);
				const dataDirectory = safePluginDataDirectory(directory, manifest.id, coreData, true)!;
				const services = deps.createServices({ manifest, directory: pkg.directory, dataDirectory, signal: activation.controller.signal, cleanup });
				cleanup(() => services.agents.dispose());
				cleanup(() => services.workers.dispose());
				const ctx: PluginBackendContext = {
					manifest, directory: pkg.directory, dataDirectory, signal: activation.controller.signal, cleanup, ...services,
					createBackgroundTool(context, definition) { requireLive(); return services.createBackgroundTool(context, definition); },
					registerInstructions(contribution: PluginInstructions) {
						requireLive();
						const agents = targets(contribution?.agents);
						if (typeof contribution.text !== "string" || !contribution.text.trim()) throw new Error("插件说明必须包含非空文本");
						const registered = { agents, text: contribution.text };
						activation.instructions.add(registered);
						return () => { activation.instructions.delete(registered); };
					},
					registerTools(contribution: PluginTools) {
						requireLive();
						const agents = targets(contribution?.agents);
						if (typeof contribution.create !== "function") throw new Error("插件工具需要原生工具工厂");
						const registered = { agents, create: contribution.create.bind(contribution) };
						activation.tools.add(registered);
						return () => { activation.tools.delete(registered); };
					},
					registerQuestionType(definition) {
						requireLive();
						const registered = preparePluginQuestionType(definition);
						if (activation.questions.has(registered.id)) throw new Error(`Duplicate plugin question type: ${registered.id}`);
						const controller = new AbortController();
						questionControllers.set(registered, controller);
						activation.questions.set(registered.id, registered);
						if (activation.ready) change();
						return () => {
							if (activation.questions.get(registered.id) !== registered) return;
							activation.questions.delete(registered.id);
							controller.abort();
							if (activation.ready && live(pkg, activation)) change();
						};
					},
					registerProblemType(definition) {
						requireLive();
						const registered = preparePluginProblemType(definition);
						if (activation.problems.has(registered.id)) throw new Error(`Duplicate plugin problem type: ${registered.id}`);
						const controller = new AbortController();
						problemControllers.set(registered, controller);
						activation.problems.set(registered.id, registered);
						if (activation.ready) change();
						return () => {
							if (activation.problems.get(registered.id) !== registered) return;
							activation.problems.delete(registered.id);
							controller.abort();
							if (activation.ready && live(pkg, activation)) change();
						};
					},
					handle(name, handler) {
						requireLive();
						if (!operationId.test(name) || typeof handler !== "function") throw new Error("插件操作 id 或处理器无效");
						if (activation.handlers.has(name)) throw new Error(`Duplicate plugin operation: ${name}`);
						// Unique token prevents a stale unregister from deleting a replacement.
						const registered = (input: unknown) => handler(input);
						activation.handlers.set(name, registered);
						return () => { if (activation.handlers.get(name) === registered) activation.handlers.delete(name); };
					},
					events: {
						on(listener) {
							requireLive();
							if (typeof listener !== "function") throw new Error("插件事件监听器无效");
							let subscribed = true;
							const unsubscribe = deps.subscribeEvents?.(event => {
								if (!subscribed || !live(pkg, activation)) return;
								try { Promise.resolve(listener(event)).catch(() => {}); } catch { /* Isolate plugin listeners. */ }
							});
							const off = () => { if (subscribed) { subscribed = false; unsubscribe?.(); } };
							cleanup(off); return off;
						},
						emit(topic, data) {
							if (!live(pkg, activation)) return;
							if (!operationId.test(topic)) throw new Error("插件通知主题无效");
							try { deps.onNotification?.({ pluginId: manifest.id, topic, data }); } catch { /* Isolate observers. */ }
						},
					},
				};
				if (!pkg.backend) {
					const entry = regularFile(pkg.directory, manifest.backend);
					// This absolute runtime path is deliberately NOT an import/require in
					// Next's module graph. Ship scripts/plugin-loader.cjs alongside app.
					const sidecar = path.join(process.cwd(), "scripts", "plugin-loader.cjs");
					const nativeRequire = createRequire(sidecar);
					const loader = nativeRequire(sidecar) as { load(filename: string): PluginBackendModule };
					pkg.backend = loader.load(entry);
					if (!pkg.backend || typeof pkg.backend.activate !== "function") throw new Error("Plugin backend must export activate(context)");
				}
				const returned = await pkg.backend.activate(ctx);
				if (returned !== undefined) cleanup(returned);
			}
			if (!live(pkg, activation)) { await deactivate(pkg); pkg.info.status = "disabled"; return; }
			activation.ready = true;
			pkg.info.status = "active";
			delete pkg.contributionWarning;
			delete pkg.info.error;
		} catch (e) {
			const failures = await deactivate(pkg);
			pkg.info.status = "error";
			pkg.info.error = [errorText(e), ...failures.map(f => `Cleanup: ${f}`)].join("; ");
		}
	}

	async function discover(state: State): Promise<void> {
		const installationErrors = deps.installationErrors ?? {};
		const failed = (id: string) => Object.hasOwn(installationErrors, id);
		const communityIds = fs.readdirSync(/* turbopackIgnore: true */ directory).filter(id => {
			const stat = fs.lstatSync(path.join(/* turbopackIgnore: true */ directory, id));
			return stat.isDirectory() || stat.isSymbolicLink();
		});
		conflicts = communityIds.filter(id => coreIds.has(id)).sort().map(id => ({ id, error: `Community package ${id} was skipped: this ID is reserved for a Core plugin. Its files were not changed.` }));
		const ids = new Set([...communityIds.filter(id => !coreIds.has(id)), ...coreIds, ...Object.keys(installationErrors)]);
		for (const id of [...ids].sort()) {
			const origin = coreIds.has(id) ? "core" : "community";
			const root = path.join(/* turbopackIgnore: true */ origin === "core" ? core!.directory : directory, id);
			let candidate: Package;
			try {
				if (failed(id)) throw new Error(`Plugin startup failed: ${installationErrors[id]}`);
				if (origin === "core") pluginRoot(core!.directory);
				candidate = snapshot(root, id, deps.appVersion, origin);
			} catch (e) {
				candidate = { rootDirectory: root, directory: origin === "core" ? root : path.join(/* turbopackIgnore: true */ root, "dist"), files: new Map(), info: { id, origin, enabled: false, status: "error", error: errorText(e), revision: "" }, blocked: true };
			}
			const current = packages.get(id);
			// An unbuilt/invalid package has never admitted executable code. Its
			// first valid build is ordinary discovery, not a code reload.
			if (current && !(current.blocked && !current.info.manifest)) {
				if (failed(id)) {
					await deactivate(current); current.blocked = true; current.info.status = "error";
					current.info.error = candidate.info.error;
				} else if (candidate.info.revision !== current.info.revision || candidate.info.error !== undefined) {
					current.restart = `Restart required: plugin package changed${candidate.info.error ? ` (${candidate.info.error})` : ""}`;
					current.info.error = [current.restart, current.contributionWarning].filter(Boolean).join("; ");
				}
				continue;
			}
			candidate.info.enabled = state.enabled[id] === true;
			packages.set(id, candidate);
			if (candidate.info.enabled && !candidate.blocked) await activate(candidate);
		}
		for (const [id, pkg] of packages) if (!ids.has(id)) {
			pkg.restart = "需要重启：插件包已被移除";
			pkg.info.error = [pkg.restart, pkg.contributionWarning].filter(Boolean).join("; ");
		}
	}
	async function initializeInternal(): Promise<void> {
		assertOpen();
		if (initialized) return;
		const state = readState(stateFile); // Never hide corrupt/future state or execute code first.
		fs.mkdirSync(directory, { recursive: true });
		if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("不安全的插件目录");
		await discover(state);
		initialized = true; change();
	}

	/** One synchronous per-turn snapshot. Failed packages contribute nothing, not even instructions. */
	function agentContributions(context: PluginToolContext, reservedToolNames: readonly string[]): PluginAgentContributions {
		assertOpen();
		if (!initialized) throw new PluginHostError(503, "插件宿主未初始化");
		if (!context || typeof context.chatId !== "string" || !context.chatId.trim() || !agentKinds.includes(context.agent)) throw new PluginHostError(400, "插件工具上下文无效");
		const turn = Object.freeze({ chatId: context.chatId, agent: context.agent });
		const names = new Set(reservedToolNames);
		const result: PluginAgentContributions = { instructions: [], tools: [] };
		// Capture ALL registration lists before any factory can change registrations.
		const contributions = [...packages.keys()].sort().flatMap(id => {
			const pkg = packages.get(id)!, activation = pkg.activation;
			return pkg.info.enabled && activation?.ready && live(pkg, activation)
				? [{ pkg, activation, instructions: [...activation.instructions], factories: [...activation.tools], questions: [...activation.questions.values()], problems: [...activation.problems.values()] }]
				: [];
		});
		for (const { pkg, activation, instructions, factories, questions, problems } of contributions) {
			try {
				const texts = instructions.filter(item => item.agents.has(turn.agent)).map(item => item.text);
				const tools: AgentTool<any>[] = [];
				const packageNames = new Set<string>();
				for (const factory of factories.filter(item => item.agents.has(turn.agent))) {
					if (!live(pkg, activation)) break;
					const created: unknown = factory.create(turn);
					if (!Array.isArray(created)) {
						// A contract-violating async factory must not leak an unhandled rejection.
						if (created && typeof (created as { then?: unknown }).then === "function") void Promise.resolve(created).catch(() => {});
						throw new Error("插件工具工厂必须同步返回原生工具数组");
					}
					for (const tool of created as AgentTool<any>[]) {
						if (!tool || typeof tool.name !== "string" || !nativeToolName.test(tool.name)) throw new Error("原生插件工具名无效（首字符为字母或下划线，后续为字母/数字/_/-，最多 64 个字符）");
						if (names.has(tool.name) || packageNames.has(tool.name)) throw new Error(`Plugin tool name collision: ${tool.name}`);
						if (typeof tool.execute !== "function" || typeof tool.label !== "string" || typeof tool.description !== "string" ||
							(tool.prepareArguments !== undefined && typeof tool.prepareArguments !== "function") ||
							(tool.executionMode !== undefined && tool.executionMode !== "parallel" && tool.executionMode !== "sequential") ||
							(tool.replay !== undefined && tool.replay !== "safe" && tool.replay !== "never")) throw new Error(`Invalid native plugin tool definition: ${tool.name}`);
						try {
							validatePluginSchema(tool.parameters);
							if (tool.outputSchema !== undefined) validatePluginSchema(tool.outputSchema);
						} catch (error) { throw new Error(`Invalid native plugin tool schema (${tool.name}): ${errorText(error)}`); }
						packageNames.add(tool.name);
						const execute = tool.execute, prepare = tool.prepareArguments;
						const requireActive = () => { if (!live(pkg, activation)) throw new PluginHostError(409, `Plugin ${pkg.info.id} is disabled or unavailable`); };
						tools.push({
							...tool,
							...(prepare ? { prepareArguments: args => { requireActive(); return prepare.call(tool, args); } } : {}),
							async execute(toolCallId, input, signal, onUpdate) {
								requireActive();
								const combined = signal ? AbortSignal.any([signal, activation.controller.signal]) : activation.controller.signal;
								combined.throwIfAborted();
								const output = await execute.call(tool, toolCallId, input, combined, onUpdate ? update => {
									if (live(pkg, activation) && !combined.aborted) onUpdate(update);
								} : undefined);
								combined.throwIfAborted();
								return output;
							},
						});
					}
				}
				const questionTypes: PluginQuestionContribution[] = [];
				const variant = turn.agent === "prober" ? "probe" : turn.agent === "teacher" ? "teach" : undefined;
				if (variant) for (const definition of questions) {
					const tool = definition[variant];
					if (!tool) continue;
					if (names.has(tool.toolName) || packageNames.has(tool.toolName)) throw new Error(`Plugin tool name collision: ${tool.toolName}`);
					validatePluginSchema(createPluginQuestionParameters(definition, variant));
					packageNames.add(tool.toolName);
					questionTypes.push(Object.freeze({
						pluginId: pkg.info.id, definition, variant, signal: activation.controller.signal,
						requireActive() { if (!live(pkg, activation)) throw new PluginHostError(409, `Plugin ${pkg.info.id} is disabled or unavailable`); },
					}));
				}
				const problemTypes: NativePluginProblemContribution[] = [];
				if (turn.agent === "practice") for (const definition of problems) {
					const tool = definition.tool;
					if (names.has(tool.toolName) || packageNames.has(tool.toolName)) throw new Error(`Plugin tool name collision: ${tool.toolName}`);
					validatePluginSchema(createPluginProblemParameters(definition));
					packageNames.add(tool.toolName);
					problemTypes.push(Object.freeze({ pluginId: pkg.info.id, definition,
						signal: AbortSignal.any([activation.controller.signal, problemControllers.get(definition)!.signal]),
						requireActive() {
							if (!live(pkg, activation) || activation.problems.get(definition.id) !== definition) throw new PluginHostError(409, `Plugin ${pkg.info.id} is disabled or unavailable`);
						} }));
				}
				if (!live(pkg, activation)) continue;
				for (const name of packageNames) names.add(name);
				result.instructions.push(...texts);
				result.tools.push(...tools);
				if (questionTypes.length) (result.questionTypes ??= []).push(...questionTypes);
				if (problemTypes.length) (result.problemTypes ??= []).push(...problemTypes);
				if (pkg.contributionWarning !== undefined) {
					delete pkg.contributionWarning;
					if (pkg.restart) pkg.info.error = pkg.restart;
					else delete pkg.info.error;
					change(); // The current loadout recovered; independent package diagnostics remain.
				}
			} catch (e) {
				if (!live(pkg, activation)) continue;
				const warning = `Agent contributions (${turn.agent}): ${errorText(e)}`;
				if (pkg.contributionWarning !== warning) {
					pkg.contributionWarning = warning;
					pkg.info.error = [pkg.restart, warning].filter(Boolean).join("; ");
					change(); // Activation stays active: views, assets and operations remain usable.
				}
			}
		}
		return result;
	}

	return {
		initialize: () => enqueue(initializeInternal),
		agentContributions,
		resolveQuestionType(pluginId: string, typeId: string, contractVersion: number): PluginQuestionResolution {
			assertOpen();
			if (!initialized) throw new PluginHostError(503, "插件宿主未初始化");
			const pkg = packages.get(pluginId), activation = pkg?.activation;
			if (!pkg || !pkg.info.enabled || !activation?.ready || !live(pkg, activation)) return { status: "unavailable" };
			const definition = activation.questions.get(typeId);
			if (!definition) return { status: "unavailable" };
			if (definition.incompatibleContractVersions?.includes(contractVersion)) return { status: "incompatible" };
			if (definition.contractVersion !== contractVersion) return { status: "unavailable" };
			return { status: "available", definition, signal: AbortSignal.any([activation.controller.signal, questionControllers.get(definition)!.signal]),
				requireActive() {
					if (!live(pkg, activation) || activation.questions.get(typeId) !== definition) throw new PluginHostError(409, `Plugin ${pkg.info.id} is disabled or unavailable`);
				} };
		},
		resolveProblemType(pluginId: string, typeId: string, contractVersion: number): PluginProblemResolution {
			assertOpen();
			if (!initialized) throw new PluginHostError(503, "插件宿主未初始化");
			const pkg = packages.get(pluginId), activation = pkg?.activation;
			if (!pkg || !pkg.info.enabled || !activation?.ready || !live(pkg, activation)) return { status: "unavailable" };
			const definition = activation.problems.get(typeId);
			if (!definition) return { status: "unavailable" };
			if (definition.incompatibleContractVersions?.includes(contractVersion)) return { status: "incompatible" };
			if (definition.contractVersion !== contractVersion) return { status: "unavailable" };
			return { status: "available", definition, signal: AbortSignal.any([activation.controller.signal, problemControllers.get(definition)!.signal]),
				requireActive() {
					if (!live(pkg, activation) || activation.problems.get(typeId) !== definition) throw new PluginHostError(409, `Plugin ${pkg.info.id} is disabled or unavailable`);
				} };
		},
		conflicts(): { id: string; error: string }[] { assertOpen(); return conflicts.map(value => ({ ...value })); },
		list(): PluginInfo[] {
			assertOpen();
			return [...packages.values()].map(({ info }) => ({ ...info, ...(info.manifest ? { manifest: { ...info.manifest } } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
		},
		setEnabled(id: string, enabled: boolean): Promise<void> {
			// Let a cooperative in-flight activation finish so queued teardown cannot deadlock.
			if (!enabled) {
				const activation = packages.get(id)?.activation;
				if (activation && !activation.ready) activation.controller.abort();
			}
			return enqueue(async () => {
				assertOpen(); await initializeInternal();
				if (!PLUGIN_ID_PATTERN.test(id) || typeof enabled !== "boolean") throw new PluginHostError(400, "插件启用请求无效");
				const pkg = get(id);
				const state = readState(stateFile); // Recheck before overwriting externally changed state.
				state.enabled[id] = enabled; writeState(stateFile, state);
				if (enabled && pkg.activation?.ready) return;
				pkg.info.enabled = enabled;
				if (!enabled) {
					delete pkg.contributionWarning;
					const failures = await deactivate(pkg);
					pkg.info.status = failures.length || pkg.blocked ? "error" : "disabled";
					pkg.info.error = failures.length ? `Cleanup: ${failures.join("; ")}` : pkg.restart ?? (pkg.blocked ? pkg.info.error : undefined);
				} else {
					// Discover edits BEFORE first native evaluation or reactivation.
					await discover(state);
					await activate(pkg);
				}
				change();
			});
		},
		refresh: () => enqueue(async () => { assertOpen(); await initializeInternal(); await discover(readState(stateFile)); change(); }),
		async call(id: string, operation: string, input?: unknown): Promise<unknown> {
			assertOpen();
			const pkg = get(id), activation = pkg.activation;
			if (!pkg.info.enabled || !activation?.ready || !live(pkg, activation)) throw new PluginHostError(409, "插件已被禁用或不可用");
			if (!operationId.test(operation)) throw new PluginHostError(400, "插件操作 id 无效");
			const handler = activation.handlers.get(operation);
			if (!handler) throw new PluginHostError(404, `Unknown plugin operation: ${operation}`);
			return handler(input);
		},
		async convertDocument(id: string, request: Request): ReturnType<PluginFrontendContext["documents"]["toMarkdown"]> {
			assertOpen();
			const pkg = get(id), activation = pkg.activation;
			if (!pkg.info.enabled || !activation?.ready || !live(pkg, activation)) throw new PluginHostError(409, "插件已被禁用或不可用");
			const requireCurrent = () => {
				assertOpen();
				if (!pkg.info.enabled || !activation.ready || !live(pkg, activation)) throw new PluginHostError(409, "插件已被禁用或不可用");
				if (request.signal.aborted) throw new PluginHostError(409, "文档转换已取消");
			};
			requireCurrent();
			if (!deps.convertDocument) throw new PluginHostError(503, "文档转换不可用");
			const signal = AbortSignal.any([activation.controller.signal, request.signal]);
			try {
				const result = await deps.convertDocument(request, signal);
				requireCurrent();
				return result;
			} catch (error) { requireCurrent(); throw error; }
		},
		asset(id: string, segments: string[]): { bytes: Uint8Array; contentType: string } {
			assertOpen();
			const pkg = get(id), manifest = pkg.info.manifest;
			if (!pkg.info.enabled || pkg.info.status !== "active" || !manifest || pkg.blocked) throw new PluginHostError(409, "插件资源已被禁用或不可用");
			if (!segments.length || !segments.every(safeSegment)) throw new PluginHostError(400, "插件资源路径无效");
			const file = segments.join("/");
			if (!(segments.length === 1 && (file === manifest.main || file === manifest.styles)) && !(segments.length > 1 && segments[0] === "assets")) throw new PluginHostError(404, "插件资源不在允许列表中");
			if (segments.some(s => s === "data") || file === manifest.backend) throw new PluginHostError(404, "私有插件文件");
			try {
				if (pkg.info.origin === "core") pluginRoot(core!.directory);
				pluginRoot(pkg.rootDirectory); regularFile(pkg.directory, file);
			} catch { throw new PluginHostError(404, "未知或不安全的插件资源"); }
			const bytes = pkg.files.get(file);
			if (!bytes) throw new PluginHostError(404, "未知插件资源");
			return { bytes: Uint8Array.from(bytes), contentType: mimeTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
		},
		dispose(): Promise<void> {
			if (disposing) return disposing;
			disposed = true; // Immediately fence callers, including queued work.
			for (const pkg of packages.values()) pkg.activation?.controller.abort();
			disposing = enqueue(async () => {
				for (const pkg of packages.values()) { await deactivate(pkg); pkg.info.status = "disabled"; }
			});
			return disposing;
		},
	};
}
