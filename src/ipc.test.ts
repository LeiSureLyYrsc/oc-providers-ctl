import { describe, expect, it } from 'vitest';
import {
  createNativeBackend,
  IpcFailure,
  normalizeCandidate,
  toSafeMessage,
} from './ipc';
import { V2_NATIVE_SOURCE, makeCandidate, makePreview, snapshotOf } from './test/fixtures';

describe('safe error messages', () => {
  it('collapses control characters, masks bearer tokens and truncates', () => {
    const message = toSafeMessage(
      `失败\n内容\t不应显示 Authorization: Bearer abc123def456 ${'x'.repeat(400)}`,
    );
    expect(message).not.toContain('\n');
    expect(message).not.toContain('abc123def456');
    expect(message).toContain('[已隐藏]');
    expect(message.length).toBeLessThanOrEqual(240);
  });

  it('handles unknown failures without throwing raw objects', () => {
    expect(toSafeMessage({ nope: true })).toContain('未能获得可读');
  });
});

describe('native backend contract', () => {
  it('sends snake_case commands with camelCase args and normalizes DTOs', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const backend = createNativeBackend(async (command, args) => {
      calls.push({ command, args });
      switch (command) {
        case 'scan_configs':
          return snapshotOf([V2_NATIVE_SOURCE], 'C:\\work');
        case 'preview_changes':
          return makePreview(V2_NATIVE_SOURCE.path, 2);
        case 'apply_changes':
          return { ...V2_NATIVE_SOURCE, hash: 'new-hash' };
        case 'match_models':
          return [makeCandidate()];
        case 'fetch_catalog':
          return {
            modelCount: 5,
            fetchedAt: '2026-11-17T09:40:00Z',
            stale: false,
            warnings: [],
          };
        case 'fetch_provider_models':
          return {
            providerId: 'gateway',
            modelIds: ['upstream/coder'],
            fetchedAt: '2026-11-17T10:00:00Z',
            warnings: [],
          };
        default:
          throw new Error(`unexpected ${command}`);
      }
    });

    const snapshot = await backend.scanConfigs('C:\\work');
    expect(calls[0]).toEqual({
      command: 'scan_configs',
      args: { projectPath: 'C:\\work' },
    });
    expect(snapshot.sources[0].providers[0].models[0].id).toBe('upstream/coder');

    const edits = [
      {
        op: 'set' as const,
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'limit', 'context'],
        value: 262144,
      },
    ];
    await backend.previewChanges(V2_NATIVE_SOURCE.path, V2_NATIVE_SOURCE.hash, edits);
    expect(calls[1]).toEqual({
      command: 'preview_changes',
      args: {
        path: V2_NATIVE_SOURCE.path,
        expectedHash: V2_NATIVE_SOURCE.hash,
        edits,
      },
    });

    const applied = await backend.applyChanges('preview-1');
    expect(calls[2]).toEqual({ command: 'apply_changes', args: { previewId: 'preview-1' } });
    expect(applied.hash).toBe('new-hash');

    const candidates = await backend.matchModels('coder', 'gateway');
    expect(calls[3]).toEqual({
      command: 'match_models',
      args: { query: 'coder', providerId: 'gateway' },
    });
    expect(candidates[0].reasoning).toEqual(makeCandidate().reasoning);

    await backend.fetchProviderModels(V2_NATIVE_SOURCE.path, 'gateway');
    expect(calls.at(-1)?.command).toBe('fetch_provider_models');
  });

  it('turns transport failures into IpcFailure with safe text', async () => {
    const backend = createNativeBackend(async () => {
      throw '权限被拒绝\n/secret/path';
    });
    await expect(backend.loadConfig('x')).rejects.toBeInstanceOf(IpcFailure);
    await expect(backend.loadConfig('x')).rejects.toThrow('权限被拒绝');
  });

  it('rejects malformed DTOs instead of accepting partial data', async () => {
    const backend = createNativeBackend(async () => ({ sources: [{ path: 42 }] }));
    await expect(backend.scanConfigs(null)).rejects.toThrow('配置数据格式异常');
  });

  it('keeps normalized reasoning objects from the catalog', () => {
    const candidate = normalizeCandidate(makeCandidate());
    expect(candidate.reasoning).toEqual(makeCandidate().reasoning);
  });
});
