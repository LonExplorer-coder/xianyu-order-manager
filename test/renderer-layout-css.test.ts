// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/renderer/styles.css'),
  'utf8',
);

describe('渲染布局约束', () => {
  let style: HTMLStyleElement;

  beforeAll(() => {
    style = document.createElement('style');
    style.textContent = stylesheet;
    document.head.append(style);
  });

  afterAll(() => {
    style.remove();
  });

  it('为订单总表相邻表头保留与数据列一致的横向间距', () => {
    const frame = document.createElement('div');
    frame.className = 'table-frame';
    frame.innerHTML = `
      <table>
        <thead><tr><th>数量1</th><th>商品2</th></tr></thead>
      </table>
    `;
    document.body.append(frame);

    const firstHeader = frame.querySelector('th');
    expect(firstHeader).not.toBeNull();
    expect(getComputedStyle(firstHeader!).paddingRight).toBe('18px');

    frame.remove();
  });

  it('主工作区只负责纵向滚动', () => {
    const workspace = document.createElement('main');
    workspace.className = 'workspace';
    document.body.append(workspace);

    expect(getComputedStyle(workspace).overflowX).toBe('hidden');
    expect(getComputedStyle(workspace).overflowY).toBe('auto');

    workspace.remove();
  });

  it('把超宽导出预览限制在弹窗内部并禁止遮罩层横向滚动', () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'order-export-backdrop';
    backdrop.innerHTML = `
      <form class="order-export-dialog">
        <section class="order-export-dialog__preview">
          <div class="order-table-wrap"><table><tr><td>预览</td></tr></table></div>
        </section>
      </form>
    `;
    document.body.append(backdrop);

    const dialog = backdrop.querySelector('.order-export-dialog');
    const preview = backdrop.querySelector('.order-table-wrap');
    expect(dialog).not.toBeNull();
    expect(preview).not.toBeNull();
    expect(getComputedStyle(backdrop).gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(getComputedStyle(backdrop).overflowX).toBe('hidden');
    expect(getComputedStyle(dialog!).minWidth).toBe('0px');
    expect(getComputedStyle(preview!).overflowX).toBe('auto');

    backdrop.remove();
  });
});
