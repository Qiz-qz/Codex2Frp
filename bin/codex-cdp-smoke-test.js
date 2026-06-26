#!/usr/bin/env node
'use strict';

const port = Number(process.env.CODEX2FRP_CDP_PORT || process.argv[2] || 39252);
const host = process.env.CODEX2FRP_CDP_HOST || '[::1]';
const mode = process.env.CODEX2FRP_CDP_MODE || process.argv[3] || 'draft';

function hostForUrl(value) {
  const raw = String(value || '').trim() || 'localhost';
  if (raw.startsWith('[') && raw.endsWith(']')) return raw;
  return raw.includes(':') ? `[${raw}]` : raw;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = error => {
      clearTimeout(timer);
      reject(error);
    };
  });

  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result && result.result.value;
}

const visibleHelperSource = `el => {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}`;

async function main() {
  const hostCandidates = [host, '[::1]', '127.0.0.1', 'localhost']
    .map(hostForUrl)
    .filter((item, index, list) => item && list.indexOf(item) === index);
  let targets = null;
  let lastError = null;
  for (const cdpHost of hostCandidates) {
    try {
      targets = await fetchJson(`http://${cdpHost}:${port}/json/list`);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!targets) throw lastError || new Error('No CDP target list available');
  const page = targets.find(target => target.type === 'page' && target.url === 'app://-/index.html')
    || targets.find(target => target.type === 'page' && target.url.startsWith('app://-/index.html'))
    || targets.find(target => target.type === 'page');

  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error('No usable Codex page target found from CDP /json/list');
  }

  const client = await connect(page.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable');
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});

    const inspect = await evaluate(client, `(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
        .find(visible);
      const threadRows = [...document.querySelectorAll('[role="button"],button,.group')]
        .filter(el => visible(el) && (el.innerText || '').trim())
        .slice(0, 16)
        .map(el => (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80));
      return {
        title: document.title,
        url: location.href,
        hasEditor: Boolean(editor),
        editorClass: editor ? String(editor.className || '') : '',
        editorText: editor ? (editor.innerText || editor.value || '').slice(0, 120) : '',
        threadRows,
      };
    })()`);

    if (mode === 'inspect') {
      console.log(JSON.stringify({ ok: true, mode, page: { title: page.title, url: page.url }, inspect }, null, 2));
      return;
    }

    const click = await evaluate(client, `(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const rows = [...document.querySelectorAll('[role="button"],button,.group')]
        .filter(el => {
          if (!visible(el) || (el.innerText || '').trim().length <= 3) return false;
          const rect = el.getBoundingClientRect();
          if (rect.x > 340 || rect.width < 120) return false;
          return !/新对话|搜索|插件|自动化|置顶|项目|对话|展开显示/.test(el.innerText || '');
        });
      const currentish = rows.find(el => (el.innerText || '').includes('#keep 授权码维护'))
        || rows.find(el => (el.innerText || '').includes('切换到a1服务器'))
        || rows.find(el => !/知识库|素材管理|完全访问|本地模式|CDP分离方案/.test(el.innerText || ''));
      if (!currentish) return { ok: false, reason: 'no thread-like row found' };
      currentish.click();
      const rect = currentish.getBoundingClientRect();
      return {
        ok: true,
        clickedText: (currentish.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      };
    })()`);

    const draftText = `CDP草稿验证-请勿发送-${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    await wait(800);

    const focus = await evaluate(client, `(() => {
      const visible = ${visibleHelperSource};
      const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
        .find(visible);
      if (!editor) return { ok: false, reason: 'editor not found' };
      editor.focus();
      return {
        ok: true,
        activeTag: document.activeElement && document.activeElement.tagName,
        activeClass: document.activeElement ? String(document.activeElement.className || '') : '',
      };
    })()`);

    await client.call('Input.insertText', { text: draftText });
    await wait(400);

    const afterInsert = await evaluate(client, `(() => {
      const visible = ${visibleHelperSource};
      const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
        .find(visible);
      const composerRoot = editor && editor.closest('.relative, form, [class*="composer"]');
      const buttons = composerRoot
        ? [...composerRoot.querySelectorAll('button,[role="button"]')].map(button => {
            const rect = button.getBoundingClientRect();
            return {
              aria: button.getAttribute('aria-label'),
              title: button.getAttribute('title'),
              text: (button.innerText || '').trim(),
              disabled: Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true',
              rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
              className: String(button.className || '').slice(0, 100),
            };
          })
        : [];
      const sendButton = buttons.filter(button => button.rect.w <= 48 && button.rect.h <= 48).at(-1) || null;
      return {
        editorText: editor ? (editor.innerText || editor.value || '').slice(0, 200) : '',
        editorHtml: editor ? (editor.innerHTML || '').slice(0, 300) : '',
        sendButton,
        buttonCount: buttons.length,
      };
    })()`);

    if (mode !== 'send') {
      await evaluate(client, `(() => {
        const visible = ${visibleHelperSource};
        const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
          .find(visible);
        if (!editor) return false;
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
        return true;
      })()`).catch(() => {});
    } else {
      await evaluate(client, `(() => {
        const visible = ${visibleHelperSource};
        const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
          .find(visible);
        const root = editor && editor.closest('.relative, form, [class*="composer"]');
        const buttons = root ? [...root.querySelectorAll('button,[role="button"]')] : [];
        const sendButton = buttons.filter(button => {
          const rect = button.getBoundingClientRect();
          return rect.width <= 48 && rect.height <= 48 && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
        }).at(-1);
        if (!sendButton) return { ok: false, reason: 'send button not found' };
        sendButton.click();
        return { ok: true };
      })()`);
    }

    console.log(JSON.stringify({
      ok: true,
      mode,
      page: { title: page.title, url: page.url },
      inspect,
      click,
      focus,
      inserted: draftText,
      afterInsert,
      cleanedDraft: mode !== 'send',
    }, null, 2));
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
