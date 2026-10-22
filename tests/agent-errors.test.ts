import { expect, it } from 'vitest';
import { agentErrorMessage } from '../packages/client-shared/src/agent-errors';

it('explains legacy and specific settings failures while preserving diagnostic codes', () => {
  expect(agentErrorMessage('headless-settings-unreadable')).toContain('PC Agent 版本');
  expect(agentErrorMessage('headless-settings-file-missing')).toContain('数据目录');
  expect(agentErrorMessage('headless-settings-access-denied')).toContain('权限');
  expect(agentErrorMessage('headless-settings-corrupt')).toContain('不完整或无法解析');
  expect(agentErrorMessage('headless-settings-busy')).toContain('稍后重试');
  expect(agentErrorMessage('headless-compression-unsupported')).toContain('更新该电脑');
  expect(agentErrorMessage('headless-settings-file-missing')).toContain('（headless-settings-file-missing）');
  expect(agentErrorMessage('stale-settings')).toBe('stale-settings');
});
