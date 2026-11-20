import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { pdfExtract, pdfInfo, pdfProbe, pdfSearch } from "../subagents/pdf-ops.ts";
import { safeFetch } from "./safe-fetch.ts";

/**
 * PDF reading tools for the RESEARCHER sub-agent (owner design B,
 * 2026-10-07): PDFs from the web, with the pdf-reader agent's TEXT
 * capabilities — triage (pdf_info), page-level extraction (pdf_extract),
 * targeted lookup (pdf_search) — woven into the researcher's own loop so
 * page-cited content lands in the brief directly.
 *
 * web_fetch_pdf acquires the file (download, size-capped, probe-validated)
 * into a per-job temp dir; every path-taking tool is SCOPED to that dir
 * (the researcher can never read outside it). pdf_render is deliberately
 * absent: the researcher's model slot has no vision — visual reading of
 * math-heavy pages stays the pdf job's job.
 *
 * Tool contract (the web.ts law): NEVER throw into the agent loop — every
 * failure path returns a clear error STRING the researcher can adapt to.
 */

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 60_000;
/** PDFs run bigger than pages — arxiv papers routinely 5-20 MB. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** The pdf-reader doctrine's size classes, by page count. */
function sizeClass(pageCount: number): "short" | "medium" | "long" {
	if (pageCount <= 10) return "short";
	if (pageCount <= 40) return "medium";
	return "long";
}

/** Pages worth a look before any extraction — math- or image-heavy. */
function flaggedPages(info: Awaited<ReturnType<typeof pdfInfo>>): number[] {
	return info.pages
		.filter((p) => p.math_density >= 0.03 || p.image_count > 0)
		.slice(0, 30)
		.map((p) => p.page);
}

/** Resolve a tool-supplied path and require it to live INSIDE the job's
 *  pdf dir — the researcher's filesystem ends at the temp dir's wall. */
function scopedPath(dir: string, filePath: string): string | null {
	const root = path.resolve(dir) + path.sep;
	const resolved = path.resolve(dir, filePath);
	if (!resolved.startsWith(root)) return null;
	return resolved;
}

/** Filename for a downloaded PDF — slug from the URL's last segment plus a
 *  unique suffix (two PDFs from different URLs never collide). */
function pdfFileName(url: string): string {
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "document";
		const slug = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "document";
		const stem = slug.replace(/\.pdf$/i, "");
		return `${stem}-${Math.random().toString(36).slice(2, 8)}.pdf`;
	} catch {
		return `document-${Math.random().toString(36).slice(2, 8)}.pdf`;
	}
}

/** The download + triage summary the researcher sees from web_fetch_pdf. */
export interface PdfFetchSummary {
	path: string;
	url: string;
	page_count: number;
	size_class: "short" | "medium" | "long";
	mean_text_length: number;
	flagged_pages: number[];
}

