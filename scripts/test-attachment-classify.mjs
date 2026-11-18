import assert from "node:assert/strict";
import { classifyAttachment, extOf } from "../src/attachment-classify.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }

check("video 段一定是 video-file", () => assert.equal(classifyAttachment({ segType: "video" }), "video-file"));
check("file 段只有 name 能判出 mp4", () => assert.equal(classifyAttachment({ segType: "file", name: "10月23日.mp4" }), "video-file"));
check("name 缺失、只有 file 是 mp4 也能判（22:42 事故的核心）", () => assert.equal(classifyAttachment({ segType: "file", file: "abc.MP4" }), "video-file"));
check("name 缺失、只有 url 带 mp4 也能判", () => assert.equal(classifyAttachment({ segType: "file", url: "https://x/a/y.mov?token=1" }), "video-file"));
check("file_name 字段也算", () => assert.equal(classifyAttachment({ segType: "file", fileName: "v.webm" }), "video-file"));
check("图片文件仍判 image", () => assert.equal(classifyAttachment({ segType: "file", name: "a.JPG" }), "image"));
check("mface/face 仍是表情", () => {
  assert.equal(classifyAttachment({ segType: "mface" }), "sticker");
  assert.equal(classifyAttachment({ segType: "face" }), "sticker");
});
check("无关文件不会误判成视频", () => {
  assert.equal(classifyAttachment({ segType: "file", name: "x.zip" }), "file");
  assert.equal(classifyAttachment({ segType: "file", file: "opaque-id" }), "file");
});
check("extOf 处理 query/hash/大小写", () => {
  assert.equal(extOf("https://a/b/c.MP4?x=1#y"), "mp4");
  assert.equal(extOf("noext"), "");
});
if (failed) process.exit(1);
console.log("\n🎉 附件类型判定测试通过");
