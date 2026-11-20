import { DOMParser } from "linkedom";
import { embedLearnerImage, LEARNER_IMAGE_HREF } from "../../core/learner-image-svg.ts";

/** Structural annotation protocol, not a claim to prove visibility or mark accuracy.
 * Annotation rendering keeps strict native input, without ordinary figure repairs.
 */
export function annotationPlacementProblem(svg: string, width: number, height: number): string | null {
	if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return "标注 SVG 不能声明实体或文档类型";
	if (/<\?/.test(svg)) return "标注 SVG 不能包含处理指令";
	const doc = new DOMParser().parseFromString(svg, "image/svg+xml") as unknown as Document;
	if (doc.documentElement?.localName !== "svg") return "需要一个完整的 SVG 文档";
	const elements = Array.from(doc.querySelectorAll("*"));
	const images = elements.filter((element) => element.localName === "image");
	if (images.length !== 1) return `SVG 必须恰好用一次 <image href="${LEARNER_IMAGE_HREF}" …/> 放置学习者的图片（当前 ${images.length} 个）`;
	const image = images[0]!;
	const hrefs = Array.from(image.attributes).filter((attr) => attr.name === "href" || attr.name === "xlink:href");
	if (hrefs.length !== 1 || hrefs[0]!.value !== LEARNER_IMAGE_HREF) return `图片必须恰好使用一个 href="${LEARNER_IMAGE_HREF}"`;
	if (embedLearnerImage(svg, { mimeType: "image/png", data: "", width, height }) === svg) return "图片的 href 请使用字面量 learner-image 占位符";
	if (Number(image.getAttribute("width")) !== width || Number(image.getAttribute("height")) !== height) return `请按图片的原始 ${width}×${height} 像素尺寸放置`;
	for (const element of elements) {
		// LinkeDOM preserves qualified names in localName. Keep the protocol's
		// ordinary SVG spelling instead of trusting namespace identity resolution.
		if (element.localName.includes(":")) return "标注 SVG 元素不能使用命名空间前缀";
		if (["script", "foreignobject", "style", "animate", "animatemotion", "animatetransform", "set", "discard"].includes(element.localName.toLowerCase())) return "标注 SVG 必须使用静态 SVG 标记和内联样式";
		for (const attr of Array.from(element.attributes)) {
			if (attr.name === "xmlns" && attr.value !== "http://www.w3.org/2000/svg") return "标注 SVG 必须使用 SVG 命名空间";
			if (attr.name.startsWith("xmlns:") && (attr.name !== "xmlns:xlink" || attr.value !== "http://www.w3.org/1999/xlink")) return "标注 SVG 不能声明命名空间别名";
			if (attr.name.includes(":") && !["xmlns:xlink", "xlink:href", "xml:lang", "xml:space"].includes(attr.name)) return "标注 SVG 不能使用带前缀的属性别名";
			if (attr.name === "xlink:href") {
				let owner: Element | null = element;
				while (owner && !owner.hasAttribute("xmlns:xlink")) owner = owner.parentElement;
				if (owner?.getAttribute("xmlns:xlink") !== "http://www.w3.org/1999/xlink") return "xlink:href 需要标准的 XLink 命名空间声明";
			}
			if (/^on/i.test(attr.name)) return "标注 SVG 不能包含事件处理器";
			if (attr.name === "xml:base" || /\\|@import/i.test(attr.value)) return "标注 SVG 不能更改资源基址或使用转义的资源语法";
			if ((attr.name === "href" || attr.name === "xlink:href") && element !== image && !/^#[A-Za-z_][\w:.-]*$/.test(attr.value)) return "标注 SVG 不能引用其他文件或 URL";
			if (/url\s*\(/i.test(attr.value) && !/^url\(\s*['"]?#[A-Za-z_][\w:.-]*['"]?\s*\)$/.test(attr.value)) return "标注 SVG 的资源必须是本地片段引用";
		}
	}
	return null;
}
