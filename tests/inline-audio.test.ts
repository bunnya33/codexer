import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { audioReferences, markdownReferenceSuffix, splitAudioContent, stripInlineImageReferences } from "../packages/client-shared/src/audio.js";
import { renderMarkdown } from "../packages/client-shared/src/markdown.js";
import { FileRegistry } from "../packages/codex-adapter/src/files.js";
import { ImageRegistry } from "../packages/codex-adapter/src/images.js";

it("turns audio image tags into cards while retaining prose, pictures and download links", () => {
  const source = "前文\n\n![试听](/tmp/song.wav)\n\n![图片](/tmp/cover.png)\n\n[下载 WAV](/tmp/song.wav)\n\n后文";
  expect(audioReferences(source)).toEqual([{ source: "/tmp/song.wav", title: "试听" }]);
  expect(splitAudioContent(source).filter(part => part.kind === "text").map(part => part.text).join("")).toBe(source.replace("![试听](/tmp/song.wav)", ""));
  expect(new ImageRegistry().references("a", { type: "agentMessage", text: source }).map(image => image.source)).toEqual(["/tmp/cover.png"]);
  expect(stripInlineImageReferences(source, ["/tmp/cover.png", "/tmp/song.wav"])).toBe(source.replace("![图片](/tmp/cover.png)", ""));
});

it("handles spaces, Unicode, titles, encoded Windows paths, nested parentheses and reference-style tags", () => {
  const source = '![云山](</Users/mac/Music/云山 (修仙).WAV> "曲名")\n\n![试听](file:///C:/Music/New%20project/song.mp3)\n\n![乐曲](/tmp/take(1).m4a)\n\n![参考][music]\n\n[music]: /tmp/reference.flac';
  expect(audioReferences(source).map(audio => audio.source)).toEqual([
    "/Users/mac/Music/云山 (修仙).WAV", "C:/Music/New project/song.mp3", "/tmp/take(1).m4a", "/tmp/reference.flac",
  ]);
});

it("leaves code samples, escaped tags, partial streaming tags and unsupported sources literal", () => {
  for (const source of [
    "`![试听](/tmp/song.wav)`", "`` ![试听](/tmp/song.wav) `x` ``",
    "```md\n![试听](/tmp/song.wav)\n```", "~~~md\n![试听](/tmp/song.wav)\n~~~~",
    "    ![试听](/tmp/song.wav)\n", "\\![试听](/tmp/song.wav)", "![试听](/tmp/song.wav",
    "![试听](https://example.com/song.wav)", "![试听](data:audio/wav;base64,test)",
    "![试听](javascript:alert(1))", "![试听](file://server/share/song.wav)",
    "![试听](/tmp/song.wav.exe)", "![试听](relative.wav)", "[下载](/tmp/song.wav)",
  ]) {
    expect(audioReferences(source), source).toEqual([]);
    expect(splitAudioContent(source), source).toEqual([{ kind: "text", text: source }]);
  }
  expect(audioReferences("```md\n![示例](/tmp/song.wav)\n```\n\n![实际](/tmp/song.wav)")).toEqual([{ source: "/tmp/song.wav", title: "实际" }]);
});

it("authorizes embedded audio through the file channel only in the citing thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexer-inline-audio-"));
  try {
    const path = join(directory, "song.wav");
    await writeFile(path, "fixture-audio");
    const registry = new FileRegistry();
    registry.observeTurn("a", { items: [{ id: "audio", type: "agentMessage", text: `![试听](<${path}>)`, truncated: false }] });
    expect(await registry.read("a", path)).toMatchObject({ name: "song.wav", size: 13 });
    await expect(registry.read("b", path)).rejects.toThrow("file-not-in-thread");
    registry.observeTurn("c", { items: [{ id: "code", type: "agentMessage", text: `\`![试听](<${path}>)\``, truncated: false }] });
    await expect(registry.read("c", path)).rejects.toThrow("file-not-in-thread");
    const metadata = `[unrelated]: /tmp/other "![试听](<${path}>)"`;
    registry.observeTurn("d", { items: [{ id: "metadata", type: "agentMessage", text: metadata, truncated: false }] });
    expect(audioReferences(metadata)).toEqual([]);
    await expect(registry.read("d", path)).rejects.toThrow("file-not-in-thread");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('preserves reference-style downloads in fragments without reading metadata as audio', () => {
  const source = '[下载][music]\n\n![试听][music]\n\n[music]: </tmp/song.wav> "![元数据](/tmp/hidden.wav)"';
  expect(audioReferences(source)).toEqual([{ source: '/tmp/song.wav', title: '试听' }]);
  const suffix = markdownReferenceSuffix(source);
  const html = splitAudioContent(source).flatMap(part => part.kind === 'text' ? [renderMarkdown(part.text + suffix, undefined, true)] : []).join('');
  expect(html).toContain('data-file-path="/tmp/song.wav"');
  expect(html).not.toContain('hidden.wav');
});

it('maps visible audio in quoted and list blocks while keeping code and escaped tags literal', () => {
  const source = '> ![试听](/tmp/quote.wav)\r\n\r\n- ![试听](/tmp/list.mp3)\r\n\r\n    `![示例](/tmp/code.wav)`';
  expect(audioReferences(source).map(audio => audio.source)).toEqual(['/tmp/quote.wav', '/tmp/list.mp3']);
  expect(audioReferences('[unused]: /tmp/x "![音频](/tmp/hidden.wav)"\n\n正文')).toEqual([]);
});
