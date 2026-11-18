import type { LineageNode } from '../lib/lineage';
import { Badge } from './Badge';

interface LineageProps {
  nodes: LineageNode[];
  caption?: string;
}

export function Lineage({ nodes, caption }: LineageProps) {
  return (
    <section className="lineage-block" aria-label={caption ?? '来源血统'}>
      {caption ? <div className="eyebrow lineage-caption">{caption}</div> : null}
      <ol className="lineage">
        {nodes.map((node) => (
          <li className="lineage-node" data-tone={node.tone} key={node.key}>
            <span className="lineage-dot" aria-hidden="true" />
            <div className="lineage-head">
              <span className="lineage-label mono">{node.label}</span>
              {node.tag ? (
                <Badge tone={node.tone === 'draft' ? 'draft' : node.tone === 'danger' ? 'danger' : 'accent'} className="lineage-tag">
                  {node.tag}
                </Badge>
              ) : null}
            </div>
            <div className={`lineage-value ${node.targetPath ? 'mono' : ''}`}>{node.value}</div>
            {node.meta ? <div className="lineage-meta">{node.meta}</div> : null}
            {node.targetPath ? <div className="lineage-path mono">{node.targetPath}</div> : null}
          </li>
        ))}
      </ol>
      <div className="lineage-legend">
        <span className="legend-item" data-tone="read"><i />读取自文档</span>
        <span className="legend-item" data-tone="suggestion"><i />目录建议</span>
        <span className="legend-item" data-tone="draft"><i />未应用草稿</span>
      </div>
    </section>
  );
}
