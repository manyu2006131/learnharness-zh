import type { ImageContent } from "@earendil-works/pi-ai";
import type { PiEngine } from "../agent/models.ts";
import { detectSupportedImageMimeType, processImage } from "../agent/image-processing/index.ts";
import { validatePluginSubmissionImageArray, validatePluginSubmissionImages, type PluginSubmissionImages } from "../core/plugin-submissions.ts";
import { ChatInputError } from "../core/input-events.ts";
import { preparePluginProblemSubmissionImages, type PluginProblemSubmissionImages } from "../core/plugin-submissions.ts";

type ImageEngine = Pick<PiEngine, "model">;

/** Only admission policy, not a second provider/model resolver. The caller
 * supplies the actual engine it will dispatch (or the captured live model). */
export function submissionImagePolicyKey(engine: ImageEngine): string {
	const resize = engine.model.inputLimits?.images?.resize;
	return JSON.stringify([engine.model.provider, engine.model.id, engine.model.input.includes("image"),
		resize?.maxWidth, resize?.maxHeight, resize?.maxBytes, resize?.jpegQuality]);
}

/** Strict native blocks only. The decoder below verifies the entire image;
 * signature sniffing also prevents a false MIME declaration reaching it. */
export async function prepareSubmissionImages(
	images: readonly Readonly<ImageContent>[] | undefined,
	engine: ImageEngine,
): Promise<ImageContent[] | undefined> {
	if (images === undefined) return undefined;
	try { images = validatePluginSubmissionImageArray(images); }
	catch (error) { throw new ChatInputError(error instanceof Error ? error.message : "提交的图片无效"); }
	if (images.length === 0) return undefined;
	if (!engine.model.input.includes("image")) throw new ChatInputError("所选模型不支持图片。你的输入已保留。");
	// Capture bytes and policy before the first await; caller-owned mutations
	// must not alter an in-flight submission or its later image channels.
	const resizeOptions = { ...engine.model.inputLimits?.images?.resize };
	const captured = images.map(image => {
		const bytes = Buffer.from(image.data, "base64");
		// The existing file-tool sniffer intentionally excludes animated PNG.
		// Submission PNGs may still be decoded by the real processor; do not
		// silently narrow the approved PNG format family to static files.
		const detected = detectSupportedImageMimeType(bytes) ?? (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : null);
		if (!bytes.length || bytes.toString("base64") !== image.data || detected !== image.mimeType)
			throw new ChatInputError("提交的图片字节与声明的格式不符");
		return { bytes, mimeType: image.mimeType };
	});
	const prepared: ImageContent[] = [];
	for (const image of captured) {
		try {
			const result = await processImage(image.bytes, image.mimeType, { resizeOptions });
			if (!result.ok) throw new Error("图片处理失败");
			// Processor hints are not learner text; only normalized image bytes
			// become accepted native content. Never substitute an omission marker.
			prepared.push({ type: "image", data: result.data, mimeType: result.mimeType });
		} catch {
			throw new ChatInputError("无法处理提交的图片。你的输入已保留。");
		}
	}
	return prepared;
}

export async function prepareProblemSubmissionImageChannels(images: PluginProblemSubmissionImages | undefined, engine: ImageEngine): Promise<PluginProblemSubmissionImages | undefined> {
	if (images === undefined) return undefined;
	try { images = preparePluginProblemSubmissionImages(images); }
	catch { throw new ChatInputError("题目提交图片无效"); }
	const [submission, thinking] = await Promise.all([prepareSubmissionImages(images.submission, engine), prepareSubmissionImages(images.thinking, engine)]);
	return submission || thinking ? { ...(submission ? { submission } : {}), ...(thinking ? { thinking } : {}) } : undefined;
}

export async function prepareSubmissionImageChannels(
	images: PluginSubmissionImages | undefined,
	engine: ImageEngine,
): Promise<PluginSubmissionImages | undefined> {
	if (images === undefined) return undefined;
	try { images = validatePluginSubmissionImages(images); }
	catch (error) { throw new ChatInputError(error instanceof Error ? error.message : "已提交图片的通道无效"); }
	// Start all preparations synchronously so every channel is captured before
	// processing yields; even direct server callers cannot mutate later ones.
	const [answer, thinking, readingThinking] = await Promise.all([
		prepareSubmissionImages(images.answer, engine),
		prepareSubmissionImages(images.thinking, engine),
		prepareSubmissionImages(images.readingThinking, engine),
	]);
	if (!answer && !thinking && !readingThinking) return undefined;
	return { ...(answer ? { answer } : {}), ...(thinking ? { thinking } : {}), ...(readingThinking ? { readingThinking } : {}) };
}
