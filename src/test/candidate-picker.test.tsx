import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CandidatePicker } from '../components/CandidatePicker';
import type { CatalogResult, ModelCandidate } from '../ipc';
import { makeCandidate } from './fixtures';

const CATALOG: CatalogResult = {
  modelCount: 3,
  fetchedAt: '2026-11-17T09:40:00Z',
  stale: false,
  warnings: [],
};

const BASELINE = {
  name: null,
  context: null,
  input: null,
  output: null,
  reasoning: null,
};

function renderPicker(
  onSearch: (query: string) => Promise<ModelCandidate[]>,
  initialQuery: string,
) {
  return render(
    <CandidatePicker
      providerId="gateway"
      dialect="v2"
      baseline={BASELINE}
      initialQuery={initialQuery}
      catalog={CATALOG}
      catalogLoading={false}
      onRefreshCatalog={async () => CATALOG}
      onSearch={onSearch}
      onAdopt={vi.fn()}
    />,
  );
}

describe('candidate picker request sequencing', () => {
  it('ignores a stale reply after the target model changes', async () => {
    const deferred: Array<(value: ModelCandidate[]) => void> = [];
    const onSearch = vi.fn(
      () =>
        new Promise<ModelCandidate[]>((resolve) => {
          deferred.push(resolve);
        }),
    );
    const { rerender } = renderPicker(onSearch, 'first-model');

    // Retarget while the first search is still in flight.
    rerender(
      <CandidatePicker
        providerId="gateway"
        dialect="v2"
        baseline={BASELINE}
        initialQuery="second-model"
        catalog={CATALOG}
        catalogLoading={false}
        onRefreshCatalog={async () => CATALOG}
        onSearch={onSearch}
        onAdopt={vi.fn()}
      />,
    );

    expect(onSearch).toHaveBeenCalledTimes(2);
    // Resolve the new request first, then the stale one.
    deferred[1]([makeCandidate({ id: 'second-model', name: 'Second' })]);
    await waitFor(() => expect(screen.getByText('second-model')).toBeInTheDocument());
    deferred[0]([makeCandidate({ id: 'first-model', name: 'First' })]);

    await waitFor(() => expect(screen.queryByText('first-model')).toBeNull());
    expect(screen.getByText('second-model')).toBeInTheDocument();
  });

  it('keeps a stale reply from landing after unmount', async () => {
    const deferred: Array<(value: ModelCandidate[]) => void> = [];
    const onSearch = vi.fn(
      () =>
        new Promise<ModelCandidate[]>((resolve) => {
          deferred.push(resolve);
        }),
    );
    const { unmount } = renderPicker(onSearch, 'only-model');
    unmount();
    // Resolving after unmount must not throw or touch state.
    expect(() => deferred[0]([makeCandidate()])).not.toThrow();
  });

  it('shows the provider id and models.dev origin for each candidate', async () => {
    const user = userEvent.setup();
    renderPicker(
      async () => [makeCandidate({ providerId: 'moonshot', id: 'kimi-k2' })],
      'kimi',
    );
    await screen.findByText('kimi-k2');
    await user.click(screen.getByText('kimi-k2'));
    expect(screen.getByText(/来源 providerId：moonshot/)).toBeInTheDocument();
    expect(screen.getByText(/models\.dev/)).toBeInTheDocument();
    expect(screen.getByText(/不是同一家/)).toBeInTheDocument();
  });

  it('offers 填入 for empty fields and 覆盖 only for existing values', async () => {
    render(
      <CandidatePicker
        providerId="gateway"
        dialect="v2"
        baseline={{ ...BASELINE, context: 1000 }}
        initialQuery="model"
        catalog={CATALOG}
        catalogLoading={false}
        onRefreshCatalog={async () => CATALOG}
        onSearch={async () => [
          makeCandidate({ id: 'model', name: 'Model', context: 2000, input: 500 }),
        ]}
        onAdopt={vi.fn()}
      />,
    );
    await screen.findByText('model');
    expect(await screen.findByLabelText('覆盖上下文')).toBeInTheDocument();
    expect(screen.getByLabelText('填入输入上限')).toBeInTheDocument();
    expect(screen.queryByLabelText('覆盖输入上限')).toBeNull();
  });
});
