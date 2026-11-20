import * as fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { resolveSourcePath } from "./fs-shared.ts";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile, type ResizedImage } from "../image-processing/index.ts";
import { checkImageDimensions, MAX_LEARNER_IMAGE_BYTES } from "./learner-image-dimensions.ts";
import type { ImageSnapshot } from "../../core/contracts.ts";

/** One bounded, upright, metadata-free snapshot; path is provenance, not identity. */
export interface LearnerImage extends ImageSnapshot {
	path: string;
	snapshotId: string;
}

export async function checkLearnerImage(rawPath: string): Promise<string> {
	// Reuse the shared file-access policy, including canonical/symlink checks.
	const absolute = resolveSourcePath(rawPath);
	try {
		const stat = await fs.stat(absolute);
		if (!stat.isFile()) throw new Error("它不是常规文件");
		if (stat.size > MAX_LEARNER_IMAGE_BYTES) throw new Error("图片超过 25 MiB；请提供更小的图片");
		if (!await detectSupportedImageMimeTypeFromFile(absolute)) throw new Error("不是受支持的图片格式（jpg、png、gif、webp 或 bmp）");
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "文件不存在" : error instanceof Error ? error.message : String(error);
		throw new Error(`无法打开图片 ${absolute}：${reason}`);
	}
	return absolute;
}

async function readBounded(absolute: string, signal?: AbortSignal): Promise<Uint8Array> {
	const handle = await fs.open(absolute, "r");
	try {
		if (!(await handle.stat()).isFile()) throw new Error("图片不是常规文件");
		const chunks: Buffer[] = [];
		let length = 0;
		while (true) {
			signal?.throwIfAborted();
			const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_LEARNER_IMAGE_BYTES + 1 - length));
			const { bytesRead } = await handle.read(chunk);
			if (!bytesRead) break;
			length += bytesRead;
			if (length > MAX_LEARNER_IMAGE_BYTES) throw new Error("图片超过 25 MiB；请提供更小的图片");
			chunks.push(chunk.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks, length);
	} finally { await handle.close(); }
}

async function normalize(bytes: Uint8Array, signal?: AbortSignal): Promise<ResizedImage> {
	signal?.throwIfAborted();
	const worker = new Worker(path.join(process.cwd(), "src/agent/image-processing/learner-image-worker.mjs"));
	try {
		return await new Promise((resolve, reject) => {
			const abort = () => reject(signal?.reason ?? new Error("操作已中止"));
			const cleanup = () => signal?.removeEventListener("abort", abort);
			worker.once("message", (message: { result?: ResizedImage; error?: string }) => {
				cleanup();
				if (message.result) resolve(message.result);
				else reject(new Error(message.error ?? "图片规范化失败"));
			});
			worker.once("error", (error) => { cleanup(); reject(error); });
			worker.once("exit", (code) => { cleanup(); reject(new Error(`Image normalization worker exited (${code})`)); });
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			else worker.postMessage({ bytes });
		});
	} finally { await worker.terminate(); }
}

export async function loadLearnerImage(rawPath: string, signal?: AbortSignal): Promise<LearnerImage> {
	signal?.throwIfAborted();
	const absolute = await checkLearnerImage(rawPath);
	const bytes = await readBounded(absolute, signal);
	const mime = detectSupportedImageMimeType(bytes);
	if (!mime) throw new Error(`Not a supported image: ${absolute}`);
	checkImageDimensions(bytes, mime);
	const stored = await normalize(bytes, signal);
	signal?.throwIfAborted();
	if (stored.mimeType !== "image/png" && stored.mimeType !== "image/jpeg") throw new Error("存储的图片格式异常");
	const snapshotId = createHash("sha256").update(Buffer.from(stored.data, "base64")).digest("hex");
	return { path: absolute, snapshotId, mimeType: stored.mimeType, data: stored.data, width: stored.width, height: stored.height };
}
