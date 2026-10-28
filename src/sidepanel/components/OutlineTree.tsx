import { useState, type ReactElement } from 'react';
import type { OutlineNode, PageSummary, SummarySection } from '../../shared/types';
import { truncate } from '../../shared/utils';

interface OutlineTreeProps {
  nodes: OutlineNode[];
  summary: PageSummary | null;
  onJump: (anchor: string) => void;
}

interface OutlineItemProps {
  node: OutlineNode;
  summaryByNode: Map<string, SummarySection>;
  onJump: (anchor: string) => void;
}

function OutlineItem({ node, summaryByNode, onJump }: OutlineItemProps) {
  const [open, setOpen] = useState(true);
  const summary = summaryByNode.get(node.id);
  const hasBody = Boolean(
    summary?.summary ||
      summary?.keyPoints.length ||
      summary?.questions.length ||
      node.text.trim() ||
      node.children.length,
  );

  return (
    <div className={`outline-item outline-level-${Math.min(6, node.level)}`}>
      <div className="outline-row">
        {node.children.length > 0 ? (
          <button
            type="button"
            className="outline-toggle"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? '折叠子章节' : '展开子章节'}
          >
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className="outline-dot" aria-hidden="true" />
        )}
        <button type="button" className="outline-title" onClick={() => onJump(node.anchor)}>
          {node.title}
        </button>
        {summary?.keyPoints.length ? <span className="outline-badge">{summary.keyPoints.length}</span> : null}
      </div>
      {open && hasBody ? (
        <div className="outline-body">
          {summary?.summary ? <p className="outline-summary">{summary.summary}</p> : null}
          {summary?.keyPoints.length ? (
            <ul className="outline-points">
              {summary.keyPoints.map((point, index) => (
                <li key={`${node.id}-point-${index}`}>{point}</li>
              ))}
            </ul>
          ) : null}
          {summary?.questions.length ? (
            <div className="outline-questions">
              <span className="outline-question-label">待思考</span>
              {summary.questions.map((question, index) => (
                <p key={`${node.id}-question-${index}`}>{question}</p>
              ))}
            </div>
          ) : null}
          {!summary?.summary && !summary?.keyPoints.length && node.text.trim() ? (
            <p className="outline-excerpt">{truncate(node.text.trim(), 360)}</p>
          ) : null}
          {node.children.map((child) => (
            <OutlineItem
              key={child.id}
              node={child}
              summaryByNode={summaryByNode}
              onJump={onJump}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function OutlineTree({ nodes, summary, onJump }: OutlineTreeProps): ReactElement {
  if (nodes.length === 0) {
    return <p className="muted">没有识别到标题层级。</p>;
  }
  const summaryByNode = new Map((summary?.sections ?? []).map((section) => [section.outlineId, section]));
  return (
    <div className="outline-tree">
      {nodes.map((node) => (
        <OutlineItem
          key={node.id}
          node={node}
          summaryByNode={summaryByNode}
          onJump={onJump}
        />
      ))}
    </div>
  );
}
