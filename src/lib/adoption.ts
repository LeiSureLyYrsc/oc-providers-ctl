import type { ModelCandidate, ModelEntry, ProviderEntry } from '../ipc';
import type { ConcreteDialect } from './paths';
import { locateModel, modelLeafPath } from './paths';
import { reasoningAdoptionValue } from './reasoning';

export interface AdoptionEdit {
  path: string[];
  value: unknown;
  label: string;
}

/**
 * Build the leaf-only edits used when a user adopts a local catalog candidate.
 * Request ids (`requestId` / V2 `modelID`) and variants are never written.
 */
export function candidateAdoptionEdits(
  dialect: ConcreteDialect,
  provider: ProviderEntry,
  model: ModelEntry,
  candidate: ModelCandidate,
  includeReasoning: boolean,
): AdoptionEdit[] {
  const locator = locateModel(provider, model);
  const edits: AdoptionEdit[] = [];
  if (model.name === null && candidate.name.trim()) {
    edits.push({
      path: modelLeafPath(dialect, locator, 'name'),
      value: candidate.name,
      label: '显示名（建议）',
    });
  }
  if (candidate.context !== null) {
    edits.push({
      path: modelLeafPath(dialect, locator, 'context'),
      value: candidate.context,
      label: '上下文窗口（建议）',
    });
  }
  if (candidate.input !== null) {
    edits.push({
      path: modelLeafPath(dialect, locator, 'input'),
      value: candidate.input,
      label: '输入上限（建议）',
    });
  }
  if (candidate.output !== null) {
    edits.push({
      path: modelLeafPath(dialect, locator, 'output'),
      value: candidate.output,
      label: '输出上限（建议）',
    });
  }
  if (includeReasoning && candidate.reasoning !== null) {
    const adopted = reasoningAdoptionValue(dialect, candidate.reasoning);
    if (adopted !== null) {
      edits.push({
        path: modelLeafPath(dialect, locator, 'reasoning'),
        value: adopted,
        label: dialect === 'v1' ? '推理开关（建议）' : '推理对象（建议）',
      });
    }
  }
  return edits;
}
