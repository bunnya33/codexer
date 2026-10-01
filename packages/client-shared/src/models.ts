import type { ModelOption } from "../../protocol/src/index.js";

export function effortLabel(effort: string | null | undefined): string {
  const names: Record<string, string> = { none: "无", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "极致" };
  return effort ? names[effort] ?? effort : "默认";
}
export function modelLabel(model: string | null | undefined, options: ModelOption[] = []): string {
  const option = options.find(option => option.model === model);
  return (option?.displayName || model || "模型未记录").replace(/^gpt[- ]/i, "").replace(/^(\d+(?:\.\d+)?)-/i, "$1 ");
}
