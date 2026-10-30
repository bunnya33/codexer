const messages: Record<string, string> = {
  'thread-writer-busy': '该会话仍由其他 Codex 应用持有，请等待那边任务结束并释放会话后重试；刷新运行时不能抢占其他应用的会话',
  'thread-release-unconfirmed': '未确认会话占用已释放，请稍后重试；会话历史与文件未被重置',
  'headless-settings-unreadable': '无法读取电脑上的会话设置，请先检查该电脑的 PC Agent 版本、Codex 数据目录和诊断日志',
  'headless-settings-file-missing': '电脑上的会话文件不存在，请检查 PC Agent 的 Codex 数据目录，并在本机 Codex 打开该会话后重试',
  'headless-settings-access-denied': 'PC Agent 没有读取会话文件的权限，请在电脑上检查文件访问权限',
  'headless-settings-busy': '电脑上的会话文件正在变化或被占用，请稍后重试',
  'headless-settings-corrupt': '电脑上的会话文件不完整或无法解析，请在本机 Codex 检查该会话',
  'headless-settings-unavailable': '该会话尚无可恢复的运行设置，请先在本机 Codex 打开并使用该会话',
  'headless-settings-incomplete': '该会话的运行设置不完整，请更新 PC Agent 并在本机 Codex 检查该会话',
  'headless-compression-unsupported': 'PC Agent 的运行环境不支持压缩会话，请更新该电脑的 PC Agent',
  'headless-session-path-invalid': '会话文件位置或身份校验失败，请检查 PC Agent 的 Codex 数据目录',
};

export function agentErrorMessage(code: string): string {
  return Object.hasOwn(messages, code) ? `${messages[code]}（${code}）` : code;
}
