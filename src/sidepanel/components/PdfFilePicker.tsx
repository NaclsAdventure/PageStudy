import type { ChangeEvent, ReactElement } from 'react';

interface PdfFilePickerProps {
  busy: boolean;
  onFile: (file: File) => void;
}

/**
 * 浏览器默认禁止扩展直接读取 file://，用户也无法通过页面脚本打开系统文件选择器。
 * 这个入口用原生 input 读取用户主动选择的 PDF，和直接抓取公网 PDF 走同一套解析器。
 */
export default function PdfFilePicker({ busy, onFile }: PdfFilePickerProps): ReactElement {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 允许用户重新选择同一个文件。
    event.target.value = '';
    if (file) onFile(file);
  };

  return (
    <section className="pdf-file-picker">
      <div className="section-heading">
        <span>读取本地 PDF</span>
        <span>只在扩展内解析</span>
      </div>
      <p className="muted">
        浏览器默认不允许扩展直接读取 <code>file://</code>。请选择刚才打开的 PDF；文件不会上传，
        解析方式与网页 PDF 相同。
      </p>
      <label className={`primary-button pdf-file-button${busy ? ' is-busy' : ''}`}>
        {busy ? '正在读取…' : '选择本地 PDF'}
        <input
          className="pdf-file-input"
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          onChange={handleChange}
        />
      </label>
    </section>
  );
}
