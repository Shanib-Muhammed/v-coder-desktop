import { highlight } from './markdown.js';
import { icon } from './icons.js';

const LANG_BY_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts',
  py: 'py', rs: 'rs', go: 'go', sh: 'sh', bash: 'sh', zsh: 'sh',
  css: 'css', scss: 'css', less: 'css', json: 'json', jsonc: 'json',
  html: 'html', htm: 'html', md: 'md', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', sql: 'sql', java: 'java', c: 'c', h: 'c', cpp: 'cpp',
  cs: 'cs', rb: 'rb', php: 'php', swift: 'swift', kt: 'kt', vue: 'html',
};

export function langOf(file) {
  const ext = String(file || '').split('.').pop().toLowerCase();
  return LANG_BY_EXT[ext] || 'text';
}

export class CodeEditor {
  constructor(host, { onChange, onSave } = {}) {
    this.host = host;
    this.onChange = onChange || (() => {});
    this.onSave = onSave || (() => {});
    this.value = '';
    this.lang = 'text';
    this.build();
  }

  build() {
    this.host.innerHTML = `
      <div class="editor-gutter"><div class="gutter-inner"></div></div>
      <div class="editor-scroll">
        <pre class="editor-code"><code></code></pre>
        <textarea class="editor-input" spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off"></textarea>
      </div>`;
    this.gutter = this.host.querySelector('.gutter-inner');
    this.scroll = this.host.querySelector('.editor-scroll');
    this.pre = this.host.querySelector('.editor-code code');
    this.input = this.host.querySelector('.editor-input');

    this.input.addEventListener('input', () => {
      this.value = this.input.value;
      this.paint();
      this.onChange(this.value);
    });
    this.scroll.addEventListener('scroll', () => {
      this.gutter.style.transform = `translateY(${-this.scroll.scrollTop}px)`;
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en } = this.input;
        this.input.setRangeText('  ', s, en, 'end');
        this.value = this.input.value;
        this.paint();
        this.onChange(this.value);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.onSave(this.value);
      }
      if (e.key === 'Enter') {
        const { selectionStart: s } = this.input;
        const lineStart = this.value.lastIndexOf('\n', s - 1) + 1;
        const line = this.value.slice(lineStart, s);
        const indent = (line.match(/^[\t ]*/) || [''])[0];
        const extra = /[{([]\s*$/.test(line) ? '  ' : '';
        if (indent || extra) {
          e.preventDefault();
          const ins = '\n' + indent + extra;
          this.input.setRangeText(ins, s, this.input.selectionEnd, 'end');
          this.value = this.input.value;
          this.paint();
          this.onChange(this.value);
        }
      }
    });
  }

  paint() {
    this.pre.innerHTML = highlight(this.value, this.lang) + '\n';
    const lines = this.value.split('\n').length;
    const nums = [];
    for (let i = 1; i <= lines; i++) nums.push(i);
    this.gutter.innerHTML = nums.join('<br />');
    const h = this.pre.parentElement.scrollHeight;
    this.input.style.height = Math.max(h, this.scroll.clientHeight) + 'px';
    this.host.querySelector('.editor-code').style.minHeight = '100%';
  }

  open(path, text) {
    this.lang = langOf(path);
    this.value = text;
    this.input.value = text;
    this.paint();
    this.scroll.scrollTop = 0;
    this.gutter.style.transform = 'translateY(0)';
  }

  getValue() {
    return this.input.value;
  }

  focus() {
    this.input.focus();
  }

  resize() {
    this.paint();
  }
}

export function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const map = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    ts: 'ts', tsx: 'ts', json: 'json', md: 'md',
    css: 'css', scss: 'css', html: 'html', py: 'py',
  };
  return map[ext] || 'file';
}
