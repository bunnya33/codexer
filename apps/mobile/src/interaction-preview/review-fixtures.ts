export type ReviewScene = "conversation" | "questions" | "plan" | "approval";
export type ReviewCondition = "normal" | "offline" | "failure" | "expired";
export type PreviewPreferences = {
  appearance: "system" | "light" | "dark";
  accent: "blue" | "green" | "purple" | "rose" | "orange";
};
export const defaultPreviewPreferences: PreviewPreferences = {
  appearance: "light",
  accent: "blue",
};
export const previewAccents = {
  blue: { name: "蓝色", color: "#3565f6", light: "#edf1fc", dark: "#242a3b" },
  green: { name: "绿色", color: "#16836b", light: "#e8f5ef", dark: "#1b3530" },
  purple: { name: "紫色", color: "#8b5bd7", light: "#f1eafa", dark: "#30273d" },
  rose: { name: "玫瑰色", color: "#c44972", light: "#f9eaf0", dark: "#392631" },
  orange: { name: "橙色", color: "#b45e19", light: "#fcf0e5", dark: "#362b22" },
};
export const reviewSceneLabels: Record<ReviewScene, string> = {
  conversation: "主会话",
  questions: "分页问答",
  plan: "计划卡片",
  approval: "审批请求",
};
export const planTitle = "旅行相册 · 移动端交互方案";
export const planInstruction = `请按照「${planTitle}」执行。`;
export const planBody = `# ${planTitle}

将旅行照片放在界面中心，保留轻巧、清晰的操作入口。优先完善手机阅读体验，再适配宽屏。

## 画面与布局

- 照片采用 4:3 卡片，标题与拍摄地点放在照片下方。
- 首页保留两列瀑布流；窄屏减少留白，不压缩文字。
- 输入区固定在底部，键盘弹出时跟随系统上移。
- 亮色使用白色背景，深色使用中性灰，状态颜色含义一致。

## 图片查看

点击照片进入独立查看器，支持放大和左右切换。关闭后回到原来的卡片，保留列表位置。

返回动画从当前照片收回卡片，避免整个列表重新出现。减少动态效果开启时改为短淡入淡出。

## 输入与草稿

1. 文字、图片和文件按会话保存。
2. 切换会话再返回时，继续原来的编辑。
3. 上传失败显示重试，不清空输入。
4. 任务运行中直接发送补充要求；中止后可原生继续。

## 文件与验证

修改 src/Album.tsx 和 src/album.css。使用现有组件实现布局与动画，不增加常驻后台服务。

验证 320、390 和 430 宽度下的卡片、长标题与输入区；检查键盘避让、亮暗切换，以及打开照片后返回原位置。

## 交付结果

- 可交互的首页与图片查看器。
- 对应源码和变更摘要。
- 实际完成的检查记录；尚未验证的项目单独说明。
`;

export const reviewQuestions = [
  {
    id: "layout",
    header: "卡片布局",
    question: "照片列表希望采用哪种布局？",
    options: [
      { label: "两列瀑布流（推荐）", description: "保留照片的原始比例，一屏可浏览更多内容。" },
      { label: "单列大图", description: "每张照片占据整行，更适合逐张欣赏。" },
    ],
  },
  {
    id: "motion",
    header: "图片查看",
    question: "打开和关闭照片时，希望使用哪种过渡？",
    options: [
      { label: "从卡片展开（推荐）", description: "照片从原位置展开，关闭后回到同一张卡片。" },
      { label: "简洁淡入淡出", description: "减少画面移动，保留平滑的明暗过渡。" },
      { label: "不使用动画", description: "直接展示照片，适合偏好静态界面的使用习惯。" },
    ],
  },
];

export type ReviewFile = {
  path: string;
  content: string;
  language: string;
  additions?: number;
  deletions?: number;
  before?: string;
  hidden?: boolean;
};
export const reviewFiles: ReviewFile[] = [
  {
    path: "src/Album.tsx",
    language: "tsx",
    additions: 18,
    deletions: 6,
    before: `import { useState } from 'react';\n\nexport function Album() {\n  return <div className="photos">旅行相册</div>;\n}\n`,
    content: `import { useState } from 'react';\nimport './album.css';\n\ntype Photo = { id: string; title: string; url: string };\n\nexport function Album({ photos }: { photos: Photo[] }) {\n  const [selected, setSelected] = useState<Photo | null>(null);\n\n  return (\n    <main className="album">\n      <header>\n        <p className="eyebrow">TRAVEL JOURNAL</p>\n        <h1>留住旅途中的每一刻</h1>\n      </header>\n      <section className="photo-grid">\n        {photos.map(photo => (\n          <button key={photo.id} onClick={() => setSelected(photo)}>\n            <img src={photo.url} alt={photo.title} />\n            <span>{photo.title}</span>\n          </button>\n        ))}\n      </section>\n      {selected && <PhotoViewer photo={selected} onClose={() => setSelected(null)} />}\n    </main>\n  );\n}\n`,
  },
  {
    path: "src/album.css",
    language: "css",
    additions: 24,
    deletions: 3,
    before: `.photos {\n  display: flex;\n  gap: 8px;\n}\n`,
    content: `:root {\n  color-scheme: light dark;\n  --surface: #ffffff;\n  --ink: #202124;\n}\n\n.album {\n  max-width: 960px;\n  margin: 0 auto;\n  padding: 24px 16px;\n  color: var(--ink);\n}\n\n.photo-grid {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 16px;\n}\n\n.photo-grid img {\n  width: 100%;\n  aspect-ratio: 4 / 3;\n  object-fit: cover;\n  border-radius: 18px;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root { --surface: #111113; --ink: #eeeeF2; }\n}\n`,
  },
  {
    path: "src/components/PhotoViewer.tsx",
    language: "tsx",
    content: `type Props = {\n  photo: { title: string; url: string };\n  onClose: () => void;\n};\n\nexport function PhotoViewer({ photo, onClose }: Props) {\n  return (\n    <dialog open aria-label={photo.title}>\n      <button onClick={onClose}>关闭照片</button>\n      <img src={photo.url} alt={photo.title} />\n    </dialog>\n  );\n}\n`,
  },
  {
    path: "public/photos.json",
    language: "json",
    content:
      '[\n  { "id": "coast", "title": "海边的清晨", "url": "/coast.jpg" },\n  { "id": "mountain", "title": "山间的傍晚", "url": "/mountain.jpg" }\n]\n',
  },
  {
    path: "docs/交互说明.md",
    language: "markdown",
    content:
      "# 旅行相册交互\n\n图片查看器关闭后回到原位置。\n\n草稿按会话保存，切换项目不会覆盖其他会话的文字。\n\n全文搜索可以定位照片、卡片和动画相关代码。\n",
  },
  {
    path: "README.md",
    language: "markdown",
    content:
      "# 旅行相册\n\n一个简洁的移动端相册。\n\n## 本地运行\n\n```sh\nnpm install\nnpm run dev\n```\n\n目录：src 为界面源码，public 为静态资源，docs 为使用说明。\n",
  },
  {
    path: "package.json",
    language: "json",
    content:
      '{\n  "name": "travel-album",\n  "private": true,\n  "scripts": { "dev": "vite", "build": "vite build" }\n}\n',
  },
  {
    path: ".gitignore",
    language: "text",
    hidden: true,
    content: "node_modules/\ndist/\n.local/\n",
  },
];
