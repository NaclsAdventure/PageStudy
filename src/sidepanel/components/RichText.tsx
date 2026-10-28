import type { ReactNode } from 'react';

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'divider' };

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'divider' });
      index += 1;
      continue;
    }
    if (trimmed.startsWith('> ')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('> ')) {
        quote.push(lines[index].trim().slice(2));
        index += 1;
      }
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }
    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const match = isOrdered ? current.match(/^\d+[.)]\s+(.+)$/) : current.match(/^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current) break;
      if (
        current.startsWith('```') ||
        /^(#{1,4})\s+/.test(current) ||
        /^[-*+]\s+/.test(current) ||
        /^\d+[.)]\s+/.test(current) ||
        current.startsWith('> ') ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export default function RichText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="rich-text">
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        if (block.type === 'code') {
          return (
            <pre key={key} className="rich-code">
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'heading') {
          const Tag = (`h${Math.min(4, block.level + 2)}`) as 'h3' | 'h4' | 'h5' | 'h6';
          return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
        }
        if (block.type === 'divider') return <hr key={key} />;
        if (block.type === 'quote') {
          return (
            <blockquote key={key}>
              {block.text.split('\n').map((line, lineIndex) => (
                <p key={`${key}-q-${lineIndex}`}>{renderInline(line, `${key}-q-${lineIndex}`)}</p>
              ))}
            </blockquote>
          );
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-li-${itemIndex}`}>{renderInline(item, `${key}-li-${itemIndex}`)}</li>
              ))}
            </ListTag>
          );
        }
        return <p key={key}>{renderInline(block.text, key)}</p>;
      })}
    </div>
  );
}
