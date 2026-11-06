import { useTheme } from './styles';
import type { TaskStatusDotProps } from './task-status-dot';
import './task-status-dot.web.css';

export function TaskStatusDot({ running = false, label }: TaskStatusDotProps) {
  const { c } = useTheme();
  return <span data-testid="task-status-dot" className={`codexer-task-dot${running ? ' codexer-task-dot-running' : ''}`} role={label && running ? 'progressbar' : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ color: running ? c.taskRunning : c.success }}>
    {running && <span className="codexer-task-dot-ring" />}
    <span className="codexer-task-dot-core" />
  </span>;
}
