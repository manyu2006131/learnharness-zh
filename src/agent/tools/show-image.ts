import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { loadLearnerImage } from "./learner-image.ts";
import type { ShowImageDetails } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";

/**
 * show_image (issue #363): put one of the learner's image files into the
 * lesson as-is — the instant, model-free twin of `visual` with an image.
 * Teacher only, always on like the learner-filesystem set.
 *
 * The picture lands in the record only (`details` → the tool part's
 * output → ImageCard). The teacher's result is ONE text line (owner
 * decision): the image is never re-sent on later turns; read is how the
 * teacher looks at it.
 */

const showImageInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the learner's image file (relative or absolute)" }),
	caption: Type.Optional(Type.String({ description: "图片下方显示的一行短说明" })),
});

export function createShowImageTool(ctx: { chatId: string; chatStore: Pick<ChatStore, "saveImageSnapshot"> }): AgentTool<typeof showImageInput> {
	return {
		name: "show_image",
		label: "show_image",
		description:
			"在课程中原样展示学习者的一个图片文件（jpg、png、gif、webp、bmp），可附说明文字。" +
			"立即返回。结果仅确认已展示的内容——图片不会回传给你；请用 read 查看。" +
			"要在图片上画标注，请改用以该路径调用 visual。视觉结果会自动展示：不要重复刚交付的结果。" +
			"仅当重新展示图片能实质帮助当前讲解时才再次展示。本地路径受文件访问设置约束；可用 ls 查看允许的文件夹。",
		parameters: showImageInput,
		execute: serverExecute("show_image", showImageInput, async ({ path, caption }, { signal }): Promise<ImageFileResult> => {
			const image = await loadLearnerImage(path, signal);
			ctx.chatStore.saveImageSnapshot(ctx.chatId, image.snapshotId, image);
			const trimmed = caption?.trim();
			const details: ShowImageDetails = {
				path: image.path,
				...(trimmed ? { caption: trimmed } : {}),
				mimeType: image.mimeType,
				snapshotId: image.snapshotId,
				width: image.width,
				height: image.height,
			};
			return { text: `Shown to the learner: ${image.path} (${image.width}×${image.height}).`, details };
		}),
	};
}
