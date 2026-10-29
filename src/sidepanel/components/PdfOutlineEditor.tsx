import { useState, type ReactElement } from 'react';
import { parsePdfOutlineInput, type PdfManualSection } from '../../shared/pdf';
import { asErrorMessage } from '../../shared/utils';

interface PdfOutlineEditorProps {
  pageCount: number;
  needsOcr?: boolean;
  onApply: (entries: PdfManualSection[]) => void;
}

export default function PdfOutlineEditor({
  pageCount,
  needsOcr = false,
  onApply,
}: PdfOutlineEditorProps): ReactElement {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const apply = () => {
    const parsed = parsePdfOutlineInput(value, pageCount);
    if (parsed.error || !parsed.entries) {
      setError(parsed.error ?? '目录格式不正确。');
      return;
    }
    try {
      onApply(parsed.entries);
      setError('');
    } catch (applyError) {
      setError(asErrorMessage(applyError));
    }
  };

  return (
    <section className="pdf-outline-editor">
      <div className="section-heading">
        <span>补一份 PDF 目录</span>
        <span>共 {pageCount} 页</span>
      </div>
      <p className="muted">
        {needsOcr
          ? '这是扫描版 PDF，没有文字层。请按小节填写页码范围；之后总结或提问时只 OCR 当前小节，不会上传整本文件。'
          : '这个 PDF 没有可读取的书签目录。请按小节填写页码范围，每行一节，格式为“标题 | 起始页-结束页”。页码从 PDF 阅读器显示的第 1 页开始，不是印刷页码。'}
      </p>
      <textarea
        className="pdf-outline-textarea"
        rows={6}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (error) setError('');
        }}
        placeholder={'第一章 引言 | 1-4\n1.1 研究背景 | 2-3\n第二章 方法 | 5-9'}
        aria-label="PDF 小节目录"
      />
      {error ? <div className="error-box">{error}</div> : null}
      <div className="pdf-outline-actions">
        <button
          type="button"
          className="primary-button"
          onClick={apply}
          disabled={!value.trim() || pageCount < 1}
        >
          应用目录
        </button>
        <span className="muted">
          {needsOcr ? '按需 OCR 当前小节，不上传整份 PDF。' : '只解析文字层，不上传整份 PDF。'}
        </span>
      </div>
    </section>
  );
}
