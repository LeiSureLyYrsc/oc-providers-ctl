import { App } from './workbench/App';
import { demoBackend } from './demo/backend';
import { isTauriRuntime, nativeBackend } from './ipc';

export default function Root() {
  const params = new URLSearchParams(window.location.search);
  const forceDemo = params.get('demo') === '1';
  const mode = isTauriRuntime() && !forceDemo ? 'native' : 'demo';
  return <App mode={mode} backend={mode === 'native' ? nativeBackend : demoBackend} />;
}