export function createPdfReadTools(dir: string): Record<string, AgentTool<any>> {
	const pdfFetchInput = Type.Object({
		url: Type.String({ description: "要下载的 PDF URL" }),
	});
	const pdfPathInput = Type.Object({
		path: Type.String({ description: "web_fetch_pdf 返回的本地 PDF 路径" }),
	});
	const pdfExtractInput = Type.Object({
		path: Type.String({ description: "web_fetch_pdf 返回的本地 PDF 路径" }),
		pages: Type.String({
			description: "要提取的页面：'all'、'1-5'、'1,3,7' 或 '3'。大文档请先用 pdf_info 并缩小范围。",
		}),
	});
	const pdfSearchInput = Type.Object({
		path: Type.String({ description: "web_fetch_pdf 返回的本地 PDF 路径" }),
		query: Type.String({ description: "要查找的文本（不区分大小写的子串）" }),
	});

	return {
		web_fetch_pdf: {
			name: "web_fetch_pdf",
			label: "web_fetch_pdf",
			description:
				"从网络下载 PDF 并分诊：返回本地路径、页数、大小级别" +
				"(short ≤10 pages, medium ≤40, long), and flagged (math/image-heavy) pages. " +
				"然后用 pdf_extract / pdf_search 读取。当 web_fetch 报告某 URL 是 PDF 时使用。",
			parameters: pdfFetchInput,
			execute: serverExecute("web_fetch_pdf", pdfFetchInput, async ({ url }): Promise<PdfFetchSummary | string> => {
				try {
					const parsed = new URL(url);
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
						throw new Error("Only http(s) URLs are supported");
				} catch {
					return `web_fetch_pdf failed: invalid URL "${url}"`;
				}
				try {
					const resp = await safeFetch(url, {
						headers: {
							"User-Agent": USER_AGENT,
							Accept: "application/pdf,application/octet-stream,*/*",
						},
						signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
					});
					if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
					const contentType = resp.headers.get("content-type") ?? "";
					if (!/application\/pdf/i.test(contentType) && !/\.pdf(\?|$)/i.test(parsedPathname(url))) {
						throw new Error(`Not a PDF (content-type ${contentType.split(";")[0] || "unknown"})`);
					}
					const declared = Number(resp.headers.get("content-length") ?? 0);
					if (declared > MAX_PDF_BYTES) throw new Error("PDF 过大（超过 25 MB）");
					const bytes = new Uint8Array(await resp.arrayBuffer());
					if (bytes.length === 0) throw new Error("空响应");
					if (bytes.length > MAX_PDF_BYTES) throw new Error("PDF 过大（超过 25 MB）");
					const filePath = path.join(dir, pdfFileName(url));
					await fs.writeFile(filePath, bytes);
					try {
						await pdfProbe(filePath);
					} catch {
						await fs.rm(filePath, { force: true });
						throw new Error("下载内容不是可读的 PDF");
					}
					const info = await pdfInfo(filePath);
					const summary: PdfFetchSummary = {
						path: filePath,
						url,
						page_count: info.page_count,
						size_class: sizeClass(info.page_count),
						mean_text_length: info.mean_text_length,
						flagged_pages: flaggedPages(info),
					};
					return summary;
				} catch (err) {
					return `web_fetch_pdf failed for ${url}: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},

		pdf_info: {
			name: "pdf_info",
			label: "pdf_info",
			description:
				"对已下载 PDF 分诊：页数及逐页信号（text_length、image_count、math_density）。",
			parameters: pdfPathInput,
			execute: serverExecute("pdf_info", pdfPathInput, async ({ path: filePath }) => {
				const scoped = scopedPath(dir, filePath);
				if (!scoped) return `pdf_info failed: path must stay inside this job's download dir`;
				try {
					const info = await pdfInfo(scoped);
					return {
						page_count: info.page_count,
						mean_text_length: info.mean_text_length,
						size_class: sizeClass(info.page_count),
						pages: info.pages,
					};
				} catch (err) {
					return `pdf_info failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},

		pdf_extract: {
			name: "pdf_extract",
			label: "pdf_extract",
			description:
				"从已下载 PDF 的页面提取文本（范围：'all'、'1-5'、'1,3,7'、'3'）。" +
				"请先用 pdf_info；大文档请缩小范围。",
			parameters: pdfExtractInput,
			execute: serverExecute("pdf_extract", pdfExtractInput, async ({ path: filePath, pages }) => {
				const scoped = scopedPath(dir, filePath);
				if (!scoped) return `pdf_extract failed: path must stay inside this job's download dir`;
				try {
					return await pdfExtract(scoped, pages);
				} catch (err) {
					return `pdf_extract failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},

		pdf_search: {
			name: "pdf_search",
			label: "pdf_search",
			description: "在已下载 PDF 中查找文本——返回命中的页面与上下文。",
			parameters: pdfSearchInput,
			execute: serverExecute("pdf_search", pdfSearchInput, async ({ path: filePath, query }) => {
				const scoped = scopedPath(dir, filePath);
				if (!scoped) return `pdf_search failed: path must stay inside this job's download dir`;
				try {
					const { hits } = await pdfSearch(scoped, query, { literal: true });
					return { hits };
				} catch (err) {
					return `pdf_search failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},
	};
}

function parsedPathname(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}
