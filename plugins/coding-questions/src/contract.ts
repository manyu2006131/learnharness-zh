import type { PluginProblemTypeDefinition, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import type { CodingTests } from "./test-result.ts";

export const QUESTION_TYPE_ID = "code";
export const PROBLEM_TYPE_ID = "code";
export type CodingPayload = {
  language: string;
  starterCode?: string;
  tests: CodingTests;
};
export type CodingQuestionPayload = CodingPayload & { modelSolution: string };

const executionInstructions = "On submission the exact learner code is written to answer.txt in a fresh working directory, and tests.code is sent unchanged to the standard input of tests.program with tests.args. Choose arguments that read a program from stdin, such as python3 with ['-'], node with ['-'], or a shell with ['-s']; use the test code to load answer.txt, create any small driver files, compile if needed, and actually check the answer. Exit 0 only when the supplied tests pass; a nonzero exit means tests failed. Runtimes/compilers must already be installed; never install or download runtimes, compilers, or packages, or change machine configuration. Executables are resolved through the application's PATH or an explicit path. The run has a 30-second limit and captures at most 64 KiB each of stdout and stderr. Temporary files are removed afterward. Any language is permitted; highlighting depends on the bundled catalog. After submission, review the learner's exact code, separate thinking, and recorded test outcome. Tests passed/failed are observations, not proof of correctness.";

export const instructions = "When a teaching prediction or understanding check calls for writing or editing code, you may use coding_question. Specify the language, optionally supply starter code, and always supply tests:{program,args,code} and modelSolution. Write modelSolution as Markdown with the model code in a fenced code block and an optional explanation; author it with the question, not after seeing the learner's answer. It is preserved with the question and revealed only in the answered transcript, not executed or automatically checked. " + executionInstructions;

export const practiceInstructions = "When a practice problem calls for writing or editing code, use coding_problem. Supply the host's statement, mode, optional target, and committed modelSolution, plus payload:{language,starterCode?,tests:{program,args,code}}. Write modelSolution as Markdown with fenced solution code and an optional explanation; commit it when posing, not after seeing learner submissions. Never execute the model solution. " + executionInstructions + " A practice problem accepts repeated submissions. Test results are per-submission observations, not the final assessment and not an automatic conclusion. Review the code, separate thinking and test observations, and allow revisions. Only the existing conclude tool records your final assessment and closes the problem; the host then reveals the original committed modelSolution. Do not reveal it before conclusion.";

export const definition = {
  id: QUESTION_TYPE_ID,
  label: "编程题",
  contractVersion: 1,
  showThinking: true,
  questionSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        pattern: "\\S",
        description: "语言名称或别名，如 python、javascript、typescript、c、cpp 或 sql。允许任意语言；未知语言使用纯文本编辑器。",
      },
      starterCode: {
        type: "string",
        description: "可供学习者编辑的可选代码。留空则从头编写代码作答。",
      },
      modelSolution: {
        type: "string",
        pattern: "\\S",
        description: "必填的参考答案，与题目一同编写。Markdown 格式，包含围栏代码形式的解答代码和可选讲解。会被保留，仅在提交后展示；不执行，也不自动测试。",
      },
      tests: {
        type: "object",
        description: "必需的测试进程配方。有效提交后自动运行，使用已安装的用户工具；不会安装或捆绑任何内容。",
        properties: {
          program: { type: "string", pattern: "\\S", description: "应用 PATH 中已安装的可执行文件名，或显式的可执行文件路径。不经过隐式 shell。" },
          args: { type: "array", items: { type: "string" }, description: "字面参数向量；请包含程序从标准输入读取的选项。运行器不进行 shell 展开。" },
          code: { type: "string", pattern: "\\S", description: "Complete test/driver code supplied to the program's stdin. Read the learner submission from answer.txt in the working directory. Exit 0 for tests passed; nonzero for tests failed. Handle any compilation in this code. No runtime/package installs or downloads." },
        },
        required: ["program", "args", "code"],
        additionalProperties: false,
      },
    },
    required: ["language", "tests", "modelSolution"],
    additionalProperties: false,
  },
  answerSchema: { type: "string", pattern: "\\S" },
  teach: {
    toolName: "coding_question",
    description: "Ask the learner to write or edit code. Supply a language, optional starter code, required tests:{program,args,code}, and a required Markdown modelSolution containing fenced solution code and an optional explanation. On submission the tests run against answer.txt using installed user tools, then you receive the full code, separate thinking, and test outcome. Tests passed/failed do not mean correct/incorrect.",
  },
} satisfies PluginQuestionTypeDefinition;

export const problemDefinition = {
  id: PROBLEM_TYPE_ID,
  label: "编程题",
  contractVersion: 1,
  tool: {
    toolName: "coding_problem",
    description: "Pose a coding practice problem with required tests:{program,args,code}, a language, and optional starter code in payload. Commit the Markdown modelSolution in the host's common field. Each submission runs tests against answer.txt and returns observations, not a final assessment. Allow revisions and use the existing conclude tool to assess and close the problem.",
  },
  problemSchema: {
    type: "object",
    properties: {
      language: definition.questionSchema.properties.language,
      starterCode: definition.questionSchema.properties.starterCode,
      tests: definition.questionSchema.properties.tests,
    },
    required: ["language", "tests"],
    additionalProperties: false,
  },
  submissionSchema: definition.answerSchema,
} satisfies PluginProblemTypeDefinition;

/** Narrow the public plain-schema payload without relying on a TypeBox-only static brand. */
export function readTests(payload: unknown): CodingTests {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("编程题载荷不可用。");
  const tests = (payload as Record<string, unknown>).tests;
  if (tests === null || typeof tests !== "object" || Array.isArray(tests)) throw new Error("编程题测试配方不可用。");
  const recipe = tests as Record<string, unknown>;
  if (typeof recipe.program !== "string" || !/\S/.test(recipe.program) || !Array.isArray(recipe.args) || !recipe.args.every(arg => typeof arg === "string") || typeof recipe.code !== "string" || !/\S/.test(recipe.code)) throw new Error("编程题测试配方无效。");
  return { program: recipe.program, args: recipe.args, code: recipe.code };
}

/** Readiness is not correctness, and must never trim the actual answer. */
export function isReady(code: string): boolean {
  return /\S/.test(code);
}

export function normalizeLineEndings(code: string): string {
  return code.replace(/\r\n?/g, "\n");
}
