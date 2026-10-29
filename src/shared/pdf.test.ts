import { describe, expect, it } from 'vitest';
import {
  applyPdfManualOutline,
  applyPdfSectionOcr,
  buildPdfPageContext,
  isPdfUrl,
  parsePdfOutlineInput,
  type PdfTextLine,
} from './pdf';

const lines: PdfTextLine[] = [
  { page: 1, y: 700, height: 12, text: '第一章 引言' },
  { page: 1, y: 680, height: 12, text: '这是引言的正文。' },
  { page: 2, y: 700, height: 12, text: '第二章 方法' },
  { page: 2, y: 680, height: 12, text: '这是方法的正文。' },
  { page: 3, y: 680, height: 12, text: '第三章的补充文字。' },
];

function build(bookmarks = false) {
  return buildPdfPageContext({
    url: 'https://example.com/paper.pdf',
    title: '测试论文',
    author: '作者',
    lines,
    pageCount: 3,
    bookmarks: bookmarks
      ? [
          { title: '第一章 引言', page: 1, level: 1, y: 720 },
          { title: '第二章 方法', page: 2, level: 1, y: 720 },
        ]
      : [],
  });
}

describe('buildPdfPageContext', () => {
  it('按书签切分小节并保留页码', () => {
    const page = build(true);
    expect(page.sourceType).toBe('pdf');
    expect(page.pdfPageCount).toBe(3);
    expect(page.outline.map((node) => node.title)).toEqual(['第一章 引言', '第二章 方法']);
    expect(page.outline[0].page).toBe(1);
    expect(page.outline[0].text).toContain('这是引言的正文。');
    expect(page.outline[1].text).toContain('这是方法的正文。');
    expect((page.blocks ?? []).some((block) => block.kind === 'heading')).toBe(true);
  });

  it('同一页有多个书签时使用唯一锚点', () => {
    const page = buildPdfPageContext({
      url: 'https://example.com/same-page.pdf',
      title: '同页多节',
      pageCount: 1,
      lines: [
        { page: 1, y: 700, height: 12, text: '第一节' },
        { page: 1, y: 680, height: 12, text: '第一节正文' },
        { page: 1, y: 600, height: 12, text: '第二节' },
        { page: 1, y: 580, height: 12, text: '第二节正文' },
      ],
      bookmarks: [
        { title: '第一节', page: 1, level: 1, y: 700 },
        { title: '第二节', page: 1, level: 1, y: 600 },
      ],
    });
    expect(page.outline).toHaveLength(2);
    expect(new Set(page.outline.map((node) => node.anchor)).size).toBe(2);
    expect(page.outline[0].text).not.toContain('第二节正文');
    expect(page.outline[1].text).toContain('第二节正文');
  });

  it('没有书签时不伪造目录，只保留按页文本', () => {
    const page = build(false);
    expect(page.outline).toEqual([]);
    expect((page.blocks ?? []).map((block) => block.page)).toEqual([1, 2, 3]);
    expect(page.blocks?.[0].text).toContain('第一章 引言');
  });

  it('扫描件没有文字层时明确报错', () => {
    expect(() =>
      buildPdfPageContext({
        url: 'https://example.com/scan.pdf',
        title: '扫描件',
        lines: [],
        pageCount: 1,
      }),
    ).toThrow('没有可提取的文字层');
  });
});

describe('parsePdfOutlineInput', () => {
  it('解析标题与页码范围', () => {
    const result = parsePdfOutlineInput('第一章 | 1-2\n第二章｜3', 3);
    expect(result.error).toBeUndefined();
    expect(result.entries).toEqual([
      { title: '第一章', startPage: 1, endPage: 2 },
      { title: '第二章', startPage: 3, endPage: 3 },
    ]);
  });

  it('拒绝格式、越界和重叠', () => {
    expect(parsePdfOutlineInput('第一章 1-2', 3).error).toContain('格式');
    expect(parsePdfOutlineInput('第一章 | 0-2', 3).error).toContain('页码范围无效');
    expect(parsePdfOutlineInput('第一章 | 1-2\n第二章 | 2-3', 3).error).toContain('重叠');
  });
});

describe('applyPdfManualOutline', () => {
  it('把用户页码范围变成真实小节，并更新内容指纹', () => {
    const page = build(false);
    const next = applyPdfManualOutline(page, [
      { title: '第一部分', startPage: 1, endPage: 1 },
      { title: '第二部分', startPage: 2, endPage: 3 },
    ]);
    expect(next.outline.map((node) => node.title)).toEqual(['第一部分', '第二部分']);
    expect(next.outline[0].text).toContain('这是引言的正文。');
    expect(next.outline[1].text).toContain('这是方法的正文。');
    expect(next.outline[1].text).toContain('第三章的补充文字。');
    expect(next.contentHash).not.toBe(page.contentHash);
    expect((next.blocks ?? []).some((block) => block.kind === 'heading')).toBe(true);
  });

  it('页码范围里没有文字时拒绝生成空小节', () => {
    const page = build(false);
    expect(() =>
      applyPdfManualOutline(page, [{ title: '空白', startPage: 9, endPage: 9 }]),
    ).toThrow('没有可提取的文字');
  });
});

describe('扫描版 PDF 的实时 OCR 数据流', () => {
  const scan = () =>
    buildPdfPageContext({
      url: 'file:///C:/books/scan.pdf',
      title: '扫描书',
      lines: [],
      pageCount: 10,
      needsOcr: true,
      bookmarks: [
        { title: '第一章', page: 1, level: 1, y: 700 },
        { title: '第二章', page: 5, level: 1, y: 700 },
      ],
    });

  it('保留没有文字的小节和页码范围', () => {
    const page = scan();
    expect(page.needsOcr).toBe(true);
    expect(page.outline).toHaveLength(2);
    expect(page.outline[0].text).toBe('');
    expect(page.outline[0].pageEnd).toBe(4);
    expect(page.outline[1].pageEnd).toBe(10);
    expect(page.wordCount).toBe(0);
  });

  it('手动目录不会过滤掉扫描版空小节', () => {
    const page = applyPdfManualOutline(scan(), [
      { title: '扫描第一节', startPage: 1, endPage: 2 },
      { title: '扫描第二节', startPage: 3, endPage: 10 },
    ]);
    expect(page.outline).toHaveLength(2);
    expect(page.outline[0].text).toBe('');
    expect(page.outline[0].pageEnd).toBe(2);
  });

  it('OCR 后只填充目标小节并更新指纹', () => {
    const page = scan();
    const next = applyPdfSectionOcr(page, page.outline[0].id, '第一章的识别正文。', [
      { page: 1, text: '第一章的识别正文。' },
    ]);
    expect(next.outline[0].text).toContain('第一章的识别正文');
    expect(next.outline[1].text).toBe('');
    expect(next.contentHash).not.toBe(page.contentHash);
    expect(next.blocks?.some((block) => block.id.endsWith('-ocr'))).toBe(true);
  });
});

describe('isPdfUrl', () => {
  it('识别常见 PDF 直链，不误判普通网页', () => {
    expect(isPdfUrl('https://example.com/a.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/a.pdf?x=1')).toBe(true);
    expect(isPdfUrl('https://example.com/pdf/abc')).toBe(true);
    expect(isPdfUrl('https://example.com/article')).toBe(false);
    expect(isPdfUrl('file:///C:/Users/test/Downloads/%E6%B8%B8%E6%88%8F.pdf')).toBe(true);
    expect(isPdfUrl('file:///C:/Users/test/Downloads/notes.txt')).toBe(false);
  });
});
