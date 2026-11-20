import { readBoundedFormData, FormBodyLimitError } from "../../lib/bounded-form-data.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { PluginHostError } from "./plugin-host.ts";

export const MAX_DOCUMENT_BODY_BYTES = 26 * 1024 * 1024;
export const MAX_DOCUMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

/** Pure upload conversion only: no learning, provider, or storage services.
 * Compose ONE instance process-wide. The fail-fast slot covers body reading,
 * conversion, and converter teardown, even after the caller has aborted. */
export function createPluginDocumentConverter(deps: { convertPdf?: typeof convertPdf } = {}) {
	const pdfConverter = deps.convertPdf ?? convertPdf;
	let busy = false;
	return {
		async convert(request: Request, signal: AbortSignal): Promise<{ name: string; markdown: string; notices: string[] }> {
			if (busy) throw new PluginHostError(409, "文档转换正忙，请重试。");
			busy = true;
			try {
				signal.throwIfAborted();
				let form: FormData;
				try {
					form = await readBoundedFormData(request, MAX_DOCUMENT_BODY_BYTES, signal);
				} catch (error) {
					signal.throwIfAborted();
					if (error instanceof FormBodyLimitError) throw new PluginHostError(413, "文档上传过大。含 multipart 元数据上限 26 MiB。");
					throw new PluginHostError(400, "无法读取上传内容。文件可能不完整，请重新选择。");
				}
				signal.throwIfAborted();
				const entries = [...form.entries()];
				const entry = entries[0];
				if (entries.length !== 1 || !entry || entry[0] !== "file" || !(entry[1] instanceof File)) {
					throw new PluginHostError(400, "请在 file 字段中恰好上传一个文件。");
				}
				const file = entry[1];
				if (file.size > MAX_DOCUMENT_FILE_BYTES) throw new PluginHostError(413, "过大。上限 25 MiB。");
				const bytes = new Uint8Array(await file.arrayBuffer());
				signal.throwIfAborted();
				let markdown: string;
				const notices: string[] = [];
				if (PDF_MAGIC.every((byte, i) => bytes[i] === byte) || /\.pdf$/i.test(file.name)) {
					// Await the actual converter, never an abort race: its promise includes
					// loading-task destruction, which must settle before releasing busy.
					let pdf;
					try { pdf = await pdfConverter(bytes, MAX_DOCUMENT_PDF_PAGES, { signal }); }
					catch {
						signal.throwIfAborted();
						throw new PluginHostError(400, "无法打开此 PDF。");
					}
					signal.throwIfAborted();
					if (pdf.kind === "unreadable") throw new PluginHostError(400, "无法打开此 PDF。");
					if (pdf.kind === "too-long") throw new PluginHostError(400, "过长。最多 1,000 页。");
					const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
					if (!pdf.pages.some((page) => page.kind === "text" && page.markdown.trim())) {
						throw new PluginHostError(400, skipped ? "不支持 OCR。此 PDF 没有可提取的文本。" : "此 PDF 为空白或不含可提取文本。");
					}
					markdown = joinPages(pdf.pages);
					notices.push("PDF 文本提取可能有误；请对照原文核对结果。");
					if (skipped) notices.push(`Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.`);
				} else {
					try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
					catch { throw new PluginHostError(400, "此文档不是有效的 UTF-8 文本。"); }
					if (CONTROL.test(markdown)) throw new PluginHostError(400, "此文档包含二进制或控制字符，不是受支持的文本。");
					if (!markdown.trim()) throw new PluginHostError(400, "此文档不含文本。");
				}
				signal.throwIfAborted();
				if (new TextEncoder().encode(markdown).byteLength > MAX_DOCUMENT_MARKDOWN_BYTES) {
					throw new PluginHostError(413, "转换后的 Markdown 过大。上限 2 MiB。");
				}
				return { name: file.name, markdown, notices };
			} finally { busy = false; }
		},
	};
}
