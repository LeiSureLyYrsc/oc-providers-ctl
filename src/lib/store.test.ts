import { describe, expect, it } from 'vitest';
import {
  activeSource,
  batchFor,
  createInitialState,
  editsToApply,
  MAX_EDITS_PER_BATCH,
  reducer,
  type WorkbenchState,
} from './store';
import { locateModel, modelLeafPath } from './paths';
import { SECOND_SOURCE, V1_NATIVE_SOURCE, V2_NATIVE_SOURCE, makePreview, snapshotOf } from '../test/fixtures';

const provider = V2_NATIVE_SOURCE.providers[0];
const model = provider.models[0];
const contextPath = modelLeafPath('v2', locateModel(provider, model), 'context');

function baseState(mode: 'native' | 'demo' = 'native'): WorkbenchState {
  return reducer(createInitialState({ mode }), {
    type: 'SCAN_SUCCESS',
    snapshot: snapshotOf([V2_NATIVE_SOURCE, SECOND_SOURCE]),
  });
}

function stageContext(state: WorkbenchState, value = 262144): WorkbenchState {
  return reducer(state, {
    type: 'STAGE',
    input: {
      sourcePath: V2_NATIVE_SOURCE.path,
      dialect: 'v2',
      intent: 'field',
      path: contextPath,
      op: 'set',
      value,
      label: '上下文窗口',
    },
  });
}

function startPreview(state: WorkbenchState, demo = false): WorkbenchState {
  const batch = batchFor(state, V2_NATIVE_SOURCE.path);
  if (!batch) throw new Error('missing batch');
  return reducer(state, {
    type: 'PREVIEW_START',
    demo,
    request: {
      path: V2_NATIVE_SOURCE.path,
      sourceHash: batch.sourceHash,
      revision: batch.revision,
    },
  });
}

function readyPreview(state: WorkbenchState, demo = false): WorkbenchState {
  const started = startPreview(state, demo);
  return reducer(started, {
    type: 'PREVIEW_RESULT',
    result: makePreview(V2_NATIVE_SOURCE.path),
    demo,
  });
}

describe('emitted native edits', () => {
  it('address the V2 map key, not an array index', () => {
    const state = stageContext(baseState());
    const edits = editsToApply(batchFor(state, V2_NATIVE_SOURCE.path));
    expect(edits).toEqual([
      {
        op: 'set',
        path: [
          'providers',
          'gateway',
          'models',
          'upstream/coder',
          'limit',
          'context',
        ],
        value: 262144,
      },
    ]);
    expect(JSON.stringify(edits)).not.toContain('models","0"');
  });

  it('uses V1 map keys in the same way', () => {
    const v1 = V1_NATIVE_SOURCE;
    const v1Model = v1.providers[0].models[0];
    const v1Path = modelLeafPath('v1', locateModel(v1.providers[0], v1Model), 'context');
    const state = reducer(
      reducer(createInitialState({ mode: 'native' }), {
        type: 'SCAN_SUCCESS',
        snapshot: snapshotOf([v1]),
      }),
      {
        type: 'STAGE',
        input: {
          sourcePath: v1.path,
          dialect: 'v1',
          intent: 'field',
          path: v1Path,
          op: 'set',
          value: 12345,
          label: '上下文窗口',
        },
      },
    );
    expect(editsToApply(batchFor(state, v1.path))[0].path).toEqual([
      'provider',
      'zhipu',
      'models',
      'glm-4.6',
      'limit',
      'context',
    ]);
  });
});

