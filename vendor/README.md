# vendor/ — WOFF2 → TTF 解码器（wawoff2）

本目录放置 **wawoff2**（Google woff2 官方 C++ 代码的 WASM 移植，MIT 许可），
用于把网页下载的 WOFF2 字体转换为通用 TTF 格式。

## ✅ 当前状态：已就位，无需再下载

| 文件 | 说明 |
| --- | --- |
| `wawoff2.js` (322 KB) | **自包含单文件**：Emscripten 编译产物，wasm 以 base64 内嵌，**不需要额外的 .wasm 文件** |
| `wawoff2.LICENSE` | MIT 许可原文 |
| `wawoff2.package.json` | 来源包元数据（`wawoff2@2.0.1`，仓库 `fontello/wawoff2`） |

`background.js` 会自动探测 `wawoff2.js` / `wawoff2.min.js` / `decompress_binding.js`
等候选名，加载后等待 `onRuntimeInitialized`，再调用 `Module.decompress(woff2Bytes)`
返回 `Uint8Array<TTF>`（失败返回 `false`）。

## 已验证

- 用系统 TTF（arial/segoeui/times）→ 官方 compress 绑定压成 WOFF2 → 本文件解回 TTF，
  输出魔数 `0x00010000` 正确（闭环通过）。
- API 契约：无效输入返回 `false`（不抛异常）。

## 若需重新获取（备用）

万一 `wawoff2.js` 丢失，从 npm 包整包取回：

1. 下载：<https://registry.npmjs.org/wawoff2/-/wawoff2-2.0.1.tgz>
   （国内镜像：<https://registry.npmmirror.com/wawoff2/-/wawoff2-2.0.1.tgz>）
2. 解压后取出 `package/build/decompress_binding.js`，改名为 `wawoff2.js` 放入本目录即可
   （或保持原名放入也行，背景脚本会探测）。

> 注意事项：`build/compress_binding.js`（压缩用）我们不需要，扩展只做解压（WOFF2→TTF）。
> 若看到「未找到 wawoff2 解码器」的报错，检查 `vendor/wawoff2.js` 是否存在、大小约 322KB。