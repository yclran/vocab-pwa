# 背单词 PWA

家庭自用的背单词工具，PWA 网页，手机浏览器「添加到桌面」后像 App 一样使用。

## 核心能力

- **4 人自用、数据互不影响**：没有账号系统，每个人用自己的手机浏览器打开，数据存在本机 IndexedDB。
- **单词导入**：
  - 拍照 OCR（印刷体 / 手写体，手写识别后需逐条人工修正）
  - 上传 .txt / .docx
  - 粘贴大段英文或词表
  - 手动输入
- **词典自动补全**：联网时自动查音标、英美发音、词性、英文释义；断网仍可背已缓存的词。
- **分组管理**：初中核心单词 / 我的生词本 / 错题复习本 / 手写收集词，可新建、改名、删除。
- **学习题型**：翻转卡片、拼读跟读、看英文选中文、看中文选英文、拼写默写、中英互测。
- **复习算法**：艾宾浩斯间隔调度，答错自动进错题本，练熟后自动移出。
- **备份与同步**：导出 JSON 备份 / TXT 词表，通过文件互相传递即可共享词库。

## 技术栈

- Vue 3 + Vite
- Tailwind CSS
- Pinia
- IndexedDB（idb）
- Free Dictionary API（音标 / 词性 / 英文释义 / 真人发音）
- Tesseract.js（浏览器本地 OCR）
- mammoth.js（解析 Word）
- vite-plugin-pwa（Service Worker、manifest、离线缓存）

## 本地运行

```bash
# 1. 安装依赖（需要正常联网环境）
npm install

# 2. 启动开发服务器，同一 WiFi 下手机访问本机 IP:5173
npm run dev

# 3. 构建生产包（输出到 dist/）
npm run build
```

## 关于中文释义

Free Dictionary API **只返回英文释义**，不带中文。

如果你想让导入的纯英文单词自动补全中文，需要配置翻译代理：

1. 复制 `.env.example` 为 `.env.local`
2. 按你选择的 provider 填写 key（有道或百度）
3. 重新启动 `npm run dev`

> 注意：有道翻译 v3.0.0（2024-04-22）已下线接口内的词典数据，目前只返回机器翻译；
> 百度翻译同理，属于付费服务，有少量免费额度。
> 对 4 人自用来说，导入时自带中文或手动填写完全够用。

## 拍照 OCR 说明

默认使用 **Tesseract.js** 在浏览器本地识别，免费、无 key、可离线。

- **印刷体英文**：清晰、光线均匀、正拍时识别率尚可，支持框选区域只识别划线部分。
- **手写英文**：Tesseract 的 eng 模型是印刷体训练的，手写识别率很低。
  所以手写结果会默认全部标成「待确认」，必须逐条核对改正后再导入。

如果对手写有硬需求，需要接百度手写 OCR：

- 注册百度智能云、实名认证
- 在 `.env.local` 填百度 AK/SK
- 部署时同时部署 serverless 函数中转（项目已提供 `/api/ocr` 的 Vercel 示例）

## 部署到 Vercel（推荐）

1. 把项目 push 到 GitHub
2. 在 Vercel 导入项目
3. 默认输出目录是 `dist`
4. 如需翻译代理，在 Environment Variables 里填：
   - `TRANSLATE_PROVIDER=youdao` 或 `baidu`
   - `YOUDAO_APP_KEY`、`YOUDAO_APP_SECRET` 或 `BAIDU_APP_ID`、`BAIDU_API_KEY`
5. 部署完成后手机打开 URL → 浏览器「添加到桌面」

纯静态托管（腾讯云/阿里云/GitHub Pages）也能用，但翻译代理和百度 OCR 接口需要 serverless 函数，纯静态放不下。

## 目录结构

```
public/icons/          # PWA 图标（已由 scripts/gen-icons.mjs 生成）
server/                # 本地开发代理 / 可迁移到 serverless 的函数
src/
  components/          # SyllableReader, WordDetailSheet, OcrPanel
  db/                  # IndexedDB schema + repo
  router/              # vue-router
  services/            # 词典、OCR、导入解析、发音、音节拆分、SRS
  stores/              # Pinia stores
  views/               # 首页、词库、导入、学习、答题、设置
scripts/gen-icons.mjs  # 生成 PWA 图标的脚本
```

## 已知限制

- 无网络时不能查新词，但已缓存单词可正常背诵、发音（真人 mp3 已缓存时）。
- OCR 识别质量取决于图片清晰度，手写必须人工校对。
- TTS 拼读依赖浏览器自带的英文语音包，部分安卓机需要手动下载语音。
- 数据只存本机，换设备/清浏览器会丢失，记得定期导出 JSON 备份。
