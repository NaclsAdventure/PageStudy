// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPageContext, extractBlocks, extractImages, extractOutline, findContentRoot } from './extract';

beforeAll(() => {
  // jsdom 不做布局，getClientRects 永远为空；这里模拟“元素已渲染”。
  Object.defineProperty(Element.prototype, 'getClientRects', {
    configurable: true,
    value() {
      return [{ x: 0, y: 0, width: 600, height: 20, top: 0, left: 0, bottom: 20, right: 600 }];
    },
  });
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, width: 600, height: 20, top: 0, left: 0, bottom: 20, right: 600 };
    },
  });
});

function renderArticle(): void {
  document.title = '测试文章';
  document.documentElement.lang = 'zh-CN';
  document.body.innerHTML = `
    <nav><h2>导航</h2><a href="/">首页</a></nav>
    <article>
      <h1 id="intro">引言</h1>
      <p>这是引言的正文，长度足够被识别为正文内容，用于测试大纲提取。</p>
      <aside><h2>侧边推荐</h2><p>不应该出现在大纲里。</p></aside>
      <h2>核心概念</h2>
      <p>核心概念的解释，包含足够多的正文文字以通过正文根节点筛选。</p>
      <h3>子概念</h3>
      <p>子概念的细节说明，继续补充一些文字，让文章整体长度超过八十个字符。</p>
      <figure>
        <img src="/diagram.png" alt="流程图" width="600" height="300" />
        <figcaption>图 1：概念之间的关系</figcaption>
      </figure>
      <h2>结论</h2>
      <p>文章结论。</p>
    </article>
    <footer><h2>版权</h2></footer>
  `;
}

describe('findContentRoot', () => {
  it('优先选择文章正文而不是导航和页脚', () => {
    renderArticle();
    const root = findContentRoot();
    expect(root.tagName).toBe('ARTICLE');
    expect(root.textContent).toContain('核心概念');
    expect(root.textContent).not.toContain('首页');
  });
});

describe('extractBlocks', () => {
  it('按文档顺序保留标题、正文与图片所在章节', () => {
    renderArticle();
    const root = findContentRoot();
    const blocks = extractBlocks(root);
    expect(blocks.some((block) => block.kind === 'heading' && block.text === '引言')).toBe(true);
    expect(blocks.some((block) => block.text.includes('核心概念的解释'))).toBe(true);
    expect(blocks.some((block) => block.text.includes('不应该出现在大纲里'))).toBe(false);
    expect(blocks.find((block) => block.text.includes('核心概念的解释'))?.headingPath).toEqual([
      '引言',
      '核心概念',
    ]);
    expect(blocks.every((block) => block.anchor)).toBe(true);
  });
});

describe('extractImages', () => {
  it('提取正文图片、图注与所在章节', () => {
    renderArticle();
    const root = findContentRoot();
    const images = extractImages(root);
    expect(images).toHaveLength(1);
    expect(images[0].src).toContain('/diagram.png');
    expect(images[0].caption).toBe('图 1：概念之间的关系');
    expect(images[0].anchor).toBeTruthy();
    expect(images[0].headingPath).toEqual(['引言', '核心概念', '子概念']);
  });

  it('过滤没有尺寸的图标', () => {
    document.body.innerHTML = `
      <article>
        <p>正文内容足够长，用来让页面被识别为文章正文，而不是导航或页脚区域。</p>
        <img src="/icon.png" alt="icon" width="16" height="16" />
      </article>
    `;
    const images = extractImages(findContentRoot());
    expect(images).toHaveLength(0);
  });
});

describe('buildPageContext', () => {
  it('一次返回大纲、全文块、图片和 token 估算', () => {
    renderArticle();
    const page = buildPageContext();
    expect(page.title).toBeTruthy();
    expect(page.outline.length).toBeGreaterThan(0);
    expect(page.blocks?.length).toBeGreaterThan(0);
    expect(page.images).toHaveLength(1);
    expect(page.images?.[0].caption).toContain('概念之间的关系');
    expect(page.tokenEstimate).toBeGreaterThan(0);
    expect(page.extractionQuality).toBeTruthy();
    expect(page.contentHash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('extractOutline', () => {
  it('按标题层级构建大纲树并排除 UI 区域', () => {
    renderArticle();
    const outline = extractOutline(findContentRoot());
    expect(outline).toHaveLength(1);
    expect(outline[0].title).toBe('引言');
    expect(outline[0].anchor).toBe('intro');
    expect(outline[0].text).toContain('这是引言的正文');
    expect(outline[0].text).not.toContain('不应该出现在大纲里');

    expect(outline[0].children.map((node) => node.title)).toEqual(['核心概念', '结论']);
    const concepts = outline[0].children[0];
    expect(concepts.text).toContain('核心概念的解释');
    expect(concepts.children.map((node) => node.title)).toEqual(['子概念']);
    expect(concepts.children[0].text).toContain('子概念的细节说明');
  });

  it('同一层级连续标题会平铺，不会错误嵌套', () => {
    renderArticle();
    const outline = extractOutline(findContentRoot());
    expect(outline[0].children[1].children).toHaveLength(0);
  });

  it('没有标题时回退为整页根节点', () => {
    document.body.innerHTML = '<main><p>只有正文，没有任何标题，但仍然需要可以记录。</p></main>';
    const outline = extractOutline(findContentRoot());
    expect(outline).toHaveLength(1);
    expect(outline[0].id).toBe('ps-outline-root');
    expect(outline[0].level).toBe(1);
  });
});
