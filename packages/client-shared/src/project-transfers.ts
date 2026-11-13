import type { ProjectTransfer } from '../../protocol/src/project-transfers';
export const projectTransferLabels: Record<ProjectTransfer['state'], string> = {
  preparing: '等待发送端报告进度', ready: '快照已就绪，等待确认发送', uploading: '正在发送到服务器',
  downloading: '目标设备正在接收', installing: '正在校验并保存项目', received: '项目已保存，正在登记项目列表',
  completed: '项目已接收', failed: '传输失败', cancelled: '已取消',
};
export function transferPreparationLabel(job: ProjectTransfer): string {
  const prep = job.preparation;
  if (!prep) return projectTransferLabels.preparing;
  if (prep.phase === 'waiting') return prep.reason === 'runtime-refresh' ? '等待发送端运行时刷新完成' : prep.reason === 'agent-busy' ? '等待发送端处理前一项传输' : '等待源项目空闲';
  return {scanning: '正在扫描项目文件', packing: '正在生成项目快照', verifying: '正在复核源文件', checksumming: '正在校验快照'}[prep.phase];
}
export function transferElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds / 60) % 60} 分`;
}
export function projectTransferError(code: string): string {
  const errors: Record<string, string> = {
    'project-transfer-update-required': '请更新两台电脑的 Codexer Agent 后再发送项目。',
    'project-parent-not-authorized': '请在接收电脑的 Agent 设置中授权保存项目的父目录。',
    'project-transfer-busy': '当前传输任务较多，请先完成或取消已有任务。',
    'project-transfer-state-changed': '传输状态已变化，请刷新后重试。',
    'project-transfer-unavailable': '传输记录已过期或不可访问。',
    'project-transfer-id-reused': '此发送请求已用于其他内容，请重新打开窗口。',
    'project-transfer-already-saved': '项目正在保存或已经保存，可到目标设备检查。',
    'project-transfer-source-changed': '打包期间项目文件发生变化，请等文件写入结束后重新发送。',
    'project-transfer-source-busy': '源项目正在进行 Git 操作，请完成后重新发送。',
    'project-transfer-snapshot-in-progress': '正在生成项目快照，完成后即可继续操作。',
    'project-transfer-source-snapshot-missing': '源设备的快照已丢失，请重新发送项目。',
    'project-transfer-too-large': '项目快照超过 4 GiB，请增加排除目录后重新发送。',
    'project-transfer-too-many-files': '项目超过 100,000 个文件和目录，请增加排除项后重新发送。',
    'project-transfer-link-unsupported': '项目包含符号链接或目录联接。请排除对应目录，或先将链接整理为普通文件后发送。',
    'project-transfer-file-unsupported': '项目包含特殊文件，暂时无法发送，请先整理相关文件。',
    'project-transfer-external-git-unsupported': 'Git 数据位于项目目录之外。可取消“保留本地 Git 历史”后发送当前文件，或先整理为独立仓库。',
    'project-transfer-case-collision': '项目存在仅大小写不同的路径，跨平台保存前请先解决重名。',
    'project-transfer-path-unsupported': '项目含目标平台无法保存的文件名，请先调整文件名。',
    'project-transfer-checksum-mismatch': '文件完整性校验失败，请重新发送项目。',
    'project-transfer-invalid-snapshot': '项目快照格式无效，请重新发送。',
    'project-transfer-disk-full': '无法写入项目，请检查源设备、服务器和接收设备的可用空间及目录权限。',
    'project-folder-exists': '目标文件夹已存在，请换一个新文件夹名称。',
    'project-directory-changed': '项目目录或保存目录发生变化，请检查路径后重新发送。',
    'project-not-in-catalog': '源项目已不在设备项目列表中，请刷新列表。',
    'device-offline': '两台设备需在线才能创建传输。开始后断线会等待重连。',
    'HTTP 404': '当前服务器尚未支持项目传输，请更新服务器。',
  };
  return errors[code] ?? `操作未完成，请检查连接后重试（${code}）。`;
}
export function transferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
