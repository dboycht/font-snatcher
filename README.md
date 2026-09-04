# font-snatcher

A Microsoft Edge extension that detects fonts used on a webpage and downloads them as ready-to-use font files. Manifest V3.

> A Microsoft Edge extension that detects the fonts used by text on a webpage and downloads them as ready-to-use font files (WOFF2 / TTF), in one click.

## ✨ Features

- **全局清单模式**：扫描当前页面所有实际渲染中用到的字体，列出清单，逐个或一键下载。
- **选中文字模式**：选中页面上的一段文字，精确定位这段文字所使用的字体并下载。
- **双格式下载**：每个字体可下载为 **WOFF2**（网页原始格式）或 **TTF**（通用 TrueType，跨平台直接安装使用）。
- **跨域无忧**：后台 service worker 负责获取字体二进制数据，绕过页面 CORS 限制。
- **无构建依赖**：纯原生 JavaScript，无需 Node/npm 构建即可加载运行。

## 📥 安装（开发模式）

1. 打开 Microsoft Edge，访问 `edge://extensions/`。
2. 打开右上角「开发人员模式」开关。
3. 点击「加载解压缩的扩展」，选择本项目根目录（`font-snatcher/`）。
4. 工具栏出现 Font Snatcher 图标即安装成功。

> 兼容说明：本扩展遵循 Manifest V3，同样可在 Google Chrome 中通过 `chrome://extensions/` 以相同方式加载。

## 🔧 使用方法

1. 打开一个包含自定义字体的网页。
2. 点击工具栏 Font Snatcher 图标。
   - **查看全部字体**：popup 会列出页面所有在用字体。
   - **下载某个字体**：点击字体旁的 `WOFF2` 或 `TTF` 按钮即保存到下载目录。
3. （选中文字模式）先在页面上选中一段文字，再打开 popup，可看到这段文字对应的字体。

## 📁 项目结构

```
font-snatcher/
├── manifest.json      # MV3 扩展清单
├── background.js      # 后台 service worker（下载/转换）
├── content.js         # 内容脚本（扫描页面字体）
├── popup.html         # 弹出界面
├── popup.css          # 弹出界面样式
├── popup.js           # 弹出界面逻辑
├── icons/             # 扩展图标
├── vendor/            # wawoff2 解码器（需手动下载，见其 README）
├── DEVELOPMENT.md     # 开发者接续文档（不上 GitHub）
├── LICENSE
└── README.md
```

## 🛠 构建 / 安装前准备

- 本扩展**无构建步骤**，纯原生 JS。
- WOFF2→TTF 转换所需的解码器已内置于 `vendor/wawoff2.js`（自包含单文件，MIT 许可），
  **无需额外下载**。若该文件缺失，仅影响「没有 ttf 直链的字体转 TTF」，其余功能正常；
  恢复方法见 [`vendor/README.md`](./vendor/README.md)。

## ⚖️ License

[MIT](./LICENSE) © 2026 Mizuki
