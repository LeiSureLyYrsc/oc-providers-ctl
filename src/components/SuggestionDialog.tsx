import type { CatalogResult, ModelCandidate, ModelEntry, ProviderEntry } from '../ipc';
import type { AdoptionSelection } from '../lib/adoption';
import type { ConcreteDialect } from '../lib/paths';
import { CandidatePicker } from './CandidatePicker';
import { Dialog } from './Dialog';

interface SuggestionDialogProps {
  open: boolean;
  provider: ProviderEntry;
  model: ModelEntry | null;
  writable: boolean;
  catalog: CatalogResult | null;
  catalogLoading: boolean;
  onRefreshCatalog: () => Promise<CatalogResult | null>;
  onClose: () => void;
  onSearch: (query: string) => Promise<ModelCandidate[]>;
  onAdopt: (candidate: ModelCandidate, selection: AdoptionSelection) => void;
}

/**
 * External completion: check the catalog, confirm per field, then stage the
 * chosen leaves as drafts. Nothing is written to disk without the usual preview.
 */
export function SuggestionDialog({
  open,
  provider,
  model,
  writable,
  catalog,
  catalogLoading,
  onRefreshCatalog,
  onClose,
  onSearch,
  onAdopt,
}: SuggestionDialogProps) {
  if (!open) return null;

  const dialect: ConcreteDialect = provider.dialect === 'v1' ? 'v1' : 'v2';
  const initialQuery = model ? model.requestId || model.id : provider.id;

  return (
    <Dialog
      open
      title="查询模型资料"
      subtitle={model ? `${model.id} · 确认后进入待保存` : provider.id}
      onClose={onClose}
      wide
      actions={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <CandidatePicker
        providerId={provider.id}
        dialect={dialect}
        baseline={
          model
            ? {
                name: model.name,
                context: model.context,
                input: model.input,
                output: model.output,
                reasoning: model.reasoning,
              }
            : null
        }
        initialQuery={initialQuery}
        catalog={catalog}
        catalogLoading={catalogLoading}
        onRefreshCatalog={onRefreshCatalog}
        onSearch={onSearch}
        onAdopt={onAdopt}
        allowAdopt={writable}
      />
    </Dialog>
  );
}
