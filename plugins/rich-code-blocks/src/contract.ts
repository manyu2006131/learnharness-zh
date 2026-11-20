export const FAMILIES = ["chemicalStructures", "musicalNotation", "technicalDiagrams"] as const;
export type Family = typeof FAMILIES[number];
export type Language = "smiles" | "abc" | "tikz";
export interface Settings {
  version: 1;
  revision: number;
  chemicalStructures: boolean;
  musicalNotation: boolean;
  technicalDiagrams: boolean;
}
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1, revision: 0, chemicalStructures: false, musicalNotation: false, technicalDiagrams: false,
});
export const LANGUAGES: Record<Family, Language> = {
  chemicalStructures: "smiles", musicalNotation: "abc", technicalDiagrams: "tikz",
};
export const LABELS: Record<Family, string> = {
  chemicalStructures: "化学结构", musicalNotation: "乐谱", technicalDiagrams: "技术图表",
};
export const INSTRUCTIONS: Record<Family, string> = {
  chemicalStructures: "化学结构请使用 smiles 围栏代码块，其中包含一个 SMILES 分子。解释写在块外；不要手写原始 SVG。",
  musicalNotation: "乐谱请使用 abc 围栏代码块，其中包含一段完整的 ABC 曲谱，并带 X:、M:、L: 和 K: 头信息。它渲染的是静态曲谱而非音频；不要手写原始 SVG。",
  technicalDiagrams: [
    "静态技术图表请使用 tikz 围栏代码块，其中包含一份自包含的 TeX 文档。这类块支持物理/受力图、几何图形、电路原理图（非仿真）、交换图以及解析函数绘图。",
    "每个代码块都会独立编译。请把所有需要的宏包与库声明放在 \\begin{document} 之前，然后是图表内容，最后是 \\end{document}。引擎已提供 standalone 文档类：不要写 \\documentclass 或 \\documentstyle，也不要依赖其他代码块中的声明。",
    "请显式加载图表所需的宏包：\\usepackage{tikz}、\\usepackage{circuitikz}、\\usepackage{tikz-cd} 或 \\usepackage{pgfplots}。若标签中使用 \\text{...} 或对齐公式，还需加载 \\usepackage{amsmath}。所需 TikZ 库请在前导区用 \\usetikzlibrary 声明。",
    "请把 tikzpicture、circuitikz 或 tikzcd 环境直接放在 document 内部。不要把图表包在 \\[...\\]、$$...$$ 或 equation 环境中。TikZ 节点标签中的数学式用 $...$；tikzcd 的单元格已处于数学模式。",
    "内置的 PGFPlots 版本为 1.16。绘图时请在前导区写 \\pgfplotsset{compat=1.16}；不要请求 1.18 或其他更新版本。",
    "解释写在代码块外。请编写记谱内容，而不是原始 SVG、JavaScript 或外部资源。",
  ].join("\n\n"),
};
export const SOURCE_LIMITS: Record<Language, number> = { smiles: 2 * 1024, abc: 16 * 1024, tikz: 32 * 1024 };
export const SVG_LIMIT = 2 * 1024 * 1024;
export const TEX_TIMEOUT_MS = 10_000;
export const TEX_QUEUE_LIMIT = 16;
export const CACHE_ENTRIES = 32;
export const CACHE_BYTES = 8 * 1024 * 1024;

export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("富代码块设置无效。");
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("不支持的富代码块设置版本；已保存文件未更改。");
  if (Object.keys(record).some(key => !["version", "revision", "inkColor", ...FAMILIES].includes(key))) throw new Error("未知的富代码块设置字段。");
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || FAMILIES.some(key => typeof record[key] !== "boolean")) {
    throw new Error("富代码块设置无效。");
  }
  // Legacy v1 inkColor is accepted above but deliberately omitted: theme Text
  // now owns neutral ink. Reads never rewrite disk; normal saves drop the key.
  return { version: 1, revision: record.revision as number, chemicalStructures: record.chemicalStructures as boolean,
    musicalNotation: record.musicalNotation as boolean, technicalDiagrams: record.technicalDiagrams as boolean };
}

export function parseChange(value: unknown): { family: Family; enabled: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要提供 family 和布尔类型的 enabled 值。");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !FAMILIES.includes(record.family as Family) || typeof record.enabled !== "boolean") {
    throw new Error("需要提供已知的 family 和布尔类型的 enabled 值。");
  }
  return { family: record.family as Family, enabled: record.enabled };
}

export function checkSource(language: Language, source: string): void {
  if (new TextEncoder().encode(source).byteLength > SOURCE_LIMITS[language]) throw new Error(`${language} source exceeds the ${SOURCE_LIMITS[language] / 1024} KiB limit.`);
  if (!source.trim()) throw new Error(`Empty ${language} source.`);
}

export function checkSvgSize(svg: string): void {
  if (new TextEncoder().encode(svg).byteLength > SVG_LIMIT) throw new Error("渲染的 SVG 超过 2 MiB 限制。");
}
