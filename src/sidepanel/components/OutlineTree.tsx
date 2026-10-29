import { useState, type ReactElement } from 'react';
import type { DialogueInsight, OutlineNode, PageSummary, SummarySection } from '../../shared/types';
import { truncate } from '../../shared/utils';

interface OutlineTreeProps {
  nodes: OutlineNode[];
  summary: PageSummary | null;
  onJump: (anchor: string) => void;
  onSummarizeSection?: (node: OutlineNode) => void;
  summarizingId?: string | null;
}

interface OutlineItemProps {
  node: OutlineNode;
  summaryByNode: Map<string, SummarySection>;
  insightsByNode: Map<string, DialogueInsight[]>;
  onJump: (anchor: string) => void;
  onSummarizeSection?: (node: OutlineNode) => void;
  summarizingId?: string | null;
}

function OutlineItem({
  node,
  summaryByNode,
  insightsByNode,
  onJump,
  onSummarizeSection,
  summarizingId,
}: OutlineItemProps) {
  const [open, setOpen] = useState(true);
  const summary = summaryByNode.get(node.id);
  const insights = insightsByNode.get(node.id) ?? [];
  const hasBody = Boolean(
    summary?.summary ||
      summary?.keyPoints.length ||
      summary?.questions.length ||
      insights.length ||
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
        {onSummarizeSection && (node.text.trim() || node.page !== undefined) ? (
          <button
            type="button"
            className="outline-summarize-button"
            onClick={(event) => {
              event.stopPropagation();
              onSummarizeSection(node);
            }}
            disabled={Boolean(summarizingId)}
            title={
              node.text.trim()
                ? '只把这一节正文发给模型，生成这一节的笔记'
                : '这一节没有文字层；点击后先实时 OCR 页码范围，再生成笔记'
            }
          >
            {summarizingId === node.id
              ? '总结中…'
              : !node.text.trim()
                ? 'OCR 并总结'
                : summary
                  ? '重新总结'
                  : '总结本节'}
          </button>
        ) : null}
        {summary?.keyPoints.length ? <span className="outline-badge">{summary.keyPoints.length}</span> : null}
        {insights.length ? <span className="outline-badge outline-insight-badge">{insights.length} 讨论</span> : null}
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
          {insights.length ? (
            <div className="outline-insights">
              <span className="outline-question-label">讨论沉淀</span>
              {insights.map((insight, index) => (
                <div className="outline-insight" key={`${node.id}-insight-${index}`}>
                  <strong>{insight.question}</strong>
                  <p>{insight.insight}</p>
                  {insight.evidence.length > 0 ? (
                    <span>依据：{insight.evidence.join('；')}</span>
                  ) : null}
                </div>
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
              insightsByNode={insightsByNode}
              onJump={onJump}
              onSummarizeSection={onSummarizeSection}
              summarizingId={summarizingId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function OutlineTree({
  nodes,
  summary,
  onJump,
  onSummarizeSection,
  summarizingId,
}: OutlineTreeProps): ReactElement {
  if (nodes.length === 0) {
    return <p className="muted">没有识别到标题层级。</p>;
  }
  const summaryByNode = new Map((summary?.sections ?? []).map((section) => [section.outlineId, section]));
  const insightsByNode = new Map<string, DialogueInsight[]>();
  for (const insight of summary?.dialogueInsights ?? []) {
    if (!insight.outlineId) continue;
    const current = insightsByNode.get(insight.outlineId) ?? [];
    current.push(insight);
    insightsByNode.set(insight.outlineId, current);
  }
  return (
    <div className="outline-tree">
      {nodes.map((node) => (
        <OutlineItem
          key={node.id}
          node={node}
          summaryByNode={summaryByNode}
          insightsByNode={insightsByNode}
          onJump={onJump}
          onSummarizeSection={onSummarizeSection}
          summarizingId={summarizingId}
        />
      ))}
    </div>
  );
}