describe('preview lifecycle safety', () => {
  it('invalidates a ready preview when switching files and ignores the late result', () => {
    const ready = readyPreview(stageContext(baseState()));
    expect(ready.preview.status).toBe('ready');
    const switched = reducer(ready, {
      type: 'SELECT_SOURCE',
      path: SECOND_SOURCE.path,
    });
    expect(switched.preview.status).toBe('idle');
    expect(switched.activeSourcePath).toBe(SECOND_SOURCE.path);
    const late = reducer(switched, {
      type: 'PREVIEW_RESULT',
      result: makePreview(V2_NATIVE_SOURCE.path),
      demo: false,
    });
    expect(late.preview.status).toBe('idle');
    expect(late.preview.result).toBeUndefined();
  });

  it('invalidates an in-flight preview on source switch', () => {
    const loading = startPreview(stageContext(baseState()));
    expect(loading.preview.status).toBe('loading');
    const switched = reducer(loading, { type: 'SELECT_SOURCE', path: SECOND_SOURCE.path });
    expect(switched.preview.status).toBe('idle');
    const late = reducer(switched, {
      type: 'PREVIEW_RESULT',
      result: makePreview(V2_NATIVE_SOURCE.path),
      demo: false,
    });
    expect(late.preview.status).toBe('idle');
  });

  it('freezes drafts while a preview is in flight', () => {
    const loading = startPreview(stageContext(baseState()));
    const attempted = stageContext(loading, 999999);
    expect(attempted.preview.status).toBe('loading');
    expect(attempted.batches[V2_NATIVE_SOURCE.path].edits).toHaveLength(1);
    expect(attempted.notice?.kind).toBe('error');
  });

  it('ignores a preview result after the draft revision changes', () => {
    const ready = readyPreview(stageContext(baseState()));
    const restaged = stageContext(ready, 300000);
    expect(restaged.preview.status).toBe('idle');
    const late = reducer(restaged, {
      type: 'PREVIEW_RESULT',
      result: makePreview(V2_NATIVE_SOURCE.path),
      demo: false,
    });
    expect(late.preview.status).toBe('idle');
  });

  it('ignores a late error from a different request', () => {
    const loading = startPreview(stageContext(baseState()));
    const stale = reducer(loading, {
      type: 'PREVIEW_ERROR',
      message: 'old failure',
      request: { path: 'elsewhere', sourceHash: 'nope', revision: 99 },
    });
    expect(stale.preview.status).toBe('loading');
    const batch = batchFor(stale, V2_NATIVE_SOURCE.path);
    if (!batch) throw new Error('missing batch');
    const current = reducer(stale, {
      type: 'PREVIEW_ERROR',
      message: 'real failure',
      request: {
        path: V2_NATIVE_SOURCE.path,
        sourceHash: batch.sourceHash,
        revision: batch.revision,
      },
    });
    expect(current.preview.status).toBe('error');
    expect(current.preview.message).toBe('real failure');
  });
});

describe('apply freezing', () => {
  it('freezes drafts and source switching after APPLY_START, then clears on error', () => {
    const ready = readyPreview(stageContext(baseState()));
    const applying = reducer(ready, { type: 'APPLY_START' });
    expect(applying.applyInFlight).toBe(true);
    const blockedStage = stageContext(applying, 777);
    expect(blockedStage.batches[V2_NATIVE_SOURCE.path].edits[0].value).toBe(262144);
    expect(blockedStage.activeSourcePath).toBe(V2_NATIVE_SOURCE.path);
    const blockedSwitch = reducer(applying, {
      type: 'SELECT_SOURCE',
      path: SECOND_SOURCE.path,
    });
    expect(blockedSwitch.activeSourcePath).toBe(V2_NATIVE_SOURCE.path);
    expect(blockedSwitch.applyInFlight).toBe(true);
    const failed = reducer(applying, {
      type: 'APPLY_ERROR',
      message: 'hash changed on disk',
    });
    expect(failed.applyInFlight).toBe(false);
    expect(failed.preview.status).toBe('ready');
    expect(failed.preview.applyError).toBe('hash changed on disk');
    expect(batchFor(failed, V2_NATIVE_SOURCE.path)?.edits).toHaveLength(1);
  });

  it('never marks demo apply as in flight or mutates the document', () => {
    const ready = readyPreview(stageContext(baseState('demo')), true);
    const blocked = reducer(ready, { type: 'APPLY_START' });
    expect(blocked.applyInFlight).toBe(false);
    expect(blocked.preview.status).toBe('blocked');
    expect(activeSource(blocked)?.hash).toBe(V2_NATIVE_SOURCE.hash);
    expect(batchFor(blocked, V2_NATIVE_SOURCE.path)?.edits).toHaveLength(1);
  });

  it('clears the batch and marks applied after a native SOURCE_UPDATED', () => {
    const applying = reducer(readyPreview(stageContext(baseState())), { type: 'APPLY_START' });
    const updated = {
      ...V2_NATIVE_SOURCE,
      hash: 'after-write-hash',
      providers: [
        {
          ...provider,
          models: [{ ...model, context: 262144 }],
        },
      ],
    };
    const done = reducer(applying, {
      type: 'SOURCE_UPDATED',
      source: updated,
      reason: 'apply',
    });
    expect(done.applyInFlight).toBe(false);
    expect(done.preview.status).toBe('applied');
    expect(done.batches[V2_NATIVE_SOURCE.path]).toBeUndefined();
    expect(activeSource(done)?.hash).toBe('after-write-hash');
  });
});

