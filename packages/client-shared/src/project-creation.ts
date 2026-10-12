export function validProjectPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && part.length <= 200 && !/[\\\x00-\x1f\x7f<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function projectCreationError(code: string): string {
  const messages: Record<string, string> = {
    'project-parent-not-authorized': '该目录未授权。请在电脑端设置中授权父目录，保存并重新连接。',
    'project-parent-unavailable': '授权目录已移动或无法访问，请在电脑端重新选择。',
    'project-path-invalid': '请输入父目录内的相对路径，如 demo 或 apps/demo，不支持 ..、绝对路径或特殊文件名。',
    'project-path-not-allowed': '该路径含符号链接或超出授权目录，请选择普通子文件夹。',
    'project-folder-exists': '文件夹已存在，请选择“添加已有文件夹”。',
    'project-folder-not-found': '文件夹不存在。新建时，上级子目录须已存在。',
    'project-folder-unavailable': '无法访问或创建文件夹，请检查电脑端目录权限。',
    'project-limit': '项目数量已达到同步上限，请先在电脑端整理项目。',
    'app-server-unavailable': '此电脑尚不能新建项目。请更新连接器并使用自动或 App Server 运行方式。',
    'device-offline': '电脑已离线，请连接后再试。',
    'remote-disconnected': '远程连接已暂停，请连接后再试。',
    'command-expired': '操作已过期，请重新连接后再试。',
    'project-registration-rejected': 'Codex 拒绝添加项目，请检查电脑上的 Codex 版本。文件夹若已创建，可稍后通过“添加已有文件夹”继续。',
  };
  return messages[code] ?? '创建结果尚未确认，请刷新项目列表。文件夹若已创建，可使用“添加已有文件夹”继续；不会删除本地文件。';
}
