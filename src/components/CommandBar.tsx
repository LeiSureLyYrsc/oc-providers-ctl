import { Icon } from './Icon';

interface CommandBarProps {
  mode: 'demo' | 'native';
  projectPath: string;
  onProjectPath: (value: string) => void;
  loadPath: string;
  onLoadPath: (value: string) => void;
  scanning: boolean;
  onScanGlobal: () => void;
  onScanProject: () => void;
  onPickProject: () => void;
  onLoad: () => void;
  onPickFile: () => void;
}

export function CommandBar({
  mode,
  projectPath,
  onProjectPath,
  loadPath,
  onLoadPath,
  scanning,
  onScanGlobal,
  onScanProject,
  onPickProject,
  onLoad,
  onPickFile,
}: CommandBarProps) {
  const demo = mode === 'demo';
  return (
    <div className="commandbar">
      <div className="cmd-group cmd-project">
        <label className="cmd-field">
          <span className="cmd-label mono">PROJECT / 项目</span>
          <input
            className="mono"
            value={projectPath}
            onChange={(event) => onProjectPath(event.target.value)}
            placeholder="项目目录（可留空，仅扫描全局）"
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onScanProject();
              }
            }}
            aria-label="项目目录"
          />
        </label>
        <button
          type="button"
          className="btn btn-small"
          onClick={onPickProject}
          disabled={demo}
          title={demo ? '演示模式不打开系统目录选择器' : '选择项目目录'}
        >
          <Icon name="folder" size={13} />
          选择目录
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={onScanProject}
          disabled={scanning || !projectPath.trim()}
          title={!projectPath.trim() ? '先填写项目目录' : '扫描全局 + 该项目'}
        >
          <Icon name="scan" size={13} />
          扫描项目
        </button>
        <button
          type="button"
          className="btn btn-small btn-ghost"
          onClick={onScanGlobal}
          disabled={scanning}
          title="只扫描全局配置源"
        >
          扫描全局
        </button>
      </div>

      <div className="cmd-divider" aria-hidden="true" />

      <div className="cmd-group cmd-load">
        <label className="cmd-field">
          <span className="cmd-label mono">EXPLICIT / 载入</span>
          <input
            className="mono"
            value={loadPath}
            onChange={(event) => onLoadPath(event.target.value)}
            placeholder="显式 JSON / JSONC 路径"
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onLoad();
              }
            }}
            aria-label="显式配置路径"
          />
        </label>
        <button
          type="button"
          className="btn btn-small"
          onClick={onPickFile}
          disabled={demo}
          title={demo ? '演示模式不打开系统文件选择器' : '选择 JSON / JSONC 配置'}
        >
          <Icon name="file" size={13} />
          选择文件
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={onLoad}
          disabled={scanning || !loadPath.trim()}
        >
          载入
        </button>
      </div>
      {scanning ? (
        <span className="cmd-busy" role="status">
          <span className="busy-dot" aria-hidden="true" />
          处理中
        </span>
      ) : null}
    </div>
  );
}