describe('scan and load safety', () => {
  it('preserves drafts when a rescan returns an unchanged hash', () => {
    const staged = stageContext(baseState());
    const rescanned = reducer(staged, {
      type: 'SCAN_SUCCESS',
      snapshot: snapshotOf([{ ...V2_NATIVE_SOURCE }, SECOND_SOURCE]),
    });
    expect(rescanned.batches[V2_NATIVE_SOURCE.path]).toBeDefined();
    expect(rescanned.preview.status).toBe('idle');
    expect(rescanned.notice?.text).toContain('保留');
  });

  it('drops and reports drafts when their source hash changed', () => {
    const staged = stageContext(baseState());
    const rescanned = reducer(staged, {
      type: 'SCAN_SUCCESS',
      snapshot: snapshotOf([{ ...V2_NATIVE_SOURCE, hash: 'changed-hash' }, SECOND_SOURCE]),
    });
    expect(rescanned.batches[V2_NATIVE_SOURCE.path]).toBeUndefined();
    expect(rescanned.notice?.text).toContain('丢弃');
  });

  it('allows a first explicit load without a prior snapshot and clears loading', () => {
    const initial = createInitialState({ mode: 'native' });
    const loading = reducer(initial, { type: 'LOAD_START' });
    const loaded = reducer(loading, { type: 'SOURCE_ADDED', source: V2_NATIVE_SOURCE });
    expect(loaded.snapshot?.sources).toHaveLength(1);
    expect(loaded.activeSourcePath).toBe(V2_NATIVE_SOURCE.path);
    expect(loaded.scanning).toBe(false);
    expect(loaded.scanError).toBeNull();
  });

  it('reports a hash conflict when reloading over drafts', () => {
    const staged = stageContext(baseState());
    const reloaded = reducer(staged, {
      type: 'SOURCE_ADDED',
      source: { ...V2_NATIVE_SOURCE, hash: 'different-hash' },
    });
    expect(reloaded.batches[V2_NATIVE_SOURCE.path]).toBeUndefined();
    expect(reloaded.notice?.kind).toBe('info');
    expect(reloaded.notice?.text).toContain('旧草稿');
  });

  it('keeps drafts on same-hash reload and discards all only explicitly', () => {
    const staged = stageContext(baseState());
    const reloaded = reducer(staged, {
      type: 'SOURCE_ADDED',
      source: { ...V2_NATIVE_SOURCE },
    });
    expect(reloaded.batches[V2_NATIVE_SOURCE.path]).toBeDefined();
    const discarded = reducer(reloaded, { type: 'DISCARD_ALL_DRAFTS' });
    expect(discarded.batches).toEqual({});
    expect(discarded.notice?.text).toContain('丢弃');
  });
});

describe('batch cap', () => {
  it('enforces 64 edits per file and still permits replacing an existing edit', () => {
    let state = baseState();
    const sourcePath = V2_NATIVE_SOURCE.path;
    for (let index = 0; index < MAX_EDITS_PER_BATCH; index += 1) {
      state = reducer(state, {
        type: 'STAGE',
        input: {
          sourcePath,
          dialect: 'v2',
          intent: 'create-model',
          path: ['providers', 'gateway', 'models', `bulk-${index}`],
          op: 'set',
          value: { name: `Bulk ${index}` },
          label: `新建模型 bulk-${index}`,
        },
      });
    }
    expect(batchFor(state, sourcePath)?.edits).toHaveLength(MAX_EDITS_PER_BATCH);
    const overflow = reducer(state, {
      type: 'STAGE',
      input: {
        sourcePath,
        dialect: 'v2',
        intent: 'create-model',
        path: ['providers', 'gateway', 'models', 'too-many'],
        op: 'set',
        value: {},
        label: 'too many',
      },
    });
    expect(batchFor(overflow, sourcePath)?.edits).toHaveLength(MAX_EDITS_PER_BATCH);
    expect(overflow.notice?.kind).toBe('error');
    expect(overflow.notice?.text).toContain('64');
    const replaced = reducer(overflow, {
      type: 'STAGE',
      input: {
        sourcePath,
        dialect: 'v2',
        intent: 'create-model',
        path: ['providers', 'gateway', 'models', 'bulk-0'],
        op: 'set',
        value: { name: 'Updated' },
        label: 'updated',
      },
    });
    expect(batchFor(replaced, sourcePath)?.edits).toHaveLength(MAX_EDITS_PER_BATCH);
  });
});
