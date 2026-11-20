// Ported from @earendil-works/pi-coding-agent 1.1.0, dist/utils/image-resize-worker.js (MIT).
import { parentPort } from "node:worker_threads";
import { IMAGE_RESIZE_WORKER_RESPONSE_TYPE, resizeImageInProcess, } from "./resize-core.mjs";
function isResizeImageWorkerRequest(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string";
}
const port = parentPort;
if (!port) {
    throw new Error("图片缩放工作线程需要 parentPort");
}
port.once("message", (message) => {
    void (async () => {
        try {
            if (!isResizeImageWorkerRequest(message)) {
                throw new Error("图片缩放工作线程请求无效");
            }
            const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
            const response = { type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE, result };
            port.postMessage(response);
        }
        catch (error) {
            const response = {
                type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
                error: error instanceof Error ? error.message : String(error),
            };
            port.postMessage(response);
        }
    })();
});
