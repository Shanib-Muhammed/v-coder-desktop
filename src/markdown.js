/* Minimal, dependency-free markdown renderer + syntax highlighter. */

const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue new class extends super import export from as default async await try catch finally throw typeof instanceof in of this null undefined true false delete void yield static get set',
  ts: 'const let var function return if else for while do switch case break continue new class extends super import export from as default async await try catch finally throw typeof instanceof in of this null undefined true false delete void yield static get set interface type enum implements namespace readonly public private protected declare abstract satisfies keyof infer never unknown any',
  py: 'def class return if elif else for while break continue import from as try except finally raise with lambda pass global nonlocal yield assert del in is not and or None True False async await self match case print',
  rs: 'fn let mut const struct enum impl trait pub use mod crate self super return if else match for while loop break continue unsafe where async await dyn ref move as type static',
  go: 'func package import var const type struct interface map chan go defer return if else for range switch case break continue select nil true false',
  sh: 'if then else elif fi for while do done case esac function return export local echo cd source alias set unset readonly',
  css: '',
  json: 'true false null',
};

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const langKey = (lang) => {
  const l = String(lang || '').toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs', 'javascript'].includes(l)) return 'js';
  if (['ts', 'tsx', 'typescript'].includes(l)) return 'ts';
  if (['py', 'python'].includes(l)) return 'py';
  if (['rs', 'rust'].includes(l)) return 'rs';
  if (['go', 'golang'].includes(l)) return 'go';
  if (['sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'ps1'].includes(l)) return 'sh';
  if (['css', 'scss', 'less'].includes(l)) return 'css';
  if (['json', 'jsonc'].includes(l)) return 'json';
  return null;
};

function highlight(code, lang) {
  const key = langKey(lang);
  const text = String(code);
  if (!key) return esc(text);

  if (key === 'json') {
    return esc(text)
      .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)/g, '<span class="tok-prop">$1</span>$2')
      .replace(/(:\s*)(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, '$1<span class="tok-str">$2</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="tok-kw">$1</span>')
      .replace(/(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])/g, '<span class="tok-num">$1</span>');
  }

  if (key === 'css') {
    return esc(text)
      .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-com">$1</span>')
      .replace(/^(\s*)([.#][\w-]+|[\w-]+)(?=[\s,{:])/gm, '$1<span class="tok-tag">$2</span>')
      .replace(/(--[\w-]+)(\s*:)/g, '<span class="tok-prop">$1</span>$2')
      .replace(/(#[0-9a-fA-F]{3,8}|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg)?\b)/g, '<span class="tok-num">$1</span>');
  }

  // Placeholder pass so we never inject inside strings/comments.
  const holes = [];
  const stash = (html) => {
    let i = holes.length;
    holes.push(html);
    return `\u0000${i}\u0000`;
  };

  let out = esc(text);
  out = out.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*|(^|\n)\s*#[^\n]*/g, (m) => {
    if (m.startsWith('&')) return m;
    return stash('<span class="tok-com">' + m + '</span>');
  });
  out = out.replace(/(&quot;(?:[^&\\]|\\.|&(?!quot;))*?&quot;|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (m) =>
    stash('<span class="tok-str">' + m + '</span>'),
  );

  const words = (KEYWORDS[key] || '').split(' ').filter(Boolean);
  if (words.length) {
    out = out.replace(/\b([A-Za-z_$][\w$]*)\b/g, (m, w) => (words.includes(w) ? `<span class="tok-kw">${w}</span>` : m));
  }
  out = out.replace(/\b(true|false|null|undefined|None|True|False|nil)\b/g, '<span class="tok-kw">$1</span>');
  out = out.replace(/(?<![\w.])(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)(?![\w.])/g, '<span class="tok-num">$1</span>');
  out = out.replace(/@[A-Za-z_]\w*/g, '<span class="tok-dec">$&</span>');

  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => holes[Number(i)]);
  return out;
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code class="inline-code">${c}</code>`);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<em>[$1]</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = /^(https?:|mailto:|#)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

export function renderMarkdown(src) {
  const text = String(src ?? '').replace(/\r\n/g, '\n');
  const blocks = [];
  const stash = (html) => {
    let i = blocks.length;
    blocks.push(html);
    return `\u0001B${i}\u0001`;
  };

  let body = text.replace(/```([\w+#.-]*)[ \t]*\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    const language = lang || 'text';
    const safeLang = esc(language);
    return stash(
      `<div class="code-block" data-lang="${safeLang}"><div class="code-head"><span class="code-lang">${safeLang}</span><button class="code-copy" data-copy>Copy</button></div><pre><code>${highlight(code.replace(/\n$/, ''), language)}</code></pre></div>`,
    );
  });

  body = body.replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, () => stash('<hr />'));

  const lines = body.split('\n');
  const out = [];
  let i = 0;
  let listStack = [];

  const closeLists = (toDepth = 0) => {
    while (listStack.length > toDepth) out.push(listStack.pop() === 'ol' ? '</ol>' : '</ul>');
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\u0001B\d+\u0001$/.test(line.trim())) {
      closeLists();
      out.push(line.trim());
      i++;
      continue;
    }

    if (!line.trim()) {
      closeLists();
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^&gt;\s?/.test(line)) {
      closeLists();
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      closeLists();
      const rows = [];
      const head = line;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${cells(head)
          .map((c) => `<th>${c}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2) + 1;
      const kind = /\d/.test(li[2]) ? 'ol' : 'ul';
      while (listStack.length > depth) out.push(listStack.pop() === 'ol' ? '</ol>' : '</ul>');
      if (listStack.length < depth) {
        out.push(kind === 'ol' ? '<ol>' : '<ul>');
        listStack.push(kind);
      }
      let content = li[3];
      const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        content = `<span class="task ${task[1].toLowerCase() === 'x' ? 'done' : ''}">${task[1].toLowerCase() === 'x' ? '✓' : ''}</span>${inline(task[2])}`;
      } else content = inline(content);
      out.push(`<li>${content}</li>`);
      i++;
      continue;
    }

    closeLists();
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\u0001B\d+\u0001$/.test(lines[i].trim()) &&
      !/^&gt;\s?/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }
  closeLists();

  let html = out.join('\n');
  html = html.replace(/\u0001B(\d+)\u0001/g, (_, n) => blocks[Number(n)]);
  return html;
}

export { esc, highlight };
