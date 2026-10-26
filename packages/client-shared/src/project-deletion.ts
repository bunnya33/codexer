export function projectDeletionError(code: string): string {
  const messages: Record<string, string> = {
    'project-not-empty': '项目中仍有会话（包括已归档的会话），只有会话数为 0 时才能删除。',
    'project-not-in-catalog': '项目已不存在，请刷新项目列表。',
    'project-deletion-stale': '项目或确认信息已变化，请重新选择删除项目并确认。',
    'project-directory-changed': '项目目录已被移动或替换，请重新核验后再试。',
    'project-directory-protected': '该目录包含系统、用户或 Codexer 数据，不能连同删除。可以仅删除项目。',
    'project-directory-shared': '该目录与其他项目或会话共用，不能连同删除。可以仅删除项目。',
    'project-directory-unsafe': '该目录包含符号链接、挂载点或无法安全核验，不能连同删除。可以仅删除项目。',
    'project-folder-not-found': '项目目录已不存在，可以仅删除项目。',
    'project-folder-unavailable': '无法访问项目目录，可以仅删除项目，或检查电脑端权限后重试。',
    'project-root-unavailable': '项目没有可核验的目录，可以仅删除项目。',
    'project-directory-delete-failed': '项目已从列表删除，但目录未能全部删除。剩余文件可能保留在原目录或同级的 .codexer-delete 临时目录，请检查下列位置后手动处理。',
    'project-deletion-rejected': 'Codex 拒绝删除项目，请检查电脑上的 Codex 版本并刷新列表。',
    'project-deletion-check-failed': '无法完整核验此电脑的项目与会话，已停止删除。请更新 Codex 和 Codexer Agent 后重试。',
    'app-server-unavailable': '请更新此电脑的 Codexer Agent，并使用自动或 App Server 运行方式。',
    'device-offline': '电脑已离线，请连接后再试。',
    'remote-disconnected': '远程连接已断开或暂停，请重新连接后再试。',
    'command-expired': '操作已过期，请重新确认。',
  };
  return messages[code] ?? '删除结果尚未确认，请刷新项目列表并检查电脑上的目录，确认后再操作。';
}
