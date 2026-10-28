// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { extractOutline, findContentRoot } from './extract';

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
