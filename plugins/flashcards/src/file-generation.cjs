'use strict';
const { createHash } = require('node:crypto');

const { fileInstructions: instructions, filePromptFor: promptFor } = require('./generation-prompts.cjs');
const textSchema = { type: 'string', minLength: 1, pattern: '\\S' };
const resultSchema = {
  type: 'object', additionalProperties: false, required: ['facts'], properties: {
    facts: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'statement', 'cards'], properties: {
        name: textSchema, statement: textSchema,
        cards: { type: 'array', minItems: 1, items: {
          type: 'object', additionalProperties: false, required: ['question', 'answer'],
          properties: { question: textSchema, answer: textSchema },
        } },
      },
    } },
  },
};
const fail = message => { throw new Error(message); };
function nonblank(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must not be blank.`);
}
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${label} has unsupported fields.`);
  if (keys.some(key => !Object.hasOwn(value, key))) fail(`${label} is missing required fields.`);
}
function validateResult(result) {
  object(result, ['facts'], '结果');
  if (!Array.isArray(result.facts)) fail('返回 facts 数组。');
  const statements = new Set(), questions = new Set();
  for (const fact of result.facts) {
    object(fact, ['name', 'statement', 'cards'], '事实');
    nonblank(fact.name, '事实名称'); nonblank(fact.statement, '事实陈述');
    const statement = fact.statement.trim();
    if (statements.has(statement)) fail('重复的事实陈述；每个不同事实只返回一次。');
    statements.add(statement);
    if (!Array.isArray(fact.cards) || !fact.cards.length) fail('每个事实至少需要一张卡片。');
    for (const card of fact.cards) {
      object(card, ['question', 'answer'], '卡片');
      nonblank(card.question, '问题'); nonblank(card.answer, '作答');
      const question = card.question.trim();
      if (questions.has(question)) fail('重复的问题；请提出一个不同的有用线索。');
      questions.add(question);
    }
  }
}
const high = code => code >= 0xd800 && code <= 0xdbff;
const low = code => code >= 0xdc00 && code <= 0xdfff;
function validUnicode(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (high(code)) { if (!low(text.charCodeAt(++index))) return false; }
    else if (low(code)) return false;
  }
  return true;
}
function validateFileInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('文件输入必须是对象。');
  const { name, markdown } = input;
  nonblank(name, '文件名');
  if (/\p{Cc}/u.test(name)) fail('文件名不能包含控制字符。');
  if (typeof markdown !== 'string' || !markdown.trim()) fail('源 Markdown 不能为空。');
  if (!validUnicode(markdown)) fail('源 Markdown 必须包含有效 Unicode，且不含未配对代理项。');
  if (Buffer.byteLength(markdown, 'utf8') > 2 * 1024 * 1024) fail('源 Markdown 超过 2 MiB UTF-8 限制。');
  const fingerprint = createHash('sha256').update(JSON.stringify([name, markdown]), 'utf8').digest('hex');
  return { name, markdown, fingerprint };
}
const estimate = prompt => Math.ceil(Buffer.byteLength(instructions + JSON.stringify(resultSchema) + prompt, 'utf8') / 3) + 256;
function prepareFileChunks(options) {
  const { name, markdown } = validateFileInput(options);
  const { chunkBudget, entry, ranges } = options;
  if (!Number.isSafeInteger(chunkBudget) || chunkBudget < 1) fail('输入预算必须是可安全表示的正整数。');
  if (!entry || typeof entry !== 'object') fail('需要提供模型目录条目。');
  const outputLimit = entry.maxTokens ?? 8192, contextLimit = entry.contextWindow ?? Infinity;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1024 || (contextLimit !== Infinity && (!Number.isSafeInteger(contextLimit) || contextLimit < 1))) fail('所选模型无法容纳此上下文和至少 1024 token 的输出额度。');
  const boundary = offset => !(offset > 0 && offset < markdown.length && high(markdown.charCodeAt(offset - 1)) && low(markdown.charCodeAt(offset)));
  if (ranges !== undefined && !Array.isArray(ranges)) fail('源区间必须是数组。');
  const spans = ranges === undefined ? [{ start: 0, end: markdown.length }] : ranges.map(range => {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > markdown.length || !boundary(range.start) || !boundary(range.end)) fail('每个源区间必须包含位于 Unicode 码点边界的有效非空 UTF-16 偏移。');
    return { start: range.start, end: range.end };
  });
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  if (ordered.some((span, index) => index && span.start < ordered[index - 1].end)) fail('源区间不能重叠。');
  const plan = (start, end) => {
    const input = { name, markdown: markdown.slice(start, end) }, prompt = promptFor(input);
    const tokens = estimate(prompt);
    const maxTokens = Math.min(8192, outputLimit, contextLimit - tokens - 256);
    return { start, end, input, prompt, tokens, maxTokens };
  };
  // Match core extraction's source-only chars/4 budget. Filename, JSON
  // escaping, instructions and schema remain in the full-request estimate.
  const characterAllowance = chunkBudget * 4;
  const chunks = [];
  for (const span of spans) {
    let start = span.start;
    while (start < span.end) {
      let end = Math.min(span.end, start + characterAllowance);
      if (!boundary(end)) end--;
      if (end < span.end) {
        const prefix = markdown.slice(start, end);
        let paragraphEnd = -1;
        for (const match of prefix.matchAll(/\r?\n[ \t]*\r?\n/g)) paragraphEnd = match.index + match[0].length;
        const newlineEnd = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r')) + 1;
        const preferred = paragraphEnd > 0 ? paragraphEnd : newlineEnd;
        if (preferred > 0) end = start + preferred;
      }
      const chunk = plan(start, end);
      if (chunk.maxTokens < 1024) fail('所选模型无法容纳此上下文和输出额度。请减小分块预算或选择其他模型。');
      chunks.push(chunk); start = end;
    }
  }
  return chunks;
}

module.exports = { instructions, resultSchema, validateResult, validateFileInput, prepareFileChunks };
