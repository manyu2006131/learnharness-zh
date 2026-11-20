/** Job/task activity codes are stored raw (records, tests, plugins); the
 *  display layer maps the known engine codes to Chinese and passes any
 *  plugin-provided free text through unchanged. */
const LABELS: Record<string, string> = {
	starting: "启动中",
	queued: "排队中",
	running: "运行中",
	researching: "研究中",
	"building demo": "构建演示中",
	"reading pdf": "阅读 PDF 中",
	"recovering: re-running": "恢复中：重新运行",
	"recovery failed": "恢复失败",
	"delivery failed": "投递失败",
	"result accepted": "已接收结果",
	delivered: "已送达",
	finished: "完成",
	failed: "失败",
	aborted: "已中止",
	succeeded: "已完成",
	extracting: "提取中",
	auditing: "审查中",
	merging: "合并中",
	embedding: "嵌入中",
};

export function activityLabel(activity: string | undefined): string {
	if (!activity) return "";
	return LABELS[activity] ?? activity;
}
