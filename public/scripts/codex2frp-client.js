    function optionalElement(id, tagName = 'div') {
      return document.getElementById(id) || document.createElement(tagName);
    }

    const thread = document.getElementById('thread');
    const composerShell = document.querySelector('.composer-shell');
    const topbar = document.querySelector('.topbar');
    const composer = document.getElementById('composer');
    const textarea = document.getElementById('text');
    const sendButton = document.getElementById('send');
    const stopButton = document.getElementById('stop');
    const attachButton = optionalElement('attach', 'button');
    const fileInput = optionalElement('file-input', 'input');
    const attachmentTray = optionalElement('attachment-tray');
    const notice = document.getElementById('notice');
    const queuedSend = document.getElementById('queued-send');
    const queuedSendLabel = document.getElementById('queued-send-label');
    const queuedSendText = document.getElementById('queued-send-text');
    const topStatus = document.getElementById('top-status');
    const contextQuickCard = optionalElement('context-quick-card');
    const contextQuickCompact = contextQuickCard;
    const reasoningBadge = optionalElement('reasoning-badge', 'button');
    const reasoningMenuCard = optionalElement('reasoning-menu-card');
    const reasoningText = optionalElement('reasoning-text', 'span');
    const modelBadge = optionalElement('model-badge', 'button');
    const modelMenuCard = optionalElement('model-menu-card');
    const modelText = optionalElement('model-text', 'span');
    const speedBadge = optionalElement('speed-badge', 'button');
    const speedMenuCard = optionalElement('speed-menu-card');
    const speedText = optionalElement('speed-text', 'span');
    const routeBadge = document.getElementById('route-badge');
    const routeIcon = document.getElementById('route-icon');
    const routeText = document.getElementById('route-text');
    const threadButton = document.getElementById('thread-button');
    const newThreadButton = optionalElement('new-thread', 'button');
    const keepAwakeButton = optionalElement('keep-awake', 'button');
    const threadCurrentPin = document.getElementById('thread-current-pin');
    const threadNameEl = document.getElementById('thread-name');
    const threadMenuScrim = document.getElementById('thread-menu-scrim');
    const threadMenu = document.getElementById('thread-menu');
    const threadActionCard = optionalElement('thread-action-card');
    const threadActionArchive = optionalElement('thread-action-archive', 'button');
    const threadActionArchiveIcon = optionalElement('thread-action-archive-icon', 'span');
    const threadActionRename = optionalElement('thread-action-rename', 'button');
    const threadActionRenameIcon = optionalElement('thread-action-rename-icon', 'span');
    const threadActionPinToggle = optionalElement('thread-action-pin-toggle', 'button');
    const threadActionPinToggleIcon = optionalElement('thread-action-pin-toggle-icon', 'span');
    const threadActionPinToggleText = optionalElement('thread-action-pin-toggle-text', 'span');
    const threadRenameInput = optionalElement('thread-rename-input', 'input');
    const threadRenameCancel = optionalElement('thread-rename-cancel', 'button');
    const threadRenameSave = optionalElement('thread-rename-save', 'button');
    const queryToken = new URLSearchParams(location.search).get('token') || '';
    if (queryToken) localStorage.setItem('codex2frp.token', queryToken);
    const token = queryToken || localStorage.getItem('codex2frp.token') || '';
    function detectBasePath(pathname) {
      if (pathname === '/codex2frp' || pathname.startsWith('/codex2frp/')) return '/codex2frp';
      return '';
    }
    const basePath = detectBasePath(location.pathname);
    const ROUTE_STORAGE_KEY = 'codex2frp.apiRoutes.v1';
    const CONTEXT_DISPLAY_MODE_STORAGE_KEY = 'codex2frp.contextDisplayMode.v1';
    const SHOW_PROJECTLESS_THREADS_IN_MENU = false;
    const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');
    const currentApiBase = normalizeBaseUrl(`${location.origin}${basePath}`);
    const currentApiKind = classifyLocationHost(location.hostname);
    const shouldPreferCurrentApiBase = isRemoteEntryKind(currentApiKind);
    const currentApiLabel = routeTextForKind(currentApiKind);
    let apiCandidates = [];
    let activeApiBase = currentApiBase;
    let activeApiLabel = currentApiLabel;
    let activeApiKind = currentApiKind;
    const apiUrl = path => `${activeApiBase}${path}`;
    const target = 'codex';
    const CONTEXT_COMPACT_COMMAND = '/压缩';

    let selectedThreadId = localStorage.getItem('codex2frp.selectedThread') || '';
    let pendingNewThread = null;
    let knownThreads = [];
    let pollTimer = null;
    let runDurationTimer = null;
    let pollAttempts = 0;
    let pollGeneration = 0;
    let activeWatch = null;
    let activeAssistant = null;
    let lastPreview = '';
    let pendingAttachments = [];
    let queuedSends = [];
    let historyRequestId = 0;
    const INITIAL_HISTORY_MESSAGE_LIMIT = 40;
    let fullHistoryRows = [];
    let renderedHistoryOffset = 0;
    let syncRequestId = 0;
    let syncedThreadId = '';
    let autoRefreshTimer = null;
    let autoRefreshBusy = false;
    let threadStateTimer = null;
    let threadStateBusy = false;
    let appResumeRefreshTimer = null;
    let routeMonitorBusy = false;
    let sakuraStatus = null;
    let sakuraStatusBusy = false;
    let keepAwakeEnabled = false;
    let keepAwakeBusy = false;
    let actionThreadId = '';
    let threadLongPressTimer = null;
    let threadLongPressStart = null;
    let threadLongPressOpened = false;
    let contextLongPressTimer = null;
    let contextLongPressStart = null;
    let contextLongPressOpened = false;
    let reasoningLongPressTimer = null;
    let reasoningLongPressStart = null;
    let reasoningLongPressOpened = false;
    let modelLongPressTimer = null;
    let modelLongPressStart = null;
    let modelLongPressOpened = false;
    let speedLongPressTimer = null;
    let speedLongPressStart = null;
    let speedLongPressOpened = false;
    let suppressThreadClickUntil = 0;
    let suppressContextClickUntil = 0;
    let suppressReasoningClickUntil = 0;
    let suppressModelClickUntil = 0;
    let suppressSpeedClickUntil = 0;
    let lastStatusSignature = '';
    let topNoticeUntil = 0;
    let topStatusState = '已连接';
    let topStatusType = '';
    let lastContextUsage = null;
    let currentReasoningMode = null;
    let switchingReasoningMode = false;
    let currentModelInfo = null;
    let switchingModel = false;
    let currentSpeedMode = null;
    let switchingSpeedMode = false;
    let speedSupported = false;
    let foregroundDotBusy = false;
    const savedContextDisplayMode = Number(localStorage.getItem(CONTEXT_DISPLAY_MODE_STORAGE_KEY));
    let contextDisplayMode = Number.isInteger(savedContextDisplayMode) && savedContextDisplayMode >= 0 && savedContextDisplayMode <= 2 ? savedContextDisplayMode : 0;
    let keyboardMonitorTimer = null;
    let keyboardAlignmentTimers = [];
    let keyboardPinTimers = [];
    let keyboardAlignRaf = 0;
    let keyboardFocusStartedAt = 0;
    let keyboardShiftTarget = 0;
    let maxViewportHeight = Math.max(window.innerHeight || 0, window.visualViewport ? window.visualViewport.height : 0);
    let keyboardComposerRevealDone = false;
    let lastTextareaFocusPrepareAt = 0;
    let lastOutsideComposerTouchAt = 0;
    let suppressNextTextareaBlurRestore = false;
    const STORAGE_PREFIX = 'codex2frpChat.v3';
    const GROUPS_STORAGE_KEY = 'codex2frp.threadGroups.open.v1';
    const THREAD_NOTICE_STORAGE_KEY = 'codex2frp.threadCompleteNotices.v1';
    const REASONING_OVERRIDE_STORAGE_KEY = 'codex2frp.reasoningOverrides.v1';
    const MODEL_OVERRIDE_STORAGE_KEY = 'codex2frp.modelOverrides.v1';
    const SPEED_OVERRIDE_STORAGE_KEY = 'codex2frp.speedOverrides.v1';
    const THREAD_NOTICE_MAX_AGE_MS = 30 * 60 * 1000;
    const THREAD_SPINNER_MS = 850;
    const LOCAL_STOP_SUPPRESS_MS = 2 * 60 * 1000;
    const REASONING_MODE_OPTIONS = [
      { key: 'low', label: '低', displayName: '低' },
      { key: 'medium', label: '中', displayName: '中' },
      { key: 'high', label: '高', displayName: '高' },
      { key: 'xhigh', label: '超高', displayName: '超高' },
    ];
    const MODEL_MENU_OPTIONS = [];
    let modelMenuOptions = [...MODEL_MENU_OPTIONS];
    const SPEED_MODE_OPTIONS = [
      { key: 'standard', value: 'default', serviceTier: 'default', label: '标准', displayName: '标准' },
      { key: 'fast', value: 'priority', serviceTier: 'priority', label: '高速', displayName: '高速' },
    ];
    let apiConfigRefreshBusy = false;
    let lastApiConfigRefreshAt = 0;
    const API_CONFIG_REFRESH_MIN_MS = 15000;
    const perfEnabled = new URLSearchParams(location.search).get('perf') === '1' || localStorage.getItem('codex2frp.perf') === '1';
    const perfMarks = [];
    function markPerf(name, extra = {}) {
      if (!perfEnabled) return;
      perfMarks.push({ name, at: Math.round(performance.now()), ...extra });
      console.debug('[Codex2Frp perf]', name, perfMarks[perfMarks.length - 1]);
    }
    if (perfEnabled && 'PerformanceObserver' in window) {
      try {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) markPerf('longtask', { duration: Math.round(entry.duration) });
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {}
    }
    const hasSavedProjectGroupState = localStorage.getItem(GROUPS_STORAGE_KEY) !== null;
    const isStandalone = Boolean(window.navigator.standalone) || window.matchMedia('(display-mode: standalone)').matches;
    document.body.classList.toggle('standalone', isStandalone);

    if (queryToken) {
      document.cookie = `codex2frpToken=${encodeURIComponent(queryToken)}; Path=/; SameSite=Lax; Max-Age=31536000`;
    }
    let openProjectKeys = readOpenProjectKeys();
    const threadRuntimeStates = new Map();
    const locallyStoppedThreads = new Map();
    let completedThreadNoticeTimes = new Map();
    const completedThreadIds = readCompletedThreadIds();
    let lastThreadMenuSignature = '';

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    }
    function renderInlineMarkdown(text) {
      let html = escapeHtml(text);
      const codeStore = [];
      html = html.replace(/`([^`]+)`/g, (_, code) => {
        const id = codeStore.push(`<code>${code}</code>`) - 1;
        return `@@CODE${id}@@`;
      });
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/@@CODE(\d+)@@/g, (_, index) => codeStore[Number(index)] || '');
      return html;
    }
    function splitMarkdownTableRow(line) {
      let value = String(line || '').trim();
      if (!value.includes('|')) return [];
      if (value.startsWith('|')) value = value.slice(1);
      if (value.endsWith('|')) value = value.slice(0, -1);
      const cells = [];
      let cell = '';
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        const next = value[index + 1];
        if (char === '\\' && (next === '|' || next === '\\')) {
          cell += next;
          index += 1;
          continue;
        }
        if (char === '|') {
          cells.push(cell.trim());
          cell = '';
          continue;
        }
        cell += char;
      }
      cells.push(cell.trim());
      return cells;
    }
    function markdownTableDelimiterInfo(line) {
      const cells = splitMarkdownTableRow(line);
      if (cells.length < 2 || !cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))) return null;
      return cells.map(cell => {
        const normalized = cell.replace(/\s+/g, '');
        if (/^:-+:$/.test(normalized)) return 'center';
        if (/^-+:$/.test(normalized)) return 'right';
        return /^:-+$/.test(normalized) ? 'left' : '';
      });
    }
    function isMarkdownTableStart(lines, index) {
      const header = splitMarkdownTableRow(lines[index]);
      const alignments = markdownTableDelimiterInfo(lines[index + 1]);
      if (!alignments || header.length < 2) return null;
      return { header, alignments };
    }
    function tableCellClass(alignments, index) {
      const alignment = alignments[index] || '';
      if (alignment === 'center') return ' class="align-center"';
      if (alignment === 'right') return ' class="align-right"';
      return '';
    }
    function renderMarkdownTable(header, alignments, rows) {
      const width = Math.max(header.length, alignments.length, ...rows.map(row => row.length));
      const pad = row => Array.from({ length: width }, (_, index) => row[index] || '');
      const head = pad(header).map((cell, index) => `<th${tableCellClass(alignments, index)}>${renderInlineMarkdown(cell)}</th>`).join('');
      const body = rows.map(row => `<tr>${pad(row).map((cell, index) => `<td${tableCellClass(alignments, index)}>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('');
      return `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
    function extractTagContent(text, tag) {
      const match = String(text || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return match ? match[1].trim() : '';
    }
    function parseMemoryCitationEntries(block) {
      const entriesText = extractTagContent(block, 'citation_entries');
      if (!entriesText) return [];
      return entriesText.split(/\n+/).map(line => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        const match = trimmed.match(/^(.*?)(?::(\d+(?:-\d+)?))?\|note=\[([\s\S]*)\]$/);
        if (match) return { path: match[1].trim(), lines: match[2] || '', note: match[3].trim() };
        return { path: trimmed, lines: '', note: '' };
      }).filter(Boolean);
    }
    function renderMemoryCitationCard(block) {
      const entries = parseMemoryCitationEntries(block);
      const title = entries.length ? '记忆引用' : '记忆已更新';
      const items = entries.map(entry => {
        const lineText = entry.lines ? ` <span class="memory-citation-count">${escapeHtml(entry.lines)} 行</span>` : '';
        const note = entry.note ? `<div class="memory-citation-note">${escapeHtml(entry.note)}</div>` : '';
        return `<div class="memory-citation-item"><div class="memory-citation-path">${escapeHtml(entry.path)}${lineText}</div>${note}</div>`;
      }).join('');
      const empty = '<div class="memory-citation-empty">本轮有记忆信息，但没有可显示的引用条目</div>';
      return `<details class="memory-citation-card"><summary><span class="memory-citation-icon">↺</span><span class="memory-citation-title">${title}</span><span class="memory-citation-count">${entries.length} 条</span></summary>${items ? `<div class="memory-citation-list">${items}</div>` : empty}</details>`;
    }
    function splitMemoryCitationBlocks(markdown) {
      const text = String(markdown || '');
      const parts = [];
      const pattern = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi;
      let lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        if (match.index > lastIndex) parts.push({ type: 'markdown', value: text.slice(lastIndex, match.index) });
        parts.push({ type: 'memory', value: match[0] });
        lastIndex = pattern.lastIndex;
      }
      if (lastIndex < text.length) parts.push({ type: 'markdown', value: text.slice(lastIndex) });
      return parts;
    }
    function markdownToHtmlWithoutMemory(markdown) {
      const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
      let html = '', paragraph = [], listType = null, inCode = false, codeLines = [];
      const flushParagraph = () => { if (paragraph.length) { html += `<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`; paragraph = []; } };
      const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();
        if (trimmed.startsWith('```')) {
          if (inCode) { html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`; codeLines = []; inCode = false; }
          else { flushParagraph(); closeList(); inCode = true; }
          continue;
        }
        if (inCode) { codeLines.push(line); continue; }
        const table = index + 1 < lines.length ? isMarkdownTableStart(lines, index) : null;
        if (table) {
          flushParagraph();
          closeList();
          const rows = [];
          index += 2;
          while (index < lines.length) {
            const rowCells = splitMarkdownTableRow(lines[index]);
            if (rowCells.length < 2) { index -= 1; break; }
            rows.push(rowCells);
            index += 1;
          }
          if (index >= lines.length) index = lines.length - 1;
          html += renderMarkdownTable(table.header, table.alignments, rows);
          continue;
        }
        if (!trimmed) { flushParagraph(); closeList(); continue; }
        const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
        if (heading) { flushParagraph(); closeList(); const n = heading[1].length; html += `<h${n}>${renderInlineMarkdown(heading[2])}</h${n}>`; continue; }
        const quote = trimmed.match(/^>\s?(.+)$/);
        if (quote) { flushParagraph(); closeList(); html += `<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`; continue; }
        const bullet = trimmed.match(/^[-*]\s+(.+)$/);
        const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
        if (bullet || ordered) {
          flushParagraph();
          const desired = bullet ? 'ul' : 'ol';
          if (listType !== desired) { closeList(); html += `<${desired}>`; listType = desired; }
          html += `<li>${renderInlineMarkdown((bullet || ordered)[1])}</li>`;
          continue;
        }
        closeList(); paragraph.push(trimmed);
      }
      if (inCode) html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
      flushParagraph(); closeList();
      return html;
    }
    function markdownToHtml(markdown) {
      const parts = splitMemoryCitationBlocks(markdown);
      if (!parts.some(part => part.type === 'memory')) return markdownToHtmlWithoutMemory(markdown) || '<p></p>';
      const html = parts.map(part => part.type === 'memory'
        ? renderMemoryCitationCard(part.value)
        : markdownToHtmlWithoutMemory(part.value)).join('');
      return html || '<p></p>';
    }
    function setMarkdown(el, markdown) { el.innerHTML = markdownToHtml(markdown); }
    function lockViewportZoom() {
      let lastTouchEndAt = 0;
      document.addEventListener('gesturestart', event => event.preventDefault(), { passive: false });
      document.addEventListener('gesturechange', event => event.preventDefault(), { passive: false });
      document.addEventListener('gestureend', event => event.preventDefault(), { passive: false });
      document.addEventListener('touchmove', event => {
        if (event.touches && event.touches.length > 1) event.preventDefault();
      }, { passive: false });
      document.addEventListener('touchend', event => {
        const now = Date.now();
        if (now - lastTouchEndAt <= 300) event.preventDefault();
        lastTouchEndAt = now;
      }, { passive: false });
    }
    function lockComposerDrag() {
      if (!composerShell) return;
      const dragThreshold = 2;
      let touchStart = null;
      let pointerStart = null;
      const isEditableTextareaTarget = target => Boolean(target && target === textarea);
      const isComposerTarget = target => Boolean(target && composer.contains(target) && !isEditableTextareaTarget(target));
      const resetTouch = () => { touchStart = null; };
      const resetPointer = () => { pointerStart = null; };

      composerShell.addEventListener('touchstart', event => {
        if (!isComposerTarget(event.target) || !event.touches || !event.touches.length) return;
        const touch = event.touches[0];
        touchStart = { x: touch.clientX, y: touch.clientY };
      }, { passive: true });
      composerShell.addEventListener('touchmove', event => {
        if (!touchStart || !event.touches || !event.touches.length || !isComposerTarget(event.target)) return;
        const touch = event.touches[0];
        const dx = Math.abs(touch.clientX - touchStart.x);
        const dy = Math.abs(touch.clientY - touchStart.y);
        if (dx < dragThreshold && dy < dragThreshold) return;
        event.preventDefault();
        event.stopPropagation();
        if (document.activeElement === textarea) alignComposerForKeyboard();
      }, { passive: false });
      composerShell.addEventListener('touchend', resetTouch, { passive: true });
      composerShell.addEventListener('touchcancel', resetTouch, { passive: true });

      composerShell.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'touch' || !isComposerTarget(event.target)) return;
        pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
      });
      composerShell.addEventListener('pointermove', event => {
        if (!pointerStart || event.pointerId !== pointerStart.id || !isComposerTarget(event.target)) return;
        const dx = Math.abs(event.clientX - pointerStart.x);
        const dy = Math.abs(event.clientY - pointerStart.y);
        if (dx < dragThreshold && dy < dragThreshold) return;
        event.preventDefault();
        event.stopPropagation();
      });
      composerShell.addEventListener('pointerup', resetPointer);
      composerShell.addEventListener('pointercancel', resetPointer);
    }
    function lockPageScrollToThread() {
      let pageTouch = null;
      const verticalScrollSelector = '.thread, .thread-menu, .steps, textarea';
      const horizontalScrollSelector = '.top-actions, .process-tool-row, .table-scroll, .attachment-tray';
      const resetPageTouch = () => { pageTouch = null; };
      const preventPageMove = event => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof keepLayoutViewportPinned === 'function') keepLayoutViewportPinned();
      };
      const nearest = (target, selector) => {
        if (!target || typeof target.closest !== 'function') return null;
        return target.closest(selector);
      };
      const canScrollVertically = (el, deltaY) => {
        if (!el) return false;
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        if (maxScroll <= 1) return false;
        if (deltaY > 0 && el.scrollTop <= 0) return false;
        if (deltaY < 0 && el.scrollTop >= maxScroll - 1) return false;
        return true;
      };
      const hasTextareaSelection = el => {
        if (!el || typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return false;
        return el.selectionStart !== el.selectionEnd;
      };

      document.addEventListener('touchstart', event => {
        if (!event.touches || event.touches.length !== 1) {
          resetPageTouch();
          return;
        }
        const touch = event.touches[0];
        pageTouch = {
          x: touch.clientX,
          y: touch.clientY,
          startedAt: performance.now(),
          verticalTarget: nearest(event.target, verticalScrollSelector),
          horizontalTarget: nearest(event.target, horizontalScrollSelector),
          editableTarget: nearest(event.target, 'textarea'),
        };
      }, { passive: true, capture: true });

      document.addEventListener('touchmove', event => {
        if (!event.touches || event.touches.length !== 1) return;
        if (!pageTouch) {
          preventPageMove(event);
          return;
        }
        const touch = event.touches[0];
        const dx = touch.clientX - pageTouch.x;
        const dy = touch.clientY - pageTouch.y;
        const verticalTarget = pageTouch.verticalTarget && document.contains(pageTouch.verticalTarget)
          ? pageTouch.verticalTarget
          : nearest(event.target, verticalScrollSelector);
        const horizontalTarget = pageTouch.horizontalTarget && document.contains(pageTouch.horizontalTarget)
          ? pageTouch.horizontalTarget
          : nearest(event.target, horizontalScrollSelector);
        const editableTarget = pageTouch.editableTarget && document.contains(pageTouch.editableTarget)
          ? pageTouch.editableTarget
          : nearest(event.target, 'textarea');

        if (editableTarget) {
          const elapsed = performance.now() - (pageTouch.startedAt || 0);
          const mostlyVertical = Math.abs(dy) > Math.max(Math.abs(dx), 6);
          const mostlyHorizontal = Math.abs(dx) > Math.abs(dy);
          const allowNativeEditGesture = mostlyHorizontal
            || hasTextareaSelection(editableTarget)
            || elapsed > 420
            || canScrollVertically(editableTarget, dy);
          if (allowNativeEditGesture || !mostlyVertical) {
            pageTouch.x = touch.clientX;
            pageTouch.y = touch.clientY;
            if (!canScrollVertically(editableTarget, dy)) keepLayoutViewportPinned();
            return;
          }
          preventPageMove(event);
          return;
        }
        if (horizontalTarget && Math.abs(dx) > Math.abs(dy)) {
          pageTouch.x = touch.clientX;
          pageTouch.y = touch.clientY;
          return;
        }
        if (verticalTarget && Math.abs(dy) >= Math.abs(dx) && canScrollVertically(verticalTarget, dy)) {
          pageTouch.x = touch.clientX;
          pageTouch.y = touch.clientY;
          return;
        }
        preventPageMove(event);
      }, { passive: false, capture: true });

      document.addEventListener('touchend', resetPageTouch, { passive: true, capture: true });
      document.addEventListener('touchcancel', resetPageTouch, { passive: true, capture: true });
    }
    function clampNumber(value, min, max) {
      const number = Number(value);
      if (!Number.isFinite(number)) return min;
      return Math.max(min, Math.min(max, number));
    }
    function formatTokenCount(value) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return '--';
      if (number >= 1000000) return `${(number / 1000000).toFixed(number >= 10000000 ? 0 : 1)}M`;
      if (number >= 1000) return `${Math.round(number / 1000)}k`;
      return String(Math.round(number));
    }
    function contextColor(percent) {
      const value = clampNumber(percent, 0, 100);
      if (value < 45) return 'color(display-p3 .42 1 .68)';
      if (value < 70) {
        const t = (value - 45) / 25;
        const hue = Math.round(142 - (94 * t));
        return `hsl(${hue} 92% 64%)`;
      }
      const t = (value - 70) / 30;
      const hue = Math.round(48 - (42 * t));
      return `hsl(${hue} 94% 63%)`;
    }
    function renderContextIndicator(context = lastContextUsage) {
      lastContextUsage = context || null;
      const hasContext = Boolean(context && context.available && Number.isFinite(Number(context.percent)));
      const percent = hasContext ? clampNumber(context.percent, 0, 100) : 0;
      const rounded = Math.round(percent);
      const color = hasContext ? contextColor(percent) : 'rgba(161,161,170,.72)';
      const used = hasContext ? formatTokenCount(context.usedTokens) : '--';
      const total = hasContext ? formatTokenCount(context.windowTokens) : '--';
      const modeClass = contextDisplayMode === 1 ? 'mode-percent' : contextDisplayMode === 2 ? 'mode-used' : 'mode-ring';
      const displayText = contextDisplayMode === 1 ? (hasContext ? `${rounded}%` : '--') : (hasContext ? used : '--');
      const detail = hasContext
        ? `当前上下文已使用 ${rounded}%（${used} / ${total} tokens）`
        : '暂未读到上下文用量';

      topStatus.className = `context-status ${modeClass}${hasContext ? '' : ' is-unknown'}${topStatusType ? ` state-${topStatusType}` : ''}`;
      topStatus.style.setProperty('--context-progress', `${percent * 3.6}deg`);
      topStatus.style.setProperty('--context-color', color);
      topStatus.innerHTML = `<span class="context-text"><span class="context-percent">${displayText}</span></span><span class="context-ring" aria-hidden="true"></span>`;
      topStatus.title = `${topStatusState || '已连接'} · ${detail}`;
      topStatus.setAttribute('aria-label', `${detail}。点击切换显示模式。`);
    }
    function updateContextFromStatus(data) {
      applyClientModeOptions(data);
      if (data && data.context) renderContextIndicator(data.context);
      updateReasoningFromStatus(data);
      updateModelFromStatus(data);
      updateSpeedFromStatus(data);
    }
    function cycleContextDisplayMode() {
      contextDisplayMode = (contextDisplayMode + 1) % 3;
      localStorage.setItem(CONTEXT_DISPLAY_MODE_STORAGE_KEY, String(contextDisplayMode));
      renderContextIndicator();
    }
    function setTopStatus(text = '已连接', type = '', options = {}) {
      if (!options.force && topNoticeUntil && Date.now() < topNoticeUntil) return;
      topStatusState = text || '已连接';
      topStatusType = type || '';
      renderContextIndicator();
    }
    function isNoticeTokenChar(char) {
      return /[A-Za-z0-9]/.test(char || '');
    }
    function stripNoticePeriods(text) {
      const raw = String(text || '').trim();
      let value = '';
      for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === '。') continue;
        if (char === '.') {
          const previous = raw[index - 1];
          const next = raw[index + 1];
          if (isNoticeTokenChar(previous) && isNoticeTokenChar(next)) value += char;
          continue;
        }
        value += char;
      }
      return value.trim();
    }
    function setNotice(text, type = '') {
      const value = stripNoticePeriods(text);
      topNoticeUntil = 0;
      if (!value) {
        notice.className = 'notice-pill';
        notice.textContent = '';
        return;
      }
      notice.className = `notice-pill is-visible ${type}`.trim();
      notice.textContent = value;
      window.clearTimeout(setNotice.timer);
      setNotice.timer = window.setTimeout(() => {
        notice.className = 'notice-pill';
      }, 6000);
    }
    function readReasoningOverrides() {
      try {
        const parsed = JSON.parse(localStorage.getItem(REASONING_OVERRIDE_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    function writeReasoningOverride(threadId, mode) {
      if (!threadId || !mode) return;
      const rows = readReasoningOverrides();
      rows[threadId] = { ...mode, updatedAt: mode.updatedAt || new Date().toISOString(), local: true };
      try { localStorage.setItem(REASONING_OVERRIDE_STORAGE_KEY, JSON.stringify(rows)); } catch {}
    }
    function reasoningTime(mode) {
      const time = Date.parse(mode?.updatedAt || '');
      return Number.isFinite(time) ? time : 0;
    }
    function overrideReasoningForThread(threadId = selectedThreadId) {
      if (!threadId) return null;
      return readReasoningOverrides()[threadId] || null;
    }
    function bestReasoningMode(mode = null, threadId = selectedThreadId) {
      const override = overrideReasoningForThread(threadId);
      if (override && (!mode || reasoningTime(override) >= reasoningTime(mode))) return override;
      return mode || override || null;
    }
    function reasoningOptionByKey(targetKey = '') {
      return REASONING_MODE_OPTIONS.find(item => item.key === targetKey) || null;
    }
    function reasoningKeyFromValue(value = '') {
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'low' || raw === '低') return 'low';
      if (raw === 'medium' || raw === 'middle' || raw === '中') return 'medium';
      if (raw === 'high' || raw === '高') return 'high';
      if (raw === 'xhigh' || raw === 'x-high' || raw === 'extra-high' || raw === '超高') return 'xhigh';
      return '';
    }
    function normalizeReasoningOption(item) {
      const key = reasoningKeyFromValue(item?.key || item?.mode || item?.value || item?.label || item?.displayName || item?.display_name || item?.name || item);
      if (!key) return null;
      const fallback = { low: '低', medium: '中', high: '高', xhigh: '超高' }[key] || key;
      return {
        key,
        label: String(item?.label || item?.displayName || item?.display_name || item?.name || fallback),
        displayName: String(item?.displayName || item?.display_name || item?.label || item?.name || fallback),
      };
    }
    function replaceReasoningOptions(options = []) {
      const normalized = [];
      for (const item of options) {
        const option = normalizeReasoningOption(item);
        if (option && !normalized.some(row => row.key === option.key)) normalized.push(option);
      }
      if (normalized.length) REASONING_MODE_OPTIONS.splice(0, REASONING_MODE_OPTIONS.length, ...normalized);
    }
    function currentReasoningKey(mode = currentReasoningMode) {
      const key = String(mode?.key || '').trim();
      if (reasoningOptionByKey(key)) return key;
      const label = String(mode?.label || mode?.displayName || '').trim();
      return REASONING_MODE_OPTIONS.find(item => item.label === label)?.key || '';
    }
    function renderReasoningMenu() {
      const currentKey = currentReasoningKey();
      reasoningMenuCard.textContent = '';
      for (const item of REASONING_MODE_OPTIONS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `model-menu-item reasoning-menu-item mode-${item.key}${item.key === currentKey ? ' is-current' : ''}`;
        button.dataset.target = item.key;
        button.textContent = item.label;
        button.title = `推理模式：${item.displayName}`;
        button.setAttribute('aria-label', `推理模式：${item.displayName}${item.key === currentKey ? '（当前）' : ''}`);
        wireInstantActionButton(button, () => {
          if (switchingReasoningMode) return;
          if (item.key === currentKey) {
            closeReasoningMenu();
            setNotice(`当前已是${item.displayName}推理模式`, 'ok');
            return;
          }
          closeReasoningMenu();
          switchReasoningMode(item.key);
        });
        reasoningMenuCard.appendChild(button);
      }
    }
    function renderReasoningBadge(mode = currentReasoningMode) {
      currentReasoningMode = mode || null;
      const label = mode?.label || '中';
      const modeKey = currentReasoningKey(mode) || 'medium';
      reasoningText.textContent = label;
      reasoningBadge.className = `reasoning-badge mode-${modeKey}${switchingReasoningMode ? ' is-switching' : ''}`;
      const display = mode?.displayName || label || '中';
      reasoningBadge.title = `推理模式：${display}`;
      reasoningBadge.setAttribute('aria-label', `当前推理模式：${display}。点击打开低、中、高、超高选择菜单。`);
      reasoningBadge.disabled = switchingReasoningMode;
      if (reasoningMenuCard.classList.contains('is-open')) renderReasoningMenu();
    }
    function updateReasoningFromStatus(data) {
      const mode = bestReasoningMode(data?.reasoningMode || null, data?.threadId || selectedThreadId);
      renderReasoningBadge(mode);
    }
    function reasoningSwitchTarget(mode = currentReasoningMode) {
      const order = REASONING_MODE_OPTIONS.map(item => item.key);
      const currentIndex = order.indexOf(currentReasoningKey(mode));
      return order[(currentIndex + 1 + order.length) % order.length] || 'medium';
    }
    async function switchReasoningMode(targetKey = '') {
      if (switchingReasoningMode) return;
      if (!selectedThreadId) {
        setNotice('请先选择一个已有线程', 'error');
        return;
      }
      const requestedTarget = String(targetKey || '').trim() || reasoningSwitchTarget();
      switchingReasoningMode = true;
      renderReasoningBadge();
      setWorkingDot(true);
      setNotice('正在通过 Codex GUI 切换推理模式…', 'ok');
      try {
        await ensureRouteForSend();
        const response = await fetchApi('/codex/reasoning-mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
          body: JSON.stringify({ threadId: selectedThreadId, target: requestedTarget }),
          apiTimeoutMs: 20000,
          routeSwitchQuiet: true,
          retryProbeTimeoutMs: 900,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.message || '切换推理模式失败');
        if (data.targetReasoningMode) {
          writeReasoningOverride(selectedThreadId, data.targetReasoningMode);
          renderReasoningBadge(data.targetReasoningMode);
        }
        setNotice(data.message || '已切换推理模式', 'ok');
        window.setTimeout(() => refreshCurrentThreadIfChanged(), 900);
      } catch (error) {
        setNotice(error.message || '切换推理模式失败', 'error');
      } finally {
        switchingReasoningMode = false;
        renderReasoningBadge();
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
      }
    }
    function readModelOverrides() {
      try {
        const parsed = JSON.parse(localStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    function writeModelOverride(threadId, model) {
      if (!threadId || !model) return;
      const rows = readModelOverrides();
      rows[threadId] = { ...model, updatedAt: model.updatedAt || new Date().toISOString(), local: true };
      try { localStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify(rows)); } catch {}
    }
    function modelTime(model) {
      const time = Date.parse(model?.updatedAt || '');
      return Number.isFinite(time) ? time : 0;
    }
    function overrideModelForThread(threadId = selectedThreadId) {
      if (!threadId) return null;
      return readModelOverrides()[threadId] || null;
    }
    function bestModelInfo(model = null, threadId = selectedThreadId) {
      const override = overrideModelForThread(threadId);
      if (override && (!model || modelTime(override) >= modelTime(model))) return override;
      return model || override || null;
    }
    function modelMenuOptionByKey(targetKey = '') {
      return modelMenuOptions.find(item => item.key === targetKey) || null;
    }
    function applyModelOptions(options = []) {
      if (!Array.isArray(options) || !options.length) return;
      const next = options
        .filter(item => item)
        .map(item => {
          if (typeof item === 'string') {
            return { key: item, id: item, label: item, displayName: item };
          }
          const id = String(item.id || item.key || item.model || item.slug || item.displayName || item.label || '').trim();
          if (!id) return null;
          return {
            key: String(item.key || id),
            id,
            label: String(item.label || item.displayName || item.display_name || item.name || id),
            displayName: String(item.displayName || item.display_name || item.label || item.name || id),
          };
        })
        .filter(Boolean);
      if (next.length) {
        const seen = new Set();
        modelMenuOptions = next.filter(item => {
          const key = String(item.id || item.key).toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (modelMenuCard.classList.contains('is-open')) renderModelMenu();
      }
    }
    function currentModelMenuKey(model = currentModelInfo) {
      const id = String(model?.id || '').trim();
      return modelMenuOptions.find(item => item.id === id)?.key || '';
    }
    function modelSpeedKey(value = '') {
      return String(value || '').trim().toLowerCase().replace(/[^a-z0-9.]+/g, '');
    }
    function modelSupportsSpeed(model = null) {
      const candidates = [
        model?.id,
        model?.key,
        model?.label,
        model?.displayName,
        model?.display_name,
        model?.version,
        typeof model === 'string' ? model : '',
      ].map(modelSpeedKey).filter(Boolean);
      return candidates.some(key => key === 'gpt5.5' || key === 'gpt5.4' || key === 'gpt55' || key === 'gpt54' || key === '5.5' || key === '5.4' || key === '55' || key === '54');
    }
    function updateSpeedSupportFromModel(model = currentModelInfo, forced = null) {
      speedSupported = typeof forced === 'boolean' ? forced : modelSupportsSpeed(model);
      if (!speedSupported) {
        currentSpeedMode = null;
        closeSpeedMenu();
      }
      renderSpeedBadge(currentSpeedMode);
    }
    function renderModelMenu() {
      const currentKey = currentModelMenuKey();
      modelMenuCard.textContent = '';
      for (const item of modelMenuOptions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `model-menu-item${item.key === currentKey ? ' is-current' : ''}`;
        button.dataset.target = item.key;
        button.textContent = item.label;
        button.title = item.displayName;
        button.setAttribute('aria-label', `${item.displayName}${item.key === currentKey ? '（当前）' : ''}`);
        wireInstantActionButton(button, () => {
          if (switchingModel) return;
          if (item.key === currentKey) {
            closeModelMenu();
            setNotice(`当前已是 ${item.displayName}`, 'ok');
            return;
          }
          closeModelMenu();
          switchCurrentModel(item.key);
        });
        modelMenuCard.appendChild(button);
      }
    }
    function renderModelBadge(model = currentModelInfo) {
      currentModelInfo = model || null;
      const label = model?.label || '--';
      const source = model?.source || 'unknown';
      modelText.textContent = label;
      modelBadge.className = `model-badge is-${source}${switchingModel ? ' is-switching' : ''}`;
      const sourceText = source === 'official' ? '官方' : source === 'local' ? '本机' : '未知';
      const display = model?.displayName || model?.id || '暂未读到当前模型';
      modelBadge.title = `${sourceText} · ${display}`;
      modelBadge.setAttribute('aria-label', `当前模型：${sourceText} ${label || display}。点击打开模型选择菜单。`);
      modelBadge.disabled = switchingModel;
      if (modelMenuCard.classList.contains('is-open')) renderModelMenu();
    }
    function updateModelFromStatus(data) {
      const model = bestModelInfo(data?.targetModel || data?.currentModel || data?.model || null, data?.threadId || selectedThreadId);
      renderModelBadge(model);
      updateSpeedSupportFromModel(model, typeof data?.speedSupported === 'boolean' ? data.speedSupported : null);
    }
    function modelSwitchTarget(model = currentModelInfo) {
      return currentModelMenuKey(model) || modelMenuOptions[0]?.key || '';
    }
    async function switchCurrentModel(targetKey = '') {
      if (switchingModel) return;
      if (!selectedThreadId) {
        setNotice('请先选择一个已有线程', 'error');
        return;
      }
      const requestedTarget = String(targetKey || '').trim() || modelSwitchTarget();
      switchingModel = true;
      renderModelBadge();
      setWorkingDot(true);
      setNotice('正在通过 Codex GUI 切换模型…', 'ok');
      try {
        await ensureRouteForSend();
        const response = await fetchApi('/codex/model-switch', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
          body: JSON.stringify({ threadId: selectedThreadId, target: requestedTarget }),
          apiTimeoutMs: 20000,
          routeSwitchQuiet: true,
          retryProbeTimeoutMs: 900,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.message || '切换模型失败');
        if (data.targetModel) {
          writeModelOverride(selectedThreadId, data.targetModel);
          renderModelBadge(data.targetModel);
          updateSpeedSupportFromModel(data.targetModel, typeof data.speedSupported === 'boolean' ? data.speedSupported : null);
        }
        setNotice(data.message || '已切换模型', 'ok');
        window.setTimeout(() => refreshCurrentThreadIfChanged(), 900);
      } catch (error) {
        setNotice(error.message || '切换模型失败', 'error');
      } finally {
        switchingModel = false;
        renderModelBadge();
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
      }
    }
    function readSpeedOverrides() {
      try {
        const parsed = JSON.parse(localStorage.getItem(SPEED_OVERRIDE_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    function writeSpeedOverride(threadId, mode) {
      if (!threadId || !mode) return;
      const normalized = normalizeSpeedMode(mode);
      if (!normalized.key) return;
      const rows = readSpeedOverrides();
      rows[threadId] = { ...normalized, updatedAt: normalized.updatedAt || new Date().toISOString(), local: true };
      try { localStorage.setItem(SPEED_OVERRIDE_STORAGE_KEY, JSON.stringify(rows)); } catch {}
    }
    function speedTime(mode) {
      const time = Date.parse(mode?.updatedAt || '');
      return Number.isFinite(time) ? time : 0;
    }
    function overrideSpeedForThread(threadId = selectedThreadId) {
      if (!threadId) return null;
      return readSpeedOverrides()[threadId] || null;
    }
    function speedOptionByKey(targetKey = '') {
      return SPEED_MODE_OPTIONS.find(item => item.key === targetKey) || null;
    }
    function speedKeyFromValue(value = '') {
      const raw = String(value || '').trim().toLowerCase();
      if (['standard', 'default', 'normal', 'auto', '标准', '默认'].includes(raw)) return 'standard';
      if (['fast', 'priority', 'quick', '快速', '高速', '1.5x'].includes(raw)) return 'fast';
      return '';
    }
    function normalizeSpeedOption(item) {
      const key = speedKeyFromValue(item?.key || item?.mode || item?.value || item?.serviceTier || item?.label || item?.displayName || item?.display_name || item?.name || item);
      if (!key) return null;
      const fallback = key === 'fast' ? '高速' : '标准';
      return {
        key,
        value: key === 'fast' ? 'priority' : 'default',
        serviceTier: key === 'fast' ? 'priority' : 'default',
        label: String(item?.label || item?.displayName || item?.display_name || item?.name || fallback),
        displayName: String(item?.displayName || item?.display_name || item?.label || item?.name || fallback),
      };
    }
    function replaceSpeedOptions(options = []) {
      const normalized = [];
      for (const item of options) {
        const option = normalizeSpeedOption(item);
        if (option && !normalized.some(row => row.key === option.key)) normalized.push(option);
      }
      if (normalized.length) SPEED_MODE_OPTIONS.splice(0, SPEED_MODE_OPTIONS.length, ...normalized);
    }
    function applyClientModeOptions(data = {}) {
      applyModelOptions(data?.modelOptions || []);
      if (Array.isArray(data?.reasoningOptions)) replaceReasoningOptions(data.reasoningOptions);
      if (Array.isArray(data?.speedOptions)) replaceSpeedOptions(data.speedOptions);
    }
    function normalizeSpeedMode(mode = null) {
      if (typeof mode === 'string') {
        const option = speedOptionByKey(speedKeyFromValue(mode));
        return option ? { ...option } : { key: '', value: mode, label: '', displayName: mode };
      }
      const key = speedKeyFromValue(mode?.key || mode?.value || mode?.serviceTier || mode?.label || mode?.displayName || '');
      const option = speedOptionByKey(key);
      return option ? { ...option, ...mode, key: option.key, value: option.value, serviceTier: option.serviceTier, label: option.label, displayName: option.displayName } : (mode || null);
    }
    function bestSpeedMode(mode = null, threadId = selectedThreadId) {
      const normalized = normalizeSpeedMode(mode);
      const override = overrideSpeedForThread(threadId);
      if (override && (!normalized || speedTime(override) >= speedTime(normalized))) return override;
      return normalized || override || null;
    }
    function currentSpeedKey(mode = currentSpeedMode) {
      const normalized = normalizeSpeedMode(mode);
      const key = String(normalized?.key || '').trim();
      return speedOptionByKey(key) ? key : 'standard';
    }
    function renderSpeedMenu() {
      if (!speedSupported) {
        closeSpeedMenu();
        return;
      }
      const currentKey = currentSpeedKey();
      speedMenuCard.textContent = '';
      for (const item of SPEED_MODE_OPTIONS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `model-menu-item speed-menu-item mode-${item.key}${item.key === currentKey ? ' is-current' : ''}`;
        button.dataset.target = item.key;
        button.textContent = item.label;
        button.title = `速度：${item.displayName}`;
        button.setAttribute('aria-label', `速度：${item.displayName}${item.key === currentKey ? '（当前）' : ''}`);
        wireInstantActionButton(button, () => {
          if (switchingSpeedMode) return;
          if (item.key === currentKey) {
            closeSpeedMenu();
            setNotice(`当前已是${item.displayName}速度`, 'ok');
            return;
          }
          closeSpeedMenu();
          switchSpeedMode(item.key);
        });
        speedMenuCard.appendChild(button);
      }
    }
    function renderSpeedBadge(mode = currentSpeedMode) {
      if (!speedSupported) {
        currentSpeedMode = null;
        speedBadge.hidden = true;
        speedBadge.disabled = true;
        closeSpeedMenu();
        return;
      }
      speedBadge.hidden = false;
      const normalized = normalizeSpeedMode(mode);
      currentSpeedMode = normalized || null;
      const modeKey = currentSpeedKey(normalized);
      const option = speedOptionByKey(modeKey) || SPEED_MODE_OPTIONS[0];
      speedText.textContent = option.label;
      speedBadge.className = `speed-badge mode-${modeKey}${switchingSpeedMode ? ' is-switching' : ''}`;
      speedBadge.title = `速度：${option.displayName}`;
      speedBadge.setAttribute('aria-label', `当前速度：${option.displayName}。点击打开标准、高速选择菜单。`);
      speedBadge.disabled = switchingSpeedMode;
      if (speedMenuCard.classList.contains('is-open')) renderSpeedMenu();
    }
    function updateSpeedFromStatus(data) {
      if (typeof data?.speedSupported === 'boolean') {
        speedSupported = data.speedSupported;
      }
      const mode = bestSpeedMode(data?.targetSpeedMode || data?.speedMode || data?.currentSpeed || null, data?.threadId || selectedThreadId);
      renderSpeedBadge(mode);
    }
    function speedSwitchTarget(mode = currentSpeedMode) {
      return currentSpeedKey(mode) === 'fast' ? 'standard' : 'fast';
    }
    async function switchSpeedMode(targetKey = '') {
      if (switchingSpeedMode) return;
      if (!speedSupported) {
        setNotice('当前模型不支持速度调节；请切换到 GPT-5.5 或 GPT-5.4。', 'error');
        return;
      }
      if (!selectedThreadId) {
        setNotice('请先选择一个已有线程', 'error');
        return;
      }
      const requestedTarget = String(targetKey || '').trim() || speedSwitchTarget();
      switchingSpeedMode = true;
      renderSpeedBadge();
      setWorkingDot(true);
      setNotice('正在通过 Codex GUI 切换速度…', 'ok');
      try {
        await ensureRouteForSend();
        const response = await fetchApi('/codex/speed-mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
          body: JSON.stringify({ threadId: selectedThreadId, target: requestedTarget }),
          apiTimeoutMs: 20000,
          routeSwitchQuiet: true,
          retryProbeTimeoutMs: 900,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.message || '切换速度失败');
        if (data.targetSpeedMode) {
          writeSpeedOverride(selectedThreadId, data.targetSpeedMode);
          renderSpeedBadge(data.targetSpeedMode);
        }
        setNotice(data.message || '已切换速度', 'ok');
        window.setTimeout(() => refreshCurrentThreadIfChanged(), 900);
      } catch (error) {
        setNotice(error.message || '切换速度失败', 'error');
      } finally {
        switchingSpeedMode = false;
        renderSpeedBadge();
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
      }
    }
    function setWorkingDot(active) {
      foregroundDotBusy = Boolean(active);
      document.body.classList.toggle('is-working', foregroundDotBusy);
      updateTitleDotState();
    }
    function isPrivateIpv4(hostname) {
      const parts = String(hostname || '').split('.');
      if (parts.length !== 4) return false;
      const octets = parts.map(part => Number(part));
      if (octets.some((value, index) => !Number.isInteger(value) || value < 0 || value > 255 || String(value) !== parts[index])) return false;
      if (octets[0] === 10) return true;
      if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
      return octets[0] === 192 && octets[1] === 168;
    }
    function classifyLocationHost(hostname) {
      const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
      if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'desktop-local';
      if (isPrivateIpv4(host) || host.endsWith('.local') || !host.includes('.')) return 'lan';
      if (host.endsWith('nyat.app') || host.endsWith('frp-use.com')) return 'sakura';
      return 'sakura';
    }
    function isRemoteEntryKind(kind) {
      return kind === 'sakura' || kind === 'sakura-tcp';
    }
    function routeTextForKind(kind) {
      if (kind === 'desktop-local') return '本机';
      if (kind === 'lan') return '局域网';
      if (kind === 'sakura') return '远程';
      if (kind === 'sakura-tcp') return '远程备用';
      return '连接';
    }
    function routeBadgeClassForKind(kind) {
      if (kind === 'desktop-local' || kind === 'lan' || kind === 'sakura' || kind === 'sakura-tcp') return kind;
      return 'unknown';
    }
    function routeIconMarkup(kind) {
      if (kind === 'sakura' || kind === 'sakura-tcp') {
        return '<path d="M12 3v18"></path><path d="M5 8h14"></path><path d="M5 16h14"></path><path d="M7 4.5a16 16 0 0 0 0 15"></path><path d="M17 4.5a16 16 0 0 1 0 15"></path>';
      }
      if (kind === 'desktop-local') {
        return '<rect x="4" y="5" width="16" height="11" rx="2"></rect><path d="M8 20h8"></path><path d="M12 16v4"></path>';
      }
      return '<path d="m3 11 9-7 9 7"></path><path d="M5 10v9h14v-9"></path><path d="M9 19v-6h6v6"></path>';
    }
    const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V4h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1z"></path></svg>';
    const ARCHIVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>';
    const RENAME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
    threadCurrentPin.innerHTML = PIN_ICON;
    threadActionArchiveIcon.innerHTML = ARCHIVE_ICON;
    threadActionRenameIcon.innerHTML = RENAME_ICON;
    threadActionPinToggleIcon.innerHTML = PIN_ICON;
    function updateRouteBadge() {
      const text = routeTextForKind(activeApiKind);
      routeBadge.className = `route-badge is-${routeBadgeClassForKind(activeApiKind)}`;
      routeIcon.innerHTML = routeIconMarkup(activeApiKind);
      routeText.textContent = text;
      routeBadge.title = `当前线路：${text}`;
      routeBadge.setAttribute('aria-label', routeBadge.title);
    }
    function routeLabel(candidate) {
      return routeTextForKind(candidate?.kind || 'lan');
    }
    function makeCandidate(id, baseUrl, label, kind, priority) {
      const normalized = normalizeBaseUrl(baseUrl);
      if (!normalized) return null;
      return {
        id: String(id || `${kind}:${normalized}`),
        baseUrl: normalized,
        label: label || routeTextForKind(kind),
        kind: kind || 'lan',
        priority: Number.isFinite(Number(priority)) ? Number(priority) : 100,
        lastOkAt: 0,
        lastFailedAt: 0,
        failCount: 0,
      };
    }
    function routeBackoffMs(candidate) {
      const failures = Math.min(Number(candidate?.failCount || 0), 6);
      return Math.min(60000, 1000 * Math.pow(2, failures));
    }
    function routeCanProbe(candidate) {
      if (!candidate) return false;
      const lastFailedAt = Number(candidate.lastFailedAt || 0);
      return !lastFailedAt || Date.now() - lastFailedAt >= routeBackoffMs(candidate);
    }
    function recordRouteProbe(candidate, ok) {
      if (!candidate) return;
      if (ok) {
        candidate.lastOkAt = Date.now();
        candidate.lastFailedAt = 0;
        candidate.failCount = 0;
      } else {
        candidate.lastFailedAt = Date.now();
        candidate.failCount = Number(candidate.failCount || 0) + 1;
      }
    }
    function mergeApiCandidates(candidates) {
      const byBase = new Map();
      for (const candidate of candidates) {
        if (!candidate?.baseUrl) continue;
        const existing = byBase.get(candidate.baseUrl);
        if (
          !existing ||
          (existing.id === 'current' && candidate.id !== 'current') ||
          (candidate.id !== 'current' && candidate.priority < existing.priority) ||
          (candidate.id === 'current' && existing.id === 'current' && candidate.priority < existing.priority)
        ) {
          byBase.set(candidate.baseUrl, candidate);
        }
      }
      apiCandidates = [...byBase.values()].sort((a, b) => a.priority - b.priority);
      try {
        localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(apiCandidates.filter(item => item.id !== 'current')));
      } catch {}
      if (!apiCandidates.some(item => item.baseUrl === activeApiBase)) {
        const first = apiCandidates[0];
        if (first) {
          activeApiBase = first.baseUrl;
          activeApiLabel = routeLabel(first);
          activeApiKind = first.kind || 'lan';
          updateRouteBadge();
        }
      }
    }
    function readStoredApiCandidates() {
      try {
        const rows = JSON.parse(localStorage.getItem(ROUTE_STORAGE_KEY) || '[]');
        return Array.isArray(rows) ? rows.map((item, index) => makeCandidate(
          item.id || `stored-${index}`,
          item.baseUrl,
          item.label,
          item.kind === 'local' ? 'desktop-local' : item.kind,
          Number.isFinite(Number(item.priority)) ? Number(item.priority) : 50 + index,
        )).filter(Boolean) : [];
      } catch {
        return [];
      }
    }
    async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        window.clearTimeout(timer);
      }
    }
    async function probeApiCandidate(candidate, timeoutMs = 2500) {
      if (!candidate?.baseUrl || !token) return false;
      const params = new URLSearchParams({ token, t: String(Date.now()) });
      try {
        const response = await fetchWithTimeout(`${candidate.baseUrl}/codex/health?${params}`, { cache: 'no-store' }, timeoutMs);
        const data = await response.json().catch(() => ({}));
        return response.ok && data.ok;
      } catch {
        return false;
      }
    }
    async function chooseApiCandidate(options = {}) {
      const { preferLocal = false, preferCurrent = false, quiet = false, excludeBase = '', probeTimeoutMs = 2500 } = options;
      const ordered = [...apiCandidates].sort((a, b) => {
        const currentBiasA = preferCurrent && a.baseUrl === currentApiBase ? -1000 : 0;
        const currentBiasB = preferCurrent && b.baseUrl === currentApiBase ? -1000 : 0;
        const localBiasA = preferLocal && (a.kind === 'desktop-local' || a.kind === 'lan' || a.kind === 'local') ? -100 : 0;
        const localBiasB = preferLocal && (b.kind === 'desktop-local' || b.kind === 'lan' || b.kind === 'local') ? -100 : 0;
        return (a.priority + currentBiasA + localBiasA) - (b.priority + currentBiasB + localBiasB);
      });
      for (const candidate of ordered) {
        if (excludeBase && candidate.baseUrl === excludeBase) continue;
        if (!options.force && !routeCanProbe(candidate)) continue;
        const ok = await probeApiCandidate(candidate, probeTimeoutMs);
        recordRouteProbe(candidate, ok);
        if (ok) {
          const changed = activeApiBase !== candidate.baseUrl;
          activeApiBase = candidate.baseUrl;
          activeApiLabel = routeLabel(candidate);
          activeApiKind = candidate.kind || 'lan';
          updateRouteBadge();
          if (changed && !quiet) setNotice(`网络已自动切换到 ${routeTextForKind(activeApiKind)}`, 'ok');
          return candidate;
        }
      }
      return null;
    }
    async function loadApiConfig() {
      const baseCandidates = [
        makeCandidate('current', currentApiBase, currentApiLabel, currentApiKind, shouldPreferCurrentApiBase ? 0 : 100),
        ...readStoredApiCandidates(),
      ].filter(Boolean);
      mergeApiCandidates(baseCandidates);

      const params = new URLSearchParams({ token });
      try {
        const response = await fetchWithTimeout(`${currentApiBase}/codex/config?${params}`, { cache: 'no-store' }, 5000);
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message || '读取线路配置失败');
        applyClientModeOptions(data);
        renderModelBadge(currentModelInfo);
        if (data.currentModel) {
          const configModel = bestModelInfo(data.currentModel, selectedThreadId);
          renderModelBadge(configModel);
          updateSpeedSupportFromModel(configModel, typeof data.speedSupported === 'boolean' ? data.speedSupported : null);
        } else if (typeof data.speedSupported === 'boolean') {
          updateSpeedSupportFromModel(currentModelInfo, data.speedSupported);
        } else {
          updateSpeedSupportFromModel(currentModelInfo);
        }
        if (data.currentReasoning) renderReasoningBadge(bestReasoningMode(data.currentReasoning, selectedThreadId));
        if (data.currentSpeed) renderSpeedBadge(bestSpeedMode(data.currentSpeed, selectedThreadId));
        else renderSpeedBadge(bestSpeedMode(null, selectedThreadId));
        const serverRoutes = Array.isArray(data.apiRoutes)
          ? data.apiRoutes.map((item, index) => makeCandidate(item.id || `api-${index}`, item.baseUrl, item.label, item.kind, item.priority))
          : [
              ...(data.localApiBases || []).map((base, index) => makeCandidate(`lan-${index}`, base, '局域网', 'lan', 10 + index)),
              ...(data.remoteApiBases || []).map((base, index) => makeCandidate(`sakura-${index}`, base, '远程', 'sakura', 30 + index)),
            ];
        const configured = [
          ...baseCandidates,
          ...serverRoutes,
        ].filter(Boolean);
        mergeApiCandidates(configured);
        lastApiConfigRefreshAt = Date.now();
      } catch (error) {
        console.warn('Codex2Frp route config skipped:', error);
      }
    }
    async function refreshApiConfigIfNeeded(options = {}) {
      if (apiConfigRefreshBusy) return;
      const now = Date.now();
      if (!options.force && now - lastApiConfigRefreshAt < API_CONFIG_REFRESH_MIN_MS) return;
      apiConfigRefreshBusy = true;
      try {
        await loadApiConfig();
      } finally {
        apiConfigRefreshBusy = false;
      }
    }
    async function fetchApi(path, options = {}) {
      const timeoutMs = options.apiTimeoutMs || 12000;
      const requestOptions = { ...options };
      delete requestOptions.apiTimeoutMs;
      delete requestOptions.routeSwitchQuiet;
      delete requestOptions.retryProbeTimeoutMs;
      return fetchWithTimeout(apiUrl(path), requestOptions, timeoutMs);
    }

    async function refreshSakuraStatus() {
      if (sakuraStatusBusy || !token) return;
      sakuraStatusBusy = true;
      try {
        const params = new URLSearchParams({ token, refresh: '1' });
        const response = await fetchApi(`/codex/sakura/status?${params}`, { cache: 'no-store', apiTimeoutMs: 8000, routeSwitchQuiet: true });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.ok) sakuraStatus = data;
      } catch (error) {
        console.warn('Codex2Frp remote status skipped:', error);
      } finally {
        sakuraStatusBusy = false;
      }
    }


    function renderKeepAwakeButton() {
      if (!keepAwakeButton) return;
      keepAwakeButton.hidden = true;
      keepAwakeButton.disabled = keepAwakeBusy;
      keepAwakeButton.classList.toggle('is-on', Boolean(keepAwakeEnabled));
      keepAwakeButton.classList.toggle('is-busy', Boolean(keepAwakeBusy));
      const label = keepAwakeEnabled ? '保持亮屏已开启' : '保持亮屏';
      keepAwakeButton.title = keepAwakeEnabled ? '已阻止这台 Windows 电脑自动休眠，点击关闭' : '阻止这台 Windows 电脑自动休眠和熄屏';
      keepAwakeButton.setAttribute('aria-label', label);
    }

    async function refreshKeepAwakeStatus() {
      return;
      try {
        const params = new URLSearchParams({ token });
        const response = await fetchApi(`/codex/keep-awake?${params}`, { cache: 'no-store', apiTimeoutMs: 8000, routeSwitchQuiet: true });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.message || '读取保持亮屏状态失败');
        keepAwakeEnabled = Boolean(data.enabled);
        renderKeepAwakeButton();
      } catch (error) {
        console.warn('Codex2Frp keep-awake status skipped:', error);
      }
    }

    async function toggleKeepAwake() {
      return;
      keepAwakeBusy = true;
      renderKeepAwakeButton();
      const nextEnabled = !keepAwakeEnabled;
      try {
        const response = await fetchApi('/codex/keep-awake', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
          body: JSON.stringify({ enabled: nextEnabled }),
          apiTimeoutMs: 10000,
          routeSwitchQuiet: true,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.message || '切换保持亮屏失败');
        keepAwakeEnabled = Boolean(data.enabled);
        setNotice(data.message || (keepAwakeEnabled ? '已开启保持亮屏' : '已关闭保持亮屏'), 'ok');
      } catch (error) {
        setNotice(error.message || '切换保持亮屏失败', 'error');
      } finally {
        keepAwakeBusy = false;
        renderKeepAwakeButton();
      }
    }
    async function ensureRouteForSend() {
      return;
      const active = apiCandidates.find(item => item.baseUrl === activeApiBase);
      if (!active || (active.kind !== 'desktop-local' && active.kind !== 'lan')) return;
      if (await probeApiCandidate(active, 700)) return;
      await chooseApiCandidate({ preferLocal: false, excludeBase: active.baseUrl, quiet: true, probeTimeoutMs: 900 });
    }
    function startRouteMonitor() {
      window.setInterval(async () => {
        return;
        if (document.hidden || routeMonitorBusy) return;
        routeMonitorBusy = true;
        const active = apiCandidates.find(item => item.baseUrl === activeApiBase);
        try {
          if (active?.kind === 'desktop-local' || active?.kind === 'lan') {
            if (await probeApiCandidate(active, 900)) return;
            await chooseApiCandidate({ preferLocal: false, excludeBase: active.baseUrl, quiet: true, probeTimeoutMs: 900 });
            return;
          }
          await chooseApiCandidate({ preferLocal: true, quiet: true, probeTimeoutMs: 1200 });
        } finally {
          routeMonitorBusy = false;
        }
      }, 5000);
    }
    function scrollBottom(options = {}) {
      const apply = () => {
        if (options.instant) thread.classList.add('is-instant-scroll');
        thread.scrollTop = thread.scrollHeight;
        if (options.instant) {
          requestAnimationFrame(() => thread.classList.remove('is-instant-scroll'));
        }
      };
      if (options.instant) apply();
      else requestAnimationFrame(apply);
    }

    function replaceChildrenBatched(parent, children) {
      const fragment = document.createDocumentFragment();
      for (const child of children) fragment.appendChild(child);
      parent.textContent = '';
      parent.appendChild(fragment);
    }

    function setHistoryLoading(active, requestId = historyRequestId) {
      if (active) {
        thread.dataset.historyLoadingRequestId = String(requestId);
        thread.classList.add('is-loading-history');
        return;
      }
      if (!requestId || thread.dataset.historyLoadingRequestId === String(requestId)) {
        thread.classList.remove('is-loading-history');
        delete thread.dataset.historyLoadingRequestId;
      }
    }

    function beginHistoryRenderAtBottom() {
      thread.classList.add('is-history-rendering', 'is-instant-scroll');
    }

    function finishHistoryRenderAtBottom() {
      thread.scrollTop = thread.scrollHeight;
      requestAnimationFrame(() => {
        thread.scrollTop = thread.scrollHeight;
        thread.classList.remove('is-history-rendering');
        requestAnimationFrame(() => {
          thread.scrollTop = thread.scrollHeight;
          thread.classList.remove('is-instant-scroll');
        });
      });
    }

    function currentKeyboardShift() {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--keyboard-shift');
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : 0;
    }

    function keepLayoutViewportPinned() {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      const scroller = document.scrollingElement || document.documentElement;
      if (scroller && scroller.scrollTop) scroller.scrollTop = 0;
      if (document.body && document.body.scrollTop) document.body.scrollTop = 0;
    }

    function stableViewportHeight() {
      const viewportHeight = Math.round((window.visualViewport && window.visualViewport.height) || 0);
      return Math.round(Math.max(maxViewportHeight, window.innerHeight || 0, document.documentElement.clientHeight || 0, viewportHeight || 0));
    }

    function pinLayoutForKeyboardFocus() {
      keyboardPinTimers.forEach(timer => window.clearTimeout(timer));
      keepLayoutViewportPinned();
      maxViewportHeight = stableViewportHeight();
      document.documentElement.style.setProperty('--app-top', '0px');
      document.documentElement.style.setProperty('--app-height', `${maxViewportHeight}px`);
      keyboardPinTimers = [16, 32, 50, 80, 120, 180, 260, 360, 520].map(delay => window.setTimeout(keepLayoutViewportPinned, delay));
    }

    function prepareTextareaFocus(event) {
      const now = performance.now();
      const keyboardLikelyOpen = document.body.classList.contains('keyboard-open') || currentKeyboardShift() > 0 || keyboardShiftTarget > 0;
      let alreadyFocused = document.activeElement === textarea;
      const nativeTextareaEdit = alreadyFocused && event && event.target === textarea && (keyboardLikelyOpen || textarea.value);
      if (!nativeTextareaEdit && alreadyFocused && !keyboardLikelyOpen && event) {
        suppressNextTextareaBlurRestore = true;
        try {
          textarea.blur();
        } catch {}
        alreadyFocused = document.activeElement === textarea;
      }
      lastTextareaFocusPrepareAt = now;
      if (nativeTextareaEdit) {
        return;
      }
      if (!keyboardFocusStartedAt || !alreadyFocused) keyboardFocusStartedAt = now;
      pinLayoutForKeyboardFocus();
      if (event && event.cancelable) event.preventDefault();
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      if (!alreadyFocused) {
        try {
          textarea.focus({ preventScroll: true });
        } catch {
          textarea.focus();
        }
        beginKeyboardAlignment();
      } else {
        scheduleKeyboardAlignment();
      }
    }

    function shouldPrepareComposerFocus(target) {
      if (!target || !composer.contains(target)) return false;
      if (target === textarea) return true;
      if (target.closest('button, input, .attachment-tray, .queued-send-bar')) return target === textarea;
      return true;
    }

    function prepareComposerFocus(event) {
      if (!shouldPrepareComposerFocus(event.target)) return;
      prepareTextareaFocus(event);
    }

    function noteOutsideComposerTouch(event) {
      if (!event || !event.target) return;
      if (composerShell && composerShell.contains(event.target)) return;
      lastOutsideComposerTouchAt = performance.now();
    }

    function applyViewportSize() {
      const viewport = window.visualViewport;
      const viewportHeight = Math.round((viewport && viewport.height) || window.innerHeight || document.documentElement.clientHeight || 0);
      const baselineHeight = Math.round(Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, viewportHeight || 0));
      const focused = document.activeElement === textarea;
      if (!focused && !document.body.classList.contains('keyboard-open')) {
        maxViewportHeight = baselineHeight;
      } else if (!document.body.classList.contains('keyboard-open')) {
        maxViewportHeight = Math.max(maxViewportHeight, baselineHeight);
      }
      const viewportShrink = viewport ? Math.max(0, maxViewportHeight - viewportHeight) : 0;
      const focusAge = focused && keyboardFocusStartedAt ? performance.now() - keyboardFocusStartedAt : Infinity;
      const previousShift = currentKeyboardShift();
      const keyboardOpen = focused && (viewportShrink > 80 || previousShift > 0 || keyboardShiftTarget > 0 || focusAge < 900);
      document.body.classList.toggle('keyboard-open', keyboardOpen);
      document.documentElement.style.setProperty('--app-top', '0px');
      document.documentElement.style.setProperty('--app-height', `${Math.max(maxViewportHeight, viewportHeight)}px`);
      if (!keyboardOpen || !viewportHeight) {
        keyboardShiftTarget = 0;
        document.documentElement.style.setProperty('--keyboard-shift', '0px');
        keepLayoutViewportPinned();
        return false;
      }

      if (viewportShrink <= 80) {
        document.documentElement.style.setProperty('--keyboard-shift', `${Math.round(keyboardShiftTarget || previousShift || 0)}px`);
        keepLayoutViewportPinned();
        return true;
      }

      const composerBottomWithoutShift = composer.getBoundingClientRect().bottom + previousShift;
      const desiredGapRaw = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--keyboard-composer-gap'));
      const desiredGap = Number.isFinite(desiredGapRaw) ? desiredGapRaw : 0;
      const maxReasonableShift = Math.max(180, maxViewportHeight * 0.46);
      const maxShift = Math.max(0, Math.min(viewportShrink + 24, maxReasonableShift));
      const measuredShift = clampNumber(composerBottomWithoutShift - viewportHeight + desiredGap, 0, maxShift);
      const shiftTrimRaw = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--keyboard-shift-trim'));
      const shiftTrim = Number.isFinite(shiftTrimRaw) ? shiftTrimRaw : 36;
      const adjustedShift = clampNumber(measuredShift - shiftTrim, 0, maxShift);
      const nextShift = Math.max(keyboardShiftTarget, adjustedShift);
      keyboardShiftTarget = Math.round(nextShift);
      document.documentElement.style.setProperty('--keyboard-shift', `${keyboardShiftTarget}px`);
      keepLayoutViewportPinned();
      return true;
    }

    function alignComposerForKeyboard() {
      const keyboardOpen = applyViewportSize();
      if (keyboardAlignRaf) window.cancelAnimationFrame(keyboardAlignRaf);
      keyboardAlignRaf = requestAnimationFrame(() => {
        keyboardAlignRaf = 0;
        keepLayoutViewportPinned();
        thread.scrollTop = thread.scrollHeight;
        if (keyboardOpen && document.activeElement === textarea) {
          keyboardComposerRevealDone = true;
        }
      });
    }

    function scheduleKeyboardAlignment() {
      keyboardAlignmentTimers.forEach(timer => window.clearTimeout(timer));
      alignComposerForKeyboard();
      keyboardAlignmentTimers = [40, 90, 160, 280, 450, 700, 1000, 1300].map(delay => window.setTimeout(alignComposerForKeyboard, delay));
    }

    function beginKeyboardAlignment() {
      keyboardComposerRevealDone = false;
      keyboardFocusStartedAt = performance.now();
      pinLayoutForKeyboardFocus();
      scheduleKeyboardAlignment();
    }

    function startKeyboardMonitor() {
      // Intentionally empty: let iOS/Safari own keyboard layout.
    }

    function stopKeyboardMonitor() {
      if (!keyboardMonitorTimer) return;
      window.clearInterval(keyboardMonitorTimer);
      keyboardMonitorTimer = null;
    }

    function restoreLayoutAfterKeyboard() {
      if (suppressNextTextareaBlurRestore) {
        suppressNextTextareaBlurRestore = false;
        stopKeyboardMonitor();
        keyboardAlignmentTimers.forEach(timer => window.clearTimeout(timer));
        keyboardAlignmentTimers = [];
        document.body.classList.remove('keyboard-open');
        keyboardComposerRevealDone = false;
        keyboardFocusStartedAt = 0;
        keyboardShiftTarget = 0;
        document.documentElement.style.setProperty('--keyboard-shift', '0px');
        keepLayoutViewportPinned();
        return;
      }
      const now = performance.now();
      const recentInputFocus = now - lastTextareaFocusPrepareAt < 650;
      const recentOutsideDismiss = lastOutsideComposerTouchAt > lastTextareaFocusPrepareAt && now - lastOutsideComposerTouchAt < 700;
      if (recentInputFocus && !recentOutsideDismiss) {
        window.setTimeout(() => {
          if (document.activeElement === textarea) return;
          try {
            textarea.focus({ preventScroll: true });
          } catch {
            textarea.focus();
          }
          beginKeyboardAlignment();
        }, 40);
        return;
      }
      stopKeyboardMonitor();
      keyboardAlignmentTimers.forEach(timer => window.clearTimeout(timer));
      keyboardAlignmentTimers = [];
      keyboardPinTimers.forEach(timer => window.clearTimeout(timer));
      keyboardPinTimers = [];
      if (keyboardAlignRaf) {
        window.cancelAnimationFrame(keyboardAlignRaf);
        keyboardAlignRaf = 0;
      }
      document.body.classList.remove('keyboard-open');
      keyboardComposerRevealDone = false;
      keyboardFocusStartedAt = 0;
      keyboardShiftTarget = 0;
      document.documentElement.style.setProperty('--app-top', '0px');
      document.documentElement.style.setProperty('--app-height', `${Math.max(maxViewportHeight, window.innerHeight || 0, document.documentElement.clientHeight || 0)}px`);
      document.documentElement.style.setProperty('--keyboard-shift', '0px');
      keepLayoutViewportPinned();
      requestAnimationFrame(() => {
        thread.scrollTop = thread.scrollHeight;
      });
    }

    function readOpenProjectKeys() {
      try {
        const keys = JSON.parse(localStorage.getItem(GROUPS_STORAGE_KEY) || '[]');
        return new Set(Array.isArray(keys) ? keys.filter(Boolean) : []);
      } catch {
        return new Set();
      }
    }

    function persistOpenProjectKeys() {
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify([...openProjectKeys]));
    }

    function readCompletedThreadIds() {
      try {
        const raw = JSON.parse(localStorage.getItem(THREAD_NOTICE_STORAGE_KEY) || '[]');
        const rows = Array.isArray(raw)
          ? raw.map(id => ({ id, at: 0 }))
          : Array.isArray(raw?.rows)
            ? raw.rows
            : Array.isArray(raw?.ids)
              ? raw.ids.map(id => ({ id, at: raw.at || 0 }))
              : [];
        const ids = new Set();
        completedThreadNoticeTimes = new Map();
        for (const row of rows) {
          const id = typeof row === 'string' ? row : row?.id;
          if (!id) continue;
          const rawAt = typeof row === 'string' ? 0 : row.at;
          const at = typeof rawAt === 'number' ? rawAt : Date.parse(rawAt || '') || 0;
          ids.add(id);
          completedThreadNoticeTimes.set(id, at);
        }
        return ids;
      } catch {
        completedThreadNoticeTimes = new Map();
        return new Set();
      }
    }

    function persistCompletedThreadIds() {
      const rows = [...completedThreadIds].map(id => ({
        id,
        at: completedThreadNoticeTimes.get(id) || Date.now(),
      }));
      localStorage.setItem(THREAD_NOTICE_STORAGE_KEY, JSON.stringify({ version: 2, rows }));
    }

    function isCompletedThreadNoticeExpired(id, now = Date.now()) {
      const at = Number(completedThreadNoticeTimes.get(id)) || 0;
      return !at || now - at > THREAD_NOTICE_MAX_AGE_MS;
    }

    function hasUnreadCompletedThread() {
      const knownThreadIds = new Set(knownThreads.map(item => item.id).filter(Boolean));
      const now = Date.now();
      for (const id of completedThreadIds) {
        if (!id || id === selectedThreadId) continue;
        if (isCompletedThreadNoticeExpired(id, now)) continue;
        if (knownThreadIds.size && !knownThreadIds.has(id)) continue;
        return true;
      }
      return false;
    }

    function pruneCompletedThreadNotices() {
      const knownThreadIds = new Set(knownThreads.map(item => item.id).filter(Boolean));
      const now = Date.now();
      let changed = false;
      for (const id of [...completedThreadIds]) {
        const runtime = threadRuntimeStates.get(id);
        if (id === selectedThreadId || isCompletedThreadNoticeExpired(id, now) || (knownThreadIds.size && !knownThreadIds.has(id)) || isThreadRunningStatus(runtime?.status)) {
          completedThreadIds.delete(id);
          completedThreadNoticeTimes.delete(id);
          changed = true;
        }
      }
      if (changed) persistCompletedThreadIds();
      updateTitleDotState();
    }

    function hasOtherRunningThread() {
      for (const [id, runtime] of threadRuntimeStates) {
        if (id && id !== selectedThreadId && isThreadRunningStatus(runtime?.status)) return true;
      }
      for (const item of knownThreads) {
        if (!item?.id || item.id === selectedThreadId) continue;
        const runtime = threadRuntimeStates.get(item.id) || runtimeSnapshotFromThread(item) || {};
        if (isThreadRunningStatus(runtime.status)) return true;
      }
      return false;
    }

    function isSelectedThreadRunning() {
      const runtime = selectedThreadId ? threadRuntimeStates.get(selectedThreadId) : null;
      return Boolean(activeAssistant || pollTimer || isThreadRunningStatus(runtime?.status));
    }

    function updateTitleDotState() {
      const currentWorking = Boolean(foregroundDotBusy || isSelectedThreadRunning());
      const otherRunning = hasOtherRunningThread();
      const anyWorking = currentWorking || otherRunning;
      const unreadComplete = hasUnreadCompletedThread();
      document.body.classList.remove('dot-working', 'dot-background-working', 'dot-attention');
      document.body.classList.toggle('dot-flashing', anyWorking);
      document.body.classList.toggle('dot-blue', unreadComplete);
      document.body.classList.toggle('dot-orange', !unreadComplete && otherRunning);
    }

    function isThreadRunningStatus(status) {
      return status === 'running' || status === 'waiting';
    }

    function isThreadCompleteStatus(status) {
      return status === 'complete' || status === 'error';
    }

    function clearLocalStopSuppression(threadId) {
      if (!threadId) return;
      locallyStoppedThreads.delete(threadId);
    }

    function markThreadLocallyStopped(threadId) {
      if (!threadId) return;
      const now = Date.now();
      locallyStoppedThreads.set(threadId, {
        at: now,
        until: now + LOCAL_STOP_SUPPRESS_MS,
      });
    }

    function isLocalStopSuppressed(threadId, startedAt = '') {
      if (!threadId) return false;
      const entry = locallyStoppedThreads.get(threadId);
      if (!entry) return false;
      if (Date.now() > entry.until) {
        locallyStoppedThreads.delete(threadId);
        return false;
      }
      const startedMs = Date.parse(startedAt || '');
      if (Number.isFinite(startedMs) && startedMs > entry.at + 1000) {
        locallyStoppedThreads.delete(threadId);
        return false;
      }
      return true;
    }

    function suppressRunningSnapshotAfterLocalStop(threadId, snapshot) {
      if (!snapshot || !isThreadRunningStatus(snapshot.status) || !isLocalStopSuppressed(threadId, snapshot.startedAt)) return snapshot;
      return {
        ...snapshot,
        status: 'idle',
        active: false,
        updatedAt: new Date().toISOString(),
      };
    }

    function setThreadCompleteNotice(threadId, active, completedAtMs = Date.now()) {
      if (!threadId) return;
      const before = completedThreadIds.has(threadId);
      const beforeAt = completedThreadNoticeTimes.get(threadId) || 0;
      if (active && threadId !== selectedThreadId) {
        completedThreadIds.add(threadId);
        completedThreadNoticeTimes.set(threadId, completedAtMs || Date.now());
      } else {
        completedThreadIds.delete(threadId);
        completedThreadNoticeTimes.delete(threadId);
      }
      if (before !== completedThreadIds.has(threadId) || beforeAt !== (completedThreadNoticeTimes.get(threadId) || 0)) persistCompletedThreadIds();
      updateTitleDotState();
    }

    function runtimeSnapshotFromThread(item) {
      if (!item) return null;
      const status = item.runtimeStatus || '';
      if (!status) return null;
      return {
        status,
        active: Boolean(item.runtimeActive || isThreadRunningStatus(status)),
        startedAt: item.runtimeStartedAt || '',
        completedAt: item.runtimeCompletedAt || '',
        updatedAt: item.runtimeUpdatedAt || item.effectiveUpdatedAt || item.updatedAt || '',
        turnId: item.runtimeTurnId || '',
      };
    }

    function applyThreadRuntimeState(threadId, snapshot, options = {}) {
      if (!threadId || !snapshot) return;
      snapshot = suppressRunningSnapshotAfterLocalStop(threadId, snapshot);
      const previous = threadRuntimeStates.get(threadId);
      threadRuntimeStates.set(threadId, snapshot);
      if (threadId === selectedThreadId) {
        setThreadCompleteNotice(threadId, false);
        return;
      }
      if (isThreadRunningStatus(snapshot.status)) {
        setThreadCompleteNotice(threadId, false);
        return;
      }
      if (!options.detectTransitions || !isThreadCompleteStatus(snapshot.status) || !previous) return;
      const wasRunning = isThreadRunningStatus(previous.status);
      const changedToComplete = previous.status !== snapshot.status && isThreadCompleteStatus(snapshot.status);
      const previousTime = Date.parse(previous.completedAt || previous.updatedAt || '') || 0;
      const currentTime = Date.parse(snapshot.completedAt || snapshot.updatedAt || '') || 0;
      const isRecentCompletion = Boolean(currentTime && Date.now() - currentTime <= THREAD_NOTICE_MAX_AGE_MS);
      if (isRecentCompletion && (wasRunning || changedToComplete || (currentTime && previousTime && currentTime > previousTime))) {
        setThreadCompleteNotice(threadId, true, currentTime);
      }
    }

    function formatDuration(ms = 0) {
      const total = Math.max(0, Math.floor(Math.max(0, Number(ms) || 0) / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
    }

    function setMetaLabel(meta, label = '') {
      if (!meta) return;
      const text = String(label || '');
      const match = text.match(/^(.*?)(\d+m\s+\d+s|\d+s)$/);
      meta.textContent = '';
      if (!match) {
        meta.textContent = text;
        return;
      }
      meta.append(document.createTextNode(match[1] || ''));
      const duration = match[2] || '';
      let cursor = 0;
      for (const digitMatch of duration.matchAll(/\d+/g)) {
        const index = digitMatch.index || 0;
        if (index > cursor) meta.append(document.createTextNode(duration.slice(cursor, index)));
        const number = document.createElement('span');
        number.className = 'meta-duration-number';
        number.textContent = digitMatch[0];
        meta.append(number);
        cursor = index + digitMatch[0].length;
      }
      if (cursor < duration.length) meta.append(document.createTextNode(duration.slice(cursor)));
    }

    function parseTimeMs(value) {
      const parsed = Date.parse(value || '');
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function setActiveRunStart(startedAt = '', fallbackMs = Date.now()) {
      if (!activeAssistant || activeAssistant.runStartedAtMs) return;
      const parsed = parseTimeMs(startedAt);
      const startMs = parsed || fallbackMs;
      activeAssistant.runStartedAtMs = startMs;
      activeAssistant.runStartedAt = new Date(startMs).toISOString();
    }

    function activeRunDurationMs(endAt = '') {
      if (!activeAssistant) return 0;
      const startMs = Number(activeAssistant.runStartedAtMs) || parseTimeMs(activeAssistant.runStartedAt);
      if (!startMs) return 0;
      const endMs = parseTimeMs(endAt) || Date.now();
      return Math.max(0, endMs - startMs);
    }

    function finalRunDurationMs(data = {}) {
      const serverDuration = Number(data.durationMs);
      if (Number.isFinite(serverDuration) && serverDuration >= 0) return serverDuration;
      const timestampDuration = activeRunDurationMs(data.completedAt || data.updatedAt || '');
      if (timestampDuration) return timestampDuration;
      return activeRunDurationMs();
    }

    function updateActiveRunDuration(force = false) {
      if (!activeAssistant) return;
      const durationText = formatDuration(activeRunDurationMs());
      if (!force && durationText === activeAssistant.runDurationText) return;
      activeAssistant.runDurationText = durationText;
      const activeCommandUi = commandUi(activeAssistant.commandKind || '');
      setMetaLabel(activeAssistant.meta, activeCommandUi ? activeCommandUi.runningLabel(durationText) : `Codex · 运行 ${durationText}`);
      setTopStatus(activeCommandUi ? activeCommandUi.runningNotice(durationText) : `Codex 正在回复 · ${durationText}`);
    }

    function startRunDurationTimer() {
      if (runDurationTimer) return;
      runDurationTimer = window.setInterval(() => updateActiveRunDuration(false), 1000);
    }

    function stopRunDurationTimer() {
      if (runDurationTimer) window.clearInterval(runDurationTimer);
      runDurationTimer = null;
    }

    function commandKindForText(text) {
      return String(text || '').trim() === CONTEXT_COMPACT_COMMAND ? 'compact' : '';
    }

    function commandUi(commandKind) {
      if (commandKind === 'compact') {
        return {
          userLabel: '你 · 压缩',
          pendingText: '正在压缩中…',
          runningLabel: durationText => `Codex · 压缩 ${durationText}`,
          completeLabel: durationText => `Codex · 已压缩 ${durationText}`,
          runningNotice: durationText => `正在压缩 · ${durationText}`,
          completeText: '已压缩。',
        };
      }
      return null;
    }

    function latestUserCommandKind() {
      const users = [...thread.querySelectorAll('.message.user .bubble')];
      const latest = users[users.length - 1];
      return commandKindForText(latest?.textContent || '');
    }

    function stepMarkdown(steps = []) {
      if (!steps.length) return '已发送，等待 Codex 开始回复…';
      return steps.map(step => {
        if (step.kind === 'tool') return `- **工具**：${step.text || ''}`;
        if (step.kind === 'thinking') return step.text || '正在分析请求';
        if (step.kind === 'start') return `- **开始**：${step.text || '开始处理'}`;
        if (step.kind === 'complete') return `- **完成**：${step.text || '回复完成'}`;
        if (step.kind === 'error') return `- **失败**：${step.text || 'Codex 回复失败'}`;
        return `- **${step.label || '事件'}**：${step.text || ''}`;
      }).join('\n\n');
    }

    function renderProcessSteps(el, steps = []) {
      if (!steps.length) return setMarkdown(el, '已发送，等待 Codex 开始回复…');
      const previousRects = new Map();
      el.querySelectorAll('.process-tool[data-tool-key]').forEach(node => {
        previousRects.set(node.dataset.toolKey, node.getBoundingClientRect());
      });

      el.innerHTML = '';
      const feed = document.createElement('div');
      feed.className = 'process-feed';
      let currentToolRow = null;
      let toolGroupIndex = -1;
      let toolIndexInGroup = 0;
      const animatedTools = [];

      const animateToolLayout = item => {
        const previous = previousRects.get(item.dataset.toolKey);
        const next = item.getBoundingClientRect();
        if (previous) {
          const dx = previous.left - next.left;
          if (Math.abs(dx) > 1) {
            item.style.transition = 'none';
            item.style.transform = `translateX(${dx}px)`;
            animatedTools.push(item);
          }
        } else {
          item.style.transition = 'none';
          item.style.opacity = '0';
          item.style.transform = 'translateX(-10px) scale(.98)';
          animatedTools.push(item);
        }
      };

      const appendToolGroup = group => {
        if (!group.length) return;
        currentToolRow = document.createElement('div');
        currentToolRow.className = 'process-tool-row';
        currentToolRow.setAttribute('aria-label', '工具调用过程，可左右滑动查看');
        feed.appendChild(currentToolRow);
        for (let i = group.length - 1; i >= 0; i -= 1) {
          const step = group[i];
          const item = document.createElement('div');
          item.className = 'process-tool';
          item.textContent = step.text || '调用工具';
          item.dataset.toolKey = step.callId || `${toolGroupIndex}:${i}:${step.text || ''}`;
          currentToolRow.appendChild(item);
        }
      };

      let pendingToolGroup = [];
      const flushToolGroup = () => {
        if (!pendingToolGroup.length) return;
        toolGroupIndex += 1;
        toolIndexInGroup = 0;
        appendToolGroup(pendingToolGroup.map(step => ({ ...step, __toolIndex: toolIndexInGroup++ })));
        pendingToolGroup = [];
      };

      for (const step of steps) {
        if (step.kind === 'tool') {
          pendingToolGroup.push(step);
          continue;
        }

        flushToolGroup();
        currentToolRow = null;
        const item = document.createElement('div');
        if (step.kind === 'thinking') {
          item.className = 'process-thinking markdown-body';
          const body = document.createElement('div');
          body.innerHTML = markdownToHtml(step.text || '正在分析请求');
          item.append(body);
        } else {
          item.className = step.kind === 'complete' ? 'process-complete' : step.kind === 'error' ? 'process-error' : 'process-start';
          item.textContent = `${step.label || '事件'}：${step.text || ''}`;
        }
        feed.appendChild(item);
      }
      flushToolGroup();
      el.appendChild(feed);

      feed.querySelectorAll('.process-tool[data-tool-key]').forEach(animateToolLayout);
      if (animatedTools.length) {
        requestAnimationFrame(() => {
          for (const item of animatedTools) {
            item.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease-out';
            item.style.transform = '';
            item.style.opacity = '';
          }
          window.setTimeout(() => {
            for (const item of animatedTools) item.style.transition = '';
          }, 260);
        });
      }
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
    }

    function renderAttachmentTray() {
      attachmentTray.innerHTML = '';
      attachmentTray.classList.toggle('has-items', pendingAttachments.length > 0);
      pendingAttachments.forEach((item, index) => {
        const chip = document.createElement('div');
        const img = document.createElement('img');
        const remove = document.createElement('button');
        chip.className = 'attachment-chip';
        img.src = item.dataUrl;
        img.alt = item.name || '图片';
        remove.type = 'button';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          pendingAttachments.splice(index, 1);
          renderAttachmentTray();
          if (!window.matchMedia('(max-width: 700px), (pointer: coarse)').matches) {
      textarea.focus({ preventScroll: true });
    }
        });
        chip.append(img, remove);
        attachmentTray.appendChild(chip);
      });
    }

    function queuedSendSummary(text, attachments = []) {
      const body = String(text || '').replace(/\s+/g, ' ').trim();
      const imageText = attachments.length ? `${attachments.length} 张图片` : '';
      if (body && imageText) return `${body} · ${imageText}`;
      return body || imageText || '空消息';
    }

    function renderQueuedSends() {
      const count = queuedSends.length;
      queuedSend.classList.toggle('is-visible', count > 0);
      if (!count) {
        queuedSend.classList.remove('is-sending');
        queuedSendText.textContent = '';
        return;
      }
      const hasSending = queuedSends.some(item => item.state === 'sending');
      queuedSend.classList.toggle('is-sending', hasSending);
      queuedSendLabel.textContent = hasSending ? '发送中' : count > 1 ? `待发送 ${count}` : '待发送';
      queuedSendText.textContent = queuedSends.map(item => item.summary).join(' ｜ ');
    }

    function addQueuedSend(text, attachments = [], state = 'sending', options = {}) {
      const id = `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      queuedSends.push({ id, text, attachments: [...attachments], summary: queuedSendSummary(text, attachments), state, commandKind: options.commandKind || commandKindForText(text) });
      renderQueuedSends();
      return id;
    }

    function updateQueuedSend(id, state = 'queued') {
      const item = queuedSends.find(row => row.id === id);
      if (!item) return;
      item.state = state;
      renderQueuedSends();
    }

    function removeQueuedSend(id) {
      queuedSends = queuedSends.filter(row => row.id !== id);
      renderQueuedSends();
    }

    function clearQueuedSends() {
      if (!queuedSends.length) return;
      queuedSends = [];
      renderQueuedSends();
    }

    function watchSinceAfter(value) {
      const t = Date.parse(value || '');
      return new Date((Number.isFinite(t) ? t : Date.now()) + 1).toISOString();
    }

    function promoteNextQueuedSendAfterCurrent(data = {}) {
      if (!queuedSends.length) return false;
      const item = queuedSends.shift();
      renderQueuedSends();
      const attachments = Array.isArray(item.attachments) ? item.attachments : [];
      const itemCommandKind = item.commandKind || commandKindForText(item.text);
      const itemCommandUi = commandUi(itemCommandKind);
      const user = messageEl('user', item.text || (attachments.length ? ' ' : ''), { label: itemCommandUi?.userLabel || (attachments.length ? `你 · ${attachments.length} 张图片` : '你') });
      appendImagesToBubble(user, attachments);
      activeAssistant = messageEl('assistant', itemCommandUi?.pendingText || '已发送，等待 Codex 回复…', { label: itemCommandUi ? itemCommandUi.runningLabel('0s') : 'Codex · 运行 0s', pending: true });
      activeAssistant.commandKind = itemCommandKind;
      setActiveRunStart('', Date.now());
      if (selectedThreadId) {
        applyThreadRuntimeState(selectedThreadId, {
          status: 'waiting',
          active: true,
          startedAt: new Date().toISOString(),
          completedAt: '',
          updatedAt: new Date().toISOString(),
          turnId: '',
        }, { detectTransitions: false });
      }
      updateComposerAction();
      setNotice('上一条已完成，正在接上待发送消息…', 'ok');
      serializeMessages();
      startPolling({
        since: watchSinceAfter(data.completedAt || data.updatedAt || ''),
        threadId: data.threadId || selectedThreadId || '',
        sessionFile: data.sessionFile || activeWatch?.sessionFile || '',
      });
      return true;
    }

    function appendImagesToBubble(message, attachments) {
      if (!attachments.length) return;
      for (const item of attachments) {
        const img = document.createElement('img');
        img.className = 'attachment-preview';
        img.src = item.dataUrl;
        img.alt = item.name || '图片';
        message.bubble.appendChild(img);
      }
    }

    function messageEl(role, text, options = {}) {
      const article = document.createElement('article');
      article.className = `message ${role}${options.pending ? ' pending' : ''}`;
      const wrap = document.createElement('div');
      const meta = document.createElement('div');
      const bubble = document.createElement('div');
      wrap.className = 'bubble-wrap';
      meta.className = 'meta';
      bubble.className = 'bubble markdown-body';
      setMetaLabel(meta, options.label || (role === 'user' ? '你' : 'Codex'));
      setMarkdown(bubble, text);
      wrap.append(meta, bubble);
      article.appendChild(wrap);
      if (!options.skipAppend) {
        thread.appendChild(article);
        if (!options.skipScroll) scrollBottom();
      }
      return { article, bubble, meta, role };
    }

    function addDetails(message, steps = []) {
      const old = message.article.querySelector('details.process');
      if (old) old.remove();
      if (!steps.length) return;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const list = document.createElement('ul');
      details.className = 'process';
      list.className = 'steps';
      summary.textContent = '查看详细过程';
      for (const step of steps) {
        const li = document.createElement('li');
        li.textContent = `${step.label || '事件'}：${step.text || ''}`;
        list.appendChild(li);
      }
      details.append(summary, list);
      message.article.querySelector('.bubble-wrap').appendChild(details);
    }

    function captureVisibleProcessSteps(message) {
      if (!message?.bubble) return [];
      const steps = [];
      for (const node of [...message.bubble.querySelectorAll('.process-start, .process-complete, .process-error, .process-thinking, .process-tool')]) {
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        let label = '过程';
        if (node.classList.contains('process-thinking')) label = '思考';
        else if (node.classList.contains('process-tool')) label = '工具';
        else if (node.classList.contains('process-start')) label = '开始';
        else if (node.classList.contains('process-complete')) label = '完成';
        else if (node.classList.contains('process-error')) label = '失败';
        steps.push({ label, text });
      }
      const plain = message.bubble.textContent.replace(/\s+/g, ' ').trim();
      if (!steps.length && plain && plain !== '已发送，等待 Codex 开始回复…' && plain !== 'Codex 正在回复…') {
        steps.push({ label: '已生成内容', text: plain });
      }
      return steps;
    }

    function chatStorageKey(threadId = selectedThreadId) {
      return `${STORAGE_PREFIX}.${threadId || 'default'}`;
    }

    function clearThreadMessages() {
      fullHistoryRows = [];
      renderedHistoryOffset = 0;
      [...thread.querySelectorAll('.message, .load-older-history')].forEach(node => node.remove());
      clearQueuedSends();
    }

    function removeLoadingMessage(message) {
      if (message?.article?.isConnected) message.article.remove();
    }

    function isCurrentHistoryRequest(requestId, threadId) {
      return requestId === historyRequestId && threadId === selectedThreadId;
    }

    function replaceHistoryMessagesBatched(children) {
      const fragment = document.createDocumentFragment();
      for (const child of children) fragment.appendChild(child);
      [...thread.querySelectorAll('.message, .load-older-history')].forEach(node => node.remove());
      thread.appendChild(fragment);
    }

    function prependHistoryControl(control) {
      const firstHistoryMessage = thread.querySelector('.message');
      if (firstHistoryMessage) firstHistoryMessage.before(control);
      else thread.appendChild(control);
    }

    function updateThreadTitle() {
      if (pendingNewThread && !selectedThreadId) {
        const suffix = pendingNewThread.projectName && pendingNewThread.projectName !== '对话' ? ` · ${pendingNewThread.projectName}` : '';
        threadNameEl.textContent = `新线程${suffix}`;
        document.body.classList.remove('thread-current-pinned');
        document.title = `新线程${suffix} · Codex2Frp`;
        return;
      }
      const current = knownThreads.find(item => item.id === selectedThreadId);
      threadNameEl.textContent = current ? current.name : '选择线程';
      document.body.classList.toggle('thread-current-pinned', Boolean(current?.pinned));
      document.title = current ? `${current.name} · Codex2Frp` : 'Codex2Frp';
    }

    function formatRelativeTime(value) {
      const then = Date.parse(value || '');
      if (!Number.isFinite(then)) return '';
      const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
      if (seconds < 60) return '刚刚';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes} 分钟`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时`;
      const days = Math.floor(hours / 24);
      if (days < 7) return `${days} 天`;
      const weeks = Math.floor(days / 7);
      if (weeks < 8) return `${weeks} 周`;
      const months = Math.floor(days / 30);
      if (months < 12) return `${months} 个月`;
      return `${Math.floor(days / 365)} 年`;
    }

    function sortThreadsByTime(items) {
      return [...items].sort((a, b) => (Date.parse(b.effectiveUpdatedAt || b.updatedAt || '') || b.effectiveUpdatedMs || 0) - (Date.parse(a.effectiveUpdatedAt || a.updatedAt || '') || a.effectiveUpdatedMs || 0));
    }

    function threadMenuStateForItem(item) {
      const runtime = threadRuntimeStates.get(item.id) || runtimeSnapshotFromThread(item) || {};
      if (isThreadRunningStatus(runtime.status)) return 'running';
      if (completedThreadIds.has(item.id) && item.id !== selectedThreadId) return 'done';
      return 'time';
    }

    function threadMenuVisualSignature() {
      const threadPart = [...knownThreads]
        .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
        .map(item => `${item.id}:${item.name || ''}:${item.pinned ? 'pinned' : 'normal'}:${threadMenuStateForItem(item)}`)
        .join('|');
      const openPart = [...openProjectKeys].sort().join(',');
      return `${selectedThreadId}::${openPart}::${threadPart}`;
    }

    function renderThreadMenuIfVisualChanged() {
      if (threadMenuVisualSignature() !== lastThreadMenuSignature) renderThreadMenu();
    }

    function wireThreadMenuItemInteractions(button, item) {
      let timer = 0;
      let startPoint = null;
      let longPressOpened = false;
      let handledAt = 0;
      const cancel = () => {
        window.clearTimeout(timer);
        timer = 0;
        startPoint = null;
      };
      button.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        startPoint = { x: event.clientX || 0, y: event.clientY || 0 };
        longPressOpened = false;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          longPressOpened = true;
          handledAt = Date.now();
          clearNativeSelection();
          openThreadActionCard(item.id, { anchorElement: button, keepThreadMenu: true, vibrate: true });
        }, 560);
      });
      button.addEventListener('pointermove', event => {
        if (!startPoint) return;
        const dx = Math.abs((event.clientX || 0) - startPoint.x);
        const dy = Math.abs((event.clientY || 0) - startPoint.y);
        if (dx > 10 || dy > 10) cancel();
      });
      button.addEventListener('pointerup', event => {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        const shouldSelect = Boolean(startPoint && !longPressOpened);
        cancel();
        handledAt = Date.now();
        if (shouldSelect) selectThread(item.id);
      });
      button.addEventListener('pointercancel', cancel);
      button.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        handledAt = Date.now();
        clearNativeSelection();
        openThreadActionCard(item.id, { anchorElement: button, keepThreadMenu: true, vibrate: true });
      });
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() - handledAt < 700) return;
        selectThread(item.id);
      });
    }

    function appendThreadOption(parent, item, isConversation = false) {
      const button = document.createElement('button');
      const name = document.createElement('span');
      const state = document.createElement('span');
      const runtime = threadRuntimeStates.get(item.id) || runtimeSnapshotFromThread(item) || {};
      button.className = `thread-option${isConversation ? ' is-conversation' : ''}${item.pinned ? ' is-pinned' : ''}`;
      button.type = 'button';
      button.title = item.cwd || item.projectPath || item.name || '';
      button.setAttribute('aria-current', String(item.id === selectedThreadId));
      name.className = 'thread-option-title';
      state.className = 'thread-option-state';
      const text = document.createElement('span');
      text.className = 'thread-title-text';
      text.textContent = item.name || '未命名线程';
      if (item.pinned) {
        const pin = document.createElement('span');
        pin.className = 'thread-title-pin';
        pin.innerHTML = PIN_ICON;
        name.append(pin, text);
      } else {
        name.appendChild(text);
      }
      if (isThreadRunningStatus(runtime.status)) {
        const spinner = document.createElement('span');
        spinner.className = 'thread-option-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        spinner.style.animationDelay = `${-(performance.now() % THREAD_SPINNER_MS)}ms`;
        state.title = '这个线程正在回复';
        state.setAttribute('aria-label', '正在回复');
        state.appendChild(spinner);
      } else if (completedThreadIds.has(item.id) && item.id !== selectedThreadId) {
        state.title = '这个线程刚刚回复完毕';
        state.setAttribute('aria-label', '刚刚回复完毕');
        state.innerHTML = '<span class="thread-option-dot" aria-hidden="true"></span>';
      } else {
        state.textContent = formatRelativeTime(item.effectiveUpdatedAt || item.updatedAt) || item.id.slice(0, 8);
      }
      button.append(name, state);
      wireThreadMenuItemInteractions(button, item);
      parent.appendChild(button);
    }

    function appendPinnedThreadOption(parent, item) {
      const button = document.createElement('button');
      const icon = document.createElement('span');
      const name = document.createElement('span');
      const meta = document.createElement('small');
      button.className = 'pinned-thread-option';
      button.type = 'button';
      button.title = item.cwd || item.projectPath || item.name || '';
      button.setAttribute('aria-current', String(item.id === selectedThreadId));
      icon.className = 'pinned-thread-icon';
      name.className = 'pinned-thread-name';
      meta.className = 'pinned-thread-meta';
      icon.innerHTML = PIN_ICON;
      name.textContent = item.name || '未命名线程';
      meta.textContent = formatRelativeTime(item.effectiveUpdatedAt || item.updatedAt) || '';
      button.append(icon, name, meta);
      wireThreadMenuItemInteractions(button, item);
      parent.appendChild(button);
    }

    function appendProjectGroup(parent, group, isCurrent = false) {
      const isOpen = openProjectKeys.has(group.key);
      const wrap = document.createElement('div');
      const header = document.createElement('button');
      const folder = document.createElement('span');
      const name = document.createElement('span');
      const count = document.createElement('small');
      const list = document.createElement('div');
      wrap.className = `project-group${isOpen ? ' is-open' : ''}`;
      header.className = `project-header${isCurrent ? ' is-current' : ''}`;
      header.type = 'button';
      header.setAttribute('aria-expanded', String(isOpen));
      header.setAttribute('aria-label', `${isOpen ? '收起' : '展开'}项目 ${group.name || '未命名项目'}`);
      folder.className = 'project-folder';
      folder.innerHTML = '<svg viewBox="0 0 24 20" aria-hidden="true"><path d="M3.8 6.2V5.1c0-1.2.8-2 2-2h4.1c.8 0 1.25.22 1.8.84l1.05 1.16c.36.4.67.56 1.28.56h4.15c1.35 0 2.02.68 2.02 2.02v7.2c0 1.34-.67 2.02-2.02 2.02H5.82c-1.35 0-2.02-.68-2.02-2.02V6.2Z"/><path d="M4 7.1h16"/></svg>';
      name.className = 'project-name';
      list.className = 'thread-list';
      folder.setAttribute('aria-hidden', 'true');
      name.textContent = group.name || '未命名项目';
      count.textContent = `${group.items.length} 条`;
      header.title = group.path || group.name || '';
      header.append(folder, name, count);
      header.addEventListener('click', event => {
        event.stopPropagation();
        if (openProjectKeys.has(group.key)) openProjectKeys.delete(group.key);
        else openProjectKeys.add(group.key);
        persistOpenProjectKeys();
        renderThreadMenu();
      });
      for (const item of sortThreadsByTime(group.items)) appendThreadOption(list, item);
      wrap.append(header, list);
      parent.appendChild(wrap);
    }

    function renderThreadMenu() {
      const sections = [];
      if (!knownThreads.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-thread-menu';
        empty.textContent = '还没有读取到 Codex 线程。';
        sections.push(empty);
        replaceChildrenBatched(threadMenu, sections);
        lastThreadMenuSignature = threadMenuVisualSignature();
        positionThreadMenuCard();
        return;
      }

      const current = knownThreads.find(item => item.id === selectedThreadId);
      const currentProjectKey = current?.isProjectThread ? current.projectKey : '';
      const projectMap = new Map();
      const conversations = [];
      const pinnedThreads = sortThreadsByTime(knownThreads.filter(item => item.pinned));

      for (const item of knownThreads) {
        if (item.pinned) continue;
        if (!item.isProjectThread) {
          conversations.push(item);
          continue;
        }
        const key = item.projectKey || item.projectPath || item.cwd || 'project';
        if (!projectMap.has(key)) {
          projectMap.set(key, {
            key,
            name: item.projectName || '未命名项目',
            path: item.projectPath || item.cwd || '',
            latest: 0,
            items: [],
          });
        }
        const group = projectMap.get(key);
        group.items.push(item);
        group.latest = Math.max(group.latest, Date.parse(item.effectiveUpdatedAt || item.updatedAt || '') || item.effectiveUpdatedMs || 0);
      }

      const projectGroups = [...projectMap.values()].sort((a, b) => {
        if (a.key === currentProjectKey) return -1;
        if (b.key === currentProjectKey) return 1;
        return b.latest - a.latest;
      });
      if (!hasSavedProjectGroupState && projectGroups.length && !openProjectKeys.size) {
        openProjectKeys.add(currentProjectKey || projectGroups[0].key);
        persistOpenProjectKeys();
      }

      if (pinnedThreads.length) {
        const section = document.createElement('section');
        const label = document.createElement('div');
        section.className = 'thread-section';
        label.className = 'thread-section-label';
        label.textContent = '置顶';
        section.appendChild(label);
        pinnedThreads.forEach(item => appendPinnedThreadOption(section, item));
        sections.push(section);
      }

      if (projectGroups.length) {
        const section = document.createElement('section');
        const label = document.createElement('div');
        section.className = 'thread-section';
        label.className = 'thread-section-label';
        label.textContent = currentProjectKey ? '当前项目 / 最近项目' : '项目';
        section.appendChild(label);
        projectGroups.forEach(group => appendProjectGroup(section, group, group.key === currentProjectKey));
        sections.push(section);
      }

      if (conversations.length) {
        const section = document.createElement('section');
        const label = document.createElement('div');
        const list = document.createElement('div');
        section.className = 'thread-section';
        label.className = 'thread-section-label';
        list.className = 'thread-list';
        label.textContent = '对话';
        for (const item of sortThreadsByTime(conversations)) appendThreadOption(list, item, true);
        section.append(label, list);
        sections.push(section);
      }
      replaceChildrenBatched(threadMenu, sections);
      lastThreadMenuSignature = threadMenuVisualSignature();
      positionThreadMenuCard();
    }

    function setThreadMenuRefreshing(active) {
      threadMenu.classList.toggle('is-refreshing', Boolean(active));
    }

    async function loadThreads(options = {}) {
      const detectTransitions = Boolean(options.detectTransitions);
      const renderMode = options.renderMenu || 'always';
      const desktopRailVisible = window.matchMedia('(min-width: 900px) and (min-height: 650px)').matches;
      const showRefresh = threadMenu.classList.contains('is-open') || desktopRailVisible;
      if (showRefresh) setThreadMenuRefreshing(true);
      try {
      const response = await fetchApi(`/codex/threads?limit=all&token=${encodeURIComponent(token)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!data.ok) throw new Error(data.message || '读取线程失败');
      knownThreads = data.threads || [];
      if (!SHOW_PROJECTLESS_THREADS_IN_MENU) {
        knownThreads = knownThreads.filter(item => item && (item.isProjectThread || item.pinned || item.id === selectedThreadId));
      }
      for (const item of knownThreads) {
        applyThreadRuntimeState(item.id, runtimeSnapshotFromThread(item), { detectTransitions });
      }
      pruneCompletedThreadNotices();
      if (!pendingNewThread && (!selectedThreadId || !knownThreads.some(item => item.id === selectedThreadId))) {
        selectedThreadId = knownThreads[0]?.id || '';
        if (selectedThreadId) localStorage.setItem('codex2frp.selectedThread', selectedThreadId);
      }
      setThreadCompleteNotice(selectedThreadId, false);
      updateThreadTitle();
      if (renderMode === 'ifChanged') renderThreadMenuIfVisualChanged();
      else renderThreadMenu();
      } finally {
        if (showRefresh) setThreadMenuRefreshing(false);
      }
    }

    async function openCodexThread(threadId, apiOptions = {}) {
      if (!threadId) return;
      const response = await fetchApi('/codex/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
        body: JSON.stringify({ threadId }),
        apiTimeoutMs: 15000,
        ...apiOptions,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || '切换 Codex 线程失败');
      return data;
    }

    function currentThreadItem() {
      return knownThreads.find(item => item.id === selectedThreadId) || null;
    }

    function threadItemById(threadId) {
      return knownThreads.find(item => item.id === threadId) || null;
    }

    function actionThreadItem() {
      return threadItemById(actionThreadId || selectedThreadId);
    }

    function closeThreadActionCard() {
      threadActionCard.classList.remove('is-open', 'is-renaming');
      threadActionCard.style.left = '';
      threadActionCard.style.top = '';
      threadRenameInput.blur();
    }

    function cancelThreadRename() {
      suppressThreadClickUntil = Date.now() + 700;
      closeThreadActionCard();
    }

    function viewportHeight() {
      return Math.round((window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0);
    }

    function positionThreadActionCard(anchorElement) {
      if (!anchorElement || typeof anchorElement.getBoundingClientRect !== 'function') return;
      const anchor = anchorElement.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const margin = 10;
      const cardWidth = threadActionCard.offsetWidth || 224;
      const cardHeight = threadActionCard.offsetHeight || 160;
      const anchorCenterX = anchor.left + anchor.width / 2;
      const left = Math.max(margin, Math.min(viewportWidth - cardWidth - margin, anchorCenterX - cardWidth / 2));
      const belowTop = anchor.bottom + 6;
      const aboveTop = anchor.top - cardHeight - 6;
      const hasRoomBelow = belowTop + cardHeight + margin <= viewportHeight;
      const top = hasRoomBelow ? belowTop : Math.max(margin, aboveTop);
      threadActionCard.style.left = `${Math.round(left)}px`;
      threadActionCard.style.top = `${Math.round(top)}px`;
    }

    function vibrateForLongPress() {
      let fired = false;
      try {
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('medium');
        fired = true;
      } catch {}
      try {
        window.webkit?.messageHandlers?.haptic?.postMessage?.('medium');
        fired = true;
      } catch {}
      try {
        window.webkit?.messageHandlers?.hapticFeedback?.postMessage?.({ type: 'impact', style: 'medium' });
        fired = true;
      } catch {}
      try {
        window.webkit?.messageHandlers?.vibrate?.postMessage?.([45, 25, 45]);
        fired = true;
      } catch {}
      try {
        if (navigator.vibrate) {
          navigator.vibrate([45, 25, 45]);
          fired = true;
        }
      } catch {}
      return fired;
    }

    function openThreadActionCard(threadId = selectedThreadId, options = {}) {
      const current = threadItemById(threadId);
      if (!current || !threadId) return;
      actionThreadId = threadId;
      if (!options.keepThreadMenu) threadMenu.classList.remove('is-open');
      closeReasoningMenu();
      closeModelMenu();
      closeSpeedMenu();
      threadActionCard.style.left = '';
      threadActionCard.style.top = '';
      threadActionCard.classList.toggle('is-pinned', Boolean(current.pinned));
      threadActionCard.classList.remove('is-renaming');
      threadRenameInput.value = current.name || '';
      threadActionPinToggleText.textContent = current.pinned ? '取消置顶' : '置顶';
      threadActionPinToggle.setAttribute('aria-label', current.pinned ? '取消置顶当前线程' : '置顶当前线程');
      threadActionCard.classList.add('is-open');
      if (options.anchorElement) positionThreadActionCard(options.anchorElement);
      if (options.vibrate) vibrateForLongPress();
    }

    function showRenamePanel() {
      const current = actionThreadItem();
      if (!current) return;
      threadMenu.classList.remove('is-open');
      threadRenameInput.value = current.name || '';
      threadActionCard.classList.add('is-renaming');
      threadActionCard.style.left = '';
      threadActionCard.style.top = '';
      threadRenameInput.focus({ preventScroll: false });
      try {
        threadRenameInput.setSelectionRange(0, threadRenameInput.value.length);
      } catch {}
      window.setTimeout(() => {
        const rect = threadActionCard.getBoundingClientRect();
        const visibleHeight = viewportHeight();
        if (rect.bottom > visibleHeight - 12) {
          threadActionCard.style.top = `${Math.max(72, visibleHeight - rect.height - 12)}px`;
        }
      }, 80);
    }

    async function postThreadAction(action, payload = {}) {
      const targetThreadId = actionThreadId || selectedThreadId;
      if (!targetThreadId) throw new Error('还没有选中线程。');
      const response = await fetchApi('/codex/thread-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
        body: JSON.stringify({ action, threadId: targetThreadId, ...payload }),
        apiTimeoutMs: 20000,
        routeSwitchQuiet: true,
        retryProbeTimeoutMs: 900,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || '线程操作失败');
      return data;
    }

    async function archiveCurrentThread() {
      const archivedThreadId = actionThreadId || selectedThreadId;
      if (!archivedThreadId) return;
      const archivedSelectedThread = archivedThreadId === selectedThreadId;
      closeThreadActionCard();
      setWorkingDot(true);
      setNotice('正在归档当前 Codex 线程…', 'ok');
      try {
        const data = await postThreadAction('archive');
        completedThreadIds.delete(archivedThreadId);
        knownThreads = knownThreads.filter(item => item.id !== archivedThreadId);
        if (archivedSelectedThread) {
          serializeMessages();
          stopPolling();
          selectedThreadId = '';
          syncedThreadId = '';
          localStorage.removeItem('codex2frp.selectedThread');
          await loadThreads();
          const nextThreadId = data.nextThreadId || selectedThreadId || '';
          if (nextThreadId) {
            selectedThreadId = '';
            await selectThread(nextThreadId);
          } else {
            clearThreadMessages();
            updateThreadTitle();
            renderThreadMenu();
          }
        } else {
          renderThreadMenu();
          await loadThreads({ renderMenu: 'always' });
        }
        setNotice('已归档当前线程', 'ok');
      } catch (error) {
        setNotice(error.message || '归档失败', 'error');
      } finally {
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
      }
    }

    async function toggleCurrentThreadPin() {
      const current = actionThreadItem();
      if (!current) return;
      const targetThreadId = current.id;
      const nextPinned = !current.pinned;
      closeThreadActionCard();
      setWorkingDot(true);
      setNotice(nextPinned ? '正在置顶当前 Codex 线程…' : '正在取消置顶当前 Codex 线程…', 'ok');
      try {
        await postThreadAction(nextPinned ? 'pin' : 'unpin');
        for (const item of knownThreads) {
          if (item.id === targetThreadId) item.pinned = nextPinned;
        }
        if (targetThreadId === selectedThreadId) updateThreadTitle();
        renderThreadMenu();
        await loadThreads({ renderMenu: 'always' });
        setNotice(nextPinned ? '已同步置顶：Codex 和手机列表都会置顶' : '已同步取消置顶', 'ok');
      } catch (error) {
        setNotice(error.message || '置顶操作失败', 'error');
      } finally {
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
      }
    }

    async function renameCurrentThread() {
      const current = actionThreadItem();
      if (!current) return;
      const targetThreadId = current.id;
      const nextName = threadRenameInput.value.replace(/\s+/g, ' ').trim();
      if (!nextName) {
        setNotice('新名称不能为空', 'error');
        threadRenameInput.focus();
        return;
      }
      if (nextName === current.name) {
        closeThreadActionCard();
        return;
      }
      threadRenameSave.disabled = true;
      setWorkingDot(true);
      setNotice('正在重命名当前 Codex 线程…', 'ok');
      closeThreadActionCard();
      try {
        const data = await postThreadAction('rename', { name: nextName });
        for (const item of knownThreads) {
          if (item.id === targetThreadId) item.name = data.name || nextName;
        }
        if (targetThreadId === selectedThreadId) updateThreadTitle();
        renderThreadMenu();
        window.setTimeout(() => loadThreads({ renderMenu: 'always' }).catch(() => {}), 700);
        setNotice('已重命名当前线程', 'ok');
      } catch (error) {
        setNotice(error.message || '重命名失败', 'error');
      } finally {
        threadRenameSave.disabled = false;
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
      }
    }

    async function createNewThreadInCurrentProject() {
      if (newThreadButton.disabled) return;
      const current = knownThreads.find(item => item.id === selectedThreadId);
      const previousThreadId = selectedThreadId || '';
      const isProjectScope = Boolean(current?.isProjectThread && (current.projectPath || current.cwd));
      const newThreadScope = isProjectScope ? 'project' : 'conversation';
      newThreadButton.disabled = true;
      threadMenu.classList.remove('is-open');
      setWorkingDot(true);
      setNotice(isProjectScope ? '正在当前项目新建线程…' : '正在新建对话线程…', 'ok');
      try {
        await ensureRouteForSend();
        const response = await fetchApi('/codex/new-thread', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
          body: JSON.stringify({
            threadId: selectedThreadId || '',
            projectPath: isProjectScope ? (current?.projectPath || current?.cwd || '') : '',
            scope: newThreadScope,
            isProjectThread: isProjectScope,
          }),
          apiTimeoutMs: 20000,
          routeSwitchQuiet: true,
          retryProbeTimeoutMs: 900,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.message || '新建线程失败');
        pendingNewThread = {
          cwd: data.cwd || '',
          projectName: data.projectName || (isProjectScope ? current?.projectName : '对话') || '',
          projectPath: data.projectPath || data.cwd || '',
          previousThreadId,
          createdAt: new Date().toISOString(),
        };
        detachForegroundRunForNewThread();
        selectedThreadId = '';
        syncedThreadId = '';
        lastStatusSignature = '';
        localStorage.removeItem('codex2frp.selectedThread');
        clearThreadMessages();
        messageEl('assistant', '新线程已经在电脑 Codex 打开。直接在这里发第一条消息就会进入这个新线程。', { label: 'Codex2Frp' });
        updateThreadTitle();
        renderThreadMenu();
        setNotice(data.message || '已新建线程', 'ok');
        restoreLayoutAfterKeyboard();
      } catch (error) {
        setNotice(error.message || '新建线程失败', 'error');
      } finally {
        newThreadButton.disabled = false;
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
      }
    }

    async function syncCodexThread(threadId = selectedThreadId, options = {}) {
      if (!threadId) return { ok: false, skipped: true };
      const { quiet = false, force = false } = options;
      if (!force && syncedThreadId === threadId) return { ok: true, threadId, cached: true };

      const requestId = ++syncRequestId;
      const previousStatus = topStatusState || '已连接';
      setWorkingDot(true);
      setTopStatus('同步线程');
      if (!quiet) setNotice('正在同步桌面端 Codex 到当前线程…', 'ok');
      try {
        const data = await openCodexThread(threadId, { routeSwitchQuiet: quiet, retryProbeTimeoutMs: 900 });
        if (requestId === syncRequestId && threadId === selectedThreadId) syncedThreadId = threadId;
        if (!quiet && requestId === syncRequestId) setNotice('桌面端 Codex 已切到当前线程', 'ok');
        return data || { ok: true, threadId };
      } catch (error) {
        if (requestId === syncRequestId) setNotice(error.message || '同步 Codex 线程失败', 'error');
        throw error;
      } finally {
        if (requestId === syncRequestId) {
          setTopStatus(previousStatus === '同步线程' ? '已连接' : previousStatus);
          if (!pollTimer && !activeAssistant) setWorkingDot(false);
        }
      }
    }

    function isRunningStatus(data) {
      return Boolean(data && (data.active || data.status === 'running' || data.status === 'waiting'));
    }

    function codexStatusSignature(data) {
      if (!data || !data.available) return '';
      return [
        data.threadId || '',
        data.sessionFile || '',
        data.turnId || '',
        data.status || '',
        data.updatedAt || '',
        data.startedAt || '',
        data.completedAt || '',
      ].join('|');
    }

    function runtimeSnapshotFromStatusData(data) {
      if (!data || !data.available) return null;
      return {
        status: data.status || '',
        active: Boolean(data.active || isThreadRunningStatus(data.status)),
        startedAt: data.startedAt || '',
        completedAt: data.completedAt || '',
        updatedAt: data.updatedAt || data.completedAt || data.startedAt || '',
        turnId: data.turnId || '',
      };
    }

    async function resumeActiveThreadStatus(threadId, requestId = historyRequestId) {
      if (!threadId) return false;
      const params = new URLSearchParams({ token, thread: threadId });
      const response = await fetchApi(`/codex/status?${params}`, { cache: 'no-store' });
      const data = await response.json();
      if (requestId !== historyRequestId || threadId !== selectedThreadId) return false;
      if (!response.ok || !data.ok || !data.available) return false;
      updateContextFromStatus(data);
      applyThreadRuntimeState(threadId, runtimeSnapshotFromStatusData(data), { detectTransitions: false });
      renderThreadMenuIfVisualChanged();
      lastStatusSignature = codexStatusSignature(data);
      if (isRunningStatus(data) && isLocalStopSuppressed(threadId, data.startedAt)) return false;
      if (!isRunningStatus(data)) return false;

      const durationText = formatDuration(data.durationMs || 0);
      const resumeCommandKind = latestUserCommandKind();
      const resumeCommandUi = commandUi(resumeCommandKind);
      activeAssistant = messageEl('assistant', resumeCommandUi?.pendingText || 'Codex 正在回复…', { label: resumeCommandUi ? resumeCommandUi.runningLabel(durationText) : `Codex · 运行 ${durationText}`, pending: true });
      activeAssistant.commandKind = resumeCommandKind;
      setActiveRunStart(data.startedAt || '', Date.now() - (Number(data.durationMs) || 0));
      activeAssistant.runDurationText = durationText;
      updateComposerAction();
      if (resumeCommandUi) setMarkdown(activeAssistant.bubble, resumeCommandUi.pendingText);
      else renderProcessSteps(activeAssistant.bubble, data.steps || []);
      setTopStatus(resumeCommandUi ? resumeCommandUi.runningNotice(durationText) : `Codex 正在回复 · ${durationText}`);
      setNotice('已接上这个线程正在进行的回复状态', 'ok');
      startPolling({
        since: data.startedAt || '',
        threadId,
        sessionFile: data.sessionFile || '',
      });
      return true;
    }

    function createMessageFromHistoryRow(row) {
      const msg = messageEl(row.role, row.text || '', {
        label: row.label || (row.role === 'user' ? '你' : 'Codex'),
        skipAppend: true,
        skipScroll: true,
      });
      if (row.attachments?.length) {
        const note = document.createElement('div');
        note.className = 'attachment-note';
        note.textContent = row.attachments.map(item => `图片：${item.name || 'image'}`).join(' · ');
        msg.bubble.appendChild(note);
      }
      return msg;
    }

    function loadOlderHistoryWindow() {
      if (!renderedHistoryOffset || !fullHistoryRows.length) return;
      const previousHeight = thread.scrollHeight;
      const nextOffset = Math.max(0, renderedHistoryOffset - INITIAL_HISTORY_MESSAGE_LIMIT);
      const rowsToAdd = fullHistoryRows.slice(nextOffset, renderedHistoryOffset);
      renderedHistoryOffset = nextOffset;
      const nodes = rowsToAdd.map(row => createMessageFromHistoryRow(row));
      const fragment = document.createDocumentFragment();
      for (const node of nodes) fragment.appendChild(node.article || node);
      const button = thread.querySelector('.load-older-history');
      if (button) button.after(fragment);
      if (renderedHistoryOffset === 0 && button) button.remove();
      thread.scrollTop += thread.scrollHeight - previousHeight;
    }

    async function loadThreadHistory(threadId = selectedThreadId) {
      if (!threadId) return;
      const requestId = ++historyRequestId;
      clearThreadMessages();
      setHistoryLoading(true, requestId);
      const loading = messageEl('assistant', '正在加载这个 Codex 线程的本机聊天记录…', { label: 'Codex2Frp' });
      try {
        const params = new URLSearchParams({ token, thread: threadId, limit: '120' });
        const response = await fetchApi(`/codex/history?${params}`, { cache: 'no-store', apiTimeoutMs: 30000 });
        const data = await response.json();
        if (!isCurrentHistoryRequest(requestId, threadId)) {
          removeLoadingMessage(loading);
          return;
        }
        removeLoadingMessage(loading);
        if (!response.ok || !data.ok) throw new Error(data.message || '读取聊天记录失败');
        if (!data.available || !Array.isArray(data.messages) || !data.messages.length) {
          const resumed = await resumeActiveThreadStatus(threadId, requestId);
          if (!isCurrentHistoryRequest(requestId, threadId)) return;
          if (!resumed) messageEl('assistant', '这个线程暂时没有可加载的聊天记录。', { label: 'Codex2Frp' });
          return;
        }
        beginHistoryRenderAtBottom();
        try {
          const rows = data.messages;
          fullHistoryRows = rows;
          renderedHistoryOffset = Math.max(0, rows.length - INITIAL_HISTORY_MESSAGE_LIMIT);
          const visibleRows = rows.slice(renderedHistoryOffset);
          replaceHistoryMessagesBatched(visibleRows.map(row => createMessageFromHistoryRow(row).article));
          if (renderedHistoryOffset > 0) {
            const older = document.createElement('button');
            older.type = 'button';
            older.className = 'load-older-history';
            older.textContent = `加载更早的 ${renderedHistoryOffset} 条消息`;
            older.addEventListener('click', loadOlderHistoryWindow);
            prependHistoryControl(older);
          }
        } finally {
          finishHistoryRenderAtBottom();
        }
        const resumed = await resumeActiveThreadStatus(threadId, requestId);
        if (!isCurrentHistoryRequest(requestId, threadId)) return;
        if (!resumed) {
          if (data.truncated) setNotice('已加载最近一部分聊天记录，较早日志太大已省略', 'ok');
          else setNotice('已从本机 Codex 线程加载聊天记录', 'ok');
        }
      } catch (error) {
        if (!isCurrentHistoryRequest(requestId, threadId)) {
          removeLoadingMessage(loading);
          return;
        }
        removeLoadingMessage(loading);
        setNotice(error.message || '读取聊天记录失败', 'error');
        restoreMessages();
      } finally {
        setHistoryLoading(false, requestId);
      }
    }

    async function selectThread(threadId) {
      if (!threadId) return;
      threadMenu.classList.remove('is-open');
      setThreadCompleteNotice(threadId, false);
      if (threadId === selectedThreadId) {
        if (activeAssistant || pollTimer) {
          setNotice('当前正在查看这个线程，回复状态会继续更新', 'ok');
          return;
        }
        setNotice('正在刷新这个线程的本机聊天记录…', 'ok');
        await loadThreadHistory(threadId);
        return;
      }

      serializeMessages();
      stopPolling();
      selectedThreadId = threadId;
      syncedThreadId = '';
      localStorage.setItem('codex2frp.selectedThread', selectedThreadId);
      setThreadCompleteNotice(selectedThreadId, false);
      activeAssistant = null;
      renderReasoningBadge(bestReasoningMode(null, selectedThreadId));
      renderModelBadge(bestModelInfo(null, selectedThreadId));
      renderSpeedBadge(bestSpeedMode(null, selectedThreadId));
      updateComposerAction();
      lastStatusSignature = '';
      clearThreadMessages();
      updateThreadTitle();
      renderThreadMenu();
      setNotice('已切换到查看线程，正在加载本机聊天记录…', 'ok');

      await loadThreadHistory(threadId);
    }

    function safeBubbleHtml(article) {
      const bubble = article.querySelector('.bubble');
      if (!bubble) return '';
      const clone = bubble.cloneNode(true);
      for (const img of [...clone.querySelectorAll('img.attachment-preview')]) {
        const note = document.createElement('div');
        note.className = 'attachment-note';
        note.textContent = `图片：${img.alt || '已发送图片'}（刷新后不缓存预览）`;
        img.replaceWith(note);
      }
      const html = clone.innerHTML || '';
      return html.length > 30000 ? `${html.slice(0, 30000)}…` : html;
    }

    function serializeMessages() {
      const rows = [...thread.querySelectorAll('.message')].slice(-30).map(article => ({
        role: article.classList.contains('user') ? 'user' : 'assistant',
        label: article.querySelector('.meta')?.textContent?.replace(/ · 正在回复$/, '') || '',
        html: safeBubbleHtml(article),
      }));
      const key = chatStorageKey();
      try {
        localStorage.setItem(key, JSON.stringify(rows));
      } catch (error) {
        console.warn('Codex2Frp chat cache skipped:', error);
        try {
          localStorage.removeItem(key);
          localStorage.setItem(key, JSON.stringify(rows.slice(-8)));
        } catch {
          localStorage.removeItem(key);
        }
      }
    }
    function restoreMessages() {
      try {
        const rows = JSON.parse(localStorage.getItem(chatStorageKey()) || '[]');
        for (const row of rows.slice(-20)) {
          const msg = messageEl(row.role, '', { label: row.label });
          msg.bubble.innerHTML = row.html;
        }
      } catch {}
    }

    function stopPolling() {
      pollGeneration += 1;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      stopRunDurationTimer();
      activeWatch = null;
      pollAttempts = 0;
      updateComposerAction();
      setWorkingDot(false);
      setTopStatus('已连接');
    }

    function detachForegroundRunForNewThread() {
      pollGeneration += 1;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      stopRunDurationTimer();
      activeWatch = null;
      pollAttempts = 0;
      activeAssistant = null;
      lastPreview = '';
      updateComposerAction();
      setTopStatus('已连接');
    }

    function adoptNewThreadId(threadId) {
      if (!threadId || (selectedThreadId && selectedThreadId === threadId)) return;
      selectedThreadId = threadId;
      pendingNewThread = null;
      syncedThreadId = threadId;
      if (activeWatch) activeWatch.threadId = threadId;
      localStorage.setItem('codex2frp.selectedThread', threadId);
      setThreadCompleteNotice(threadId, false);
      renderReasoningBadge(bestReasoningMode(null, threadId));
      renderModelBadge(bestModelInfo(null, threadId));
      renderSpeedBadge(bestSpeedMode(null, threadId));
      updateThreadTitle();
      loadThreads({ detectTransitions: false, renderMenu: 'ifChanged' }).catch(error => {
        console.warn('Codex2Frp new thread list refresh skipped:', error);
      });
    }

    function scheduleNextPoll(watch, generation, delay = 1400) {
      if (generation !== pollGeneration || !activeAssistant) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => pollStatus(watch, generation), delay);
    }

    async function pollStatus(watch, generation = pollGeneration) {
      if (generation !== pollGeneration) return;
      if (!watch || !activeAssistant) return stopPolling();
      pollAttempts += 1;
      let changed = false;
      const params = new URLSearchParams({ token, since: watch.since || '', thread: watch.threadId || selectedThreadId || '' });
      if (watch.sessionFile) params.set('session', watch.sessionFile);
      if (watch.expectNewThread) params.set('expectNewThread', '1');
      if (watch.excludeThreadId) params.set('excludeThread', watch.excludeThreadId);
      if (watch.cwd) params.set('cwd', watch.cwd);
      try {
        const res = await fetchApi(`/codex/status?${params}`, { cache: 'no-store' });
        const data = await res.json();
        if (generation !== pollGeneration || !activeAssistant) return;
        if (!data.ok) throw new Error(data.message || '读取失败');
        if (!data.available && data.status === 'missing') throw new Error(data.message || '没有找到所选线程。');
        if (data.available) {
          if (data.threadId && (!selectedThreadId || pendingNewThread)) adoptNewThreadId(data.threadId);
          updateContextFromStatus(data);
          applyThreadRuntimeState(data.threadId || watch.threadId || selectedThreadId, runtimeSnapshotFromStatusData(data), { detectTransitions: true });
          renderThreadMenuIfVisualChanged();
          lastStatusSignature = codexStatusSignature(data);
        }
        setActiveRunStart(data.startedAt || watch.since || '', Date.now() - (Number(data.durationMs) || 0));
        const activeCommandUi = commandUi(activeAssistant.commandKind || '');
        if (data.status === 'complete' || data.status === 'error') {
          const isErrorStatus = data.status === 'error';
          const finalText = isErrorStatus
            ? (data.error || data.preview || 'Codex 回复失败。')
            : (activeCommandUi?.completeText || data.final || data.preview || '已完成。');
          if (finalText !== lastPreview) {
            lastPreview = finalText;
            setMarkdown(activeAssistant.bubble, finalText);
            scrollBottom();
          }
          const finalDurationText = formatDuration(finalRunDurationMs(data));
          activeAssistant.runDurationText = finalDurationText;
          setMetaLabel(activeAssistant.meta, isErrorStatus
            ? `Codex · 失败 ${finalDurationText}`
            : activeCommandUi ? activeCommandUi.completeLabel(finalDurationText) : `Codex · 已处理 ${finalDurationText}`);
          activeAssistant.article.classList.remove('pending');
          addDetails(activeAssistant, data.steps || []);
          serializeMessages();
          if (!isErrorStatus && promoteNextQueuedSendAfterCurrent(data)) return;
          if (isErrorStatus) clearQueuedSends();
          activeAssistant = null;
          stopPolling();
        } else {
          const processText = activeCommandUi?.pendingText || data.processText || stepMarkdown(data.steps || []);
          changed = processText && processText !== lastPreview;
          if (changed) {
            lastPreview = processText;
            if (activeCommandUi) setMarkdown(activeAssistant.bubble, processText);
            else renderProcessSteps(activeAssistant.bubble, data.steps || []);
            scrollBottom();
          }
          if (!data.active) setTopStatus('等待 Codex');
          if (pollAttempts > 180) {
            activeAssistant.article.classList.remove('pending');
            if (activeCommandUi) setMarkdown(activeAssistant.bubble, activeCommandUi.completeText);
            addDetails(activeAssistant, data.steps || []);
            const finalDurationText = formatDuration(finalRunDurationMs(data));
            activeAssistant.runDurationText = finalDurationText;
            setMetaLabel(activeAssistant.meta, activeCommandUi ? activeCommandUi.completeLabel(finalDurationText) : `Codex · 已处理 ${finalDurationText}`);
            clearQueuedSends();
            activeAssistant = null;
            stopPolling();
          }
        }
      } catch (error) {
        setNotice(error.message || '读取 Codex 回复失败', 'error');
      }
      if (generation === pollGeneration && activeAssistant) {
        const nextDelay = document.hidden ? 8000 : changed ? 1200 : Math.min(3000, 1400 + pollAttempts * 80);
        scheduleNextPoll(watch, generation, nextDelay);
      }
    }

    function startPolling(watch) {
      stopPolling();
      if (!activeAssistant) return;
      const generation = ++pollGeneration;
      activeWatch = watch || null;
      setWorkingDot(true);
      lastPreview = '';
      setActiveRunStart(watch?.since || '', Date.now());
      setTopStatus(commandUi(activeAssistant.commandKind || '') ? '正在压缩' : '等待 Codex');
      updateActiveRunDuration(true);
      startRunDurationTimer();
      scheduleNextPoll(watch, generation, 100);
      updateComposerAction();
    }

    async function refreshCurrentThreadIfChanged() {
      if (!selectedThreadId || activeAssistant || autoRefreshBusy || document.hidden) return;
      autoRefreshBusy = true;
      let dotStarted = false;
      const threadId = selectedThreadId;
      try {
        const params = new URLSearchParams({ token, thread: threadId });
        const response = await fetchApi(`/codex/status?${params}`, { cache: 'no-store' });
        const data = await response.json();
        if (threadId !== selectedThreadId || !response.ok || !data.ok || !data.available) return;
        updateContextFromStatus(data);
        applyThreadRuntimeState(threadId, runtimeSnapshotFromStatusData(data), { detectTransitions: false });
        renderThreadMenuIfVisualChanged();
        if (isRunningStatus(data) && isLocalStopSuppressed(threadId, data.startedAt)) {
          lastStatusSignature = codexStatusSignature(data);
          return;
        }
        const signature = codexStatusSignature(data);
        const shouldReload = isRunningStatus(data) || (lastStatusSignature && signature && signature !== lastStatusSignature);
        if (!lastStatusSignature) lastStatusSignature = signature;
        if (!shouldReload) return;
        lastStatusSignature = signature;
        setWorkingDot(true);
        dotStarted = true;
        setNotice(isRunningStatus(data) ? '检测到桌面端正在回复，正在同步到手机…' : '检测到桌面端聊天记录更新，正在同步…', 'ok');
        await loadThreadHistory(threadId);
      } catch (error) {
        console.warn('Codex2Frp auto refresh skipped:', error);
      } finally {
        autoRefreshBusy = false;
        if (dotStarted && !activeAssistant && !pollTimer) setWorkingDot(false);
      }
    }

    function startAutoRefresh() {
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      autoRefreshTimer = setInterval(() => {
        if (document.hidden) return;
        refreshCurrentThreadIfChanged();
      }, 5000);
    }

    async function refreshThreadRuntimeStates(options = {}) {
      if (threadStateBusy || document.hidden) return;
      threadStateBusy = true;
      try {
        await loadThreads({ detectTransitions: options.detectTransitions !== false, renderMenu: 'ifChanged' });
      } catch (error) {
        console.warn('Codex2Frp thread state refresh skipped:', error);
      } finally {
        threadStateBusy = false;
      }
    }

    function scheduleForegroundStateRefresh() {
      if (document.hidden) return;
      pruneCompletedThreadNotices();
      if (appResumeRefreshTimer) window.clearTimeout(appResumeRefreshTimer);
      appResumeRefreshTimer = window.setTimeout(() => {
        appResumeRefreshTimer = null;
        refreshApiConfigIfNeeded();
        refreshSakuraStatus();
        refreshCurrentThreadIfChanged();
        refreshThreadRuntimeStates({ detectTransitions: true });
      }, 80);
    }

    function closeReasoningMenu() {
      reasoningMenuCard.classList.remove('is-open');
      reasoningMenuCard.style.left = '';
      reasoningMenuCard.style.top = '';
    }

    function positionReasoningMenu(anchorElement = reasoningBadge) {
      if (!anchorElement || typeof anchorElement.getBoundingClientRect !== 'function') return;
      const anchor = anchorElement.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const margin = 10;
      const cardWidth = reasoningMenuCard.offsetWidth || 97;
      const cardHeight = reasoningMenuCard.offsetHeight || 90;
      const rightAlignedLeft = anchor.right - cardWidth;
      const left = Math.max(margin, Math.min(viewportWidth - cardWidth - margin, rightAlignedLeft));
      const belowTop = anchor.bottom + 7;
      const aboveTop = anchor.top - cardHeight - 7;
      const top = belowTop + cardHeight + margin <= viewportHeight ? belowTop : Math.max(margin, aboveTop);
      reasoningMenuCard.style.left = `${Math.round(left)}px`;
      reasoningMenuCard.style.top = `${Math.round(top)}px`;
    }

    function openReasoningMenu(options = {}) {
      threadMenu.classList.remove('is-open');
      closeThreadActionCard();
      closeContextQuickCard();
      closeModelMenu();
      closeSpeedMenu();
      renderReasoningMenu();
      reasoningMenuCard.classList.add('is-open');
      positionReasoningMenu(reasoningBadge);
      if (options.vibrate) vibrateForLongPress();
    }

    function cancelReasoningLongPress() {
      window.clearTimeout(reasoningLongPressTimer);
      reasoningLongPressTimer = null;
      reasoningLongPressStart = null;
    }

    function startReasoningLongPress(event) {
      if (event.button > 0 || switchingReasoningMode) return;
      reasoningLongPressStart = { x: event.clientX || 0, y: event.clientY || 0 };
      reasoningLongPressOpened = false;
      window.clearTimeout(reasoningLongPressTimer);
      reasoningLongPressTimer = window.setTimeout(() => {
        reasoningLongPressOpened = true;
        suppressReasoningClickUntil = Date.now() + 900;
        clearNativeSelection();
        openReasoningMenu({ vibrate: true });
      }, 560);
    }

    function moveReasoningLongPress(event) {
      if (!reasoningLongPressStart) return;
      const dx = Math.abs((event.clientX || 0) - reasoningLongPressStart.x);
      const dy = Math.abs((event.clientY || 0) - reasoningLongPressStart.y);
      if (dx > 10 || dy > 10) cancelReasoningLongPress();
    }

    function finishReasoningPress(event) {
      const opened = reasoningLongPressOpened;
      cancelReasoningLongPress();
      if (opened) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
      }
    }

    function closeModelMenu() {
      modelMenuCard.classList.remove('is-open');
      modelMenuCard.style.left = '';
      modelMenuCard.style.top = '';
    }

    function positionModelMenu(anchorElement = modelBadge) {
      if (!anchorElement || typeof anchorElement.getBoundingClientRect !== 'function') return;
      const anchor = anchorElement.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const margin = 10;
      const cardWidth = modelMenuCard.offsetWidth || 182;
      const cardHeight = modelMenuCard.offsetHeight || 160;
      const rightAlignedLeft = anchor.right - cardWidth;
      const left = Math.max(margin, Math.min(viewportWidth - cardWidth - margin, rightAlignedLeft));
      const belowTop = anchor.bottom + 7;
      const aboveTop = anchor.top - cardHeight - 7;
      const top = belowTop + cardHeight + margin <= viewportHeight ? belowTop : Math.max(margin, aboveTop);
      modelMenuCard.style.left = `${Math.round(left)}px`;
      modelMenuCard.style.top = `${Math.round(top)}px`;
    }

    function openModelMenu(options = {}) {
      threadMenu.classList.remove('is-open');
      closeThreadActionCard();
      closeContextQuickCard();
      closeReasoningMenu();
      closeSpeedMenu();
      renderModelMenu();
      modelMenuCard.classList.add('is-open');
      positionModelMenu(modelBadge);
      if (options.vibrate) vibrateForLongPress();
    }

    function cancelModelLongPress() {
      window.clearTimeout(modelLongPressTimer);
      modelLongPressTimer = null;
      modelLongPressStart = null;
    }

    function startModelLongPress(event) {
      if (event.button > 0 || switchingModel) return;
      modelLongPressStart = { x: event.clientX || 0, y: event.clientY || 0 };
      modelLongPressOpened = false;
      window.clearTimeout(modelLongPressTimer);
      modelLongPressTimer = window.setTimeout(() => {
        modelLongPressOpened = true;
        suppressModelClickUntil = Date.now() + 900;
        clearNativeSelection();
        openModelMenu({ vibrate: true });
      }, 560);
    }

    function moveModelLongPress(event) {
      if (!modelLongPressStart) return;
      const dx = Math.abs((event.clientX || 0) - modelLongPressStart.x);
      const dy = Math.abs((event.clientY || 0) - modelLongPressStart.y);
      if (dx > 10 || dy > 10) cancelModelLongPress();
    }

    function finishModelPress(event) {
      const opened = modelLongPressOpened;
      cancelModelLongPress();
      if (opened) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
      }
    }

    function closeSpeedMenu() {
      speedMenuCard.classList.remove('is-open');
      speedMenuCard.style.left = '';
      speedMenuCard.style.top = '';
    }

    function positionSpeedMenu(anchorElement = speedBadge) {
      if (!anchorElement || typeof anchorElement.getBoundingClientRect !== 'function') return;
      const anchor = anchorElement.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const margin = 10;
      const cardWidth = speedMenuCard.offsetWidth || 150;
      const cardHeight = speedMenuCard.offsetHeight || 54;
      const rightAlignedLeft = anchor.right - cardWidth;
      const left = Math.max(margin, Math.min(viewportWidth - cardWidth - margin, rightAlignedLeft));
      const belowTop = anchor.bottom + 7;
      const aboveTop = anchor.top - cardHeight - 7;
      const top = belowTop + cardHeight + margin <= viewportHeight ? belowTop : Math.max(margin, aboveTop);
      speedMenuCard.style.left = `${Math.round(left)}px`;
      speedMenuCard.style.top = `${Math.round(top)}px`;
    }

    function openSpeedMenu(options = {}) {
      threadMenu.classList.remove('is-open');
      closeThreadActionCard();
      closeContextQuickCard();
      closeReasoningMenu();
      closeModelMenu();
      renderSpeedMenu();
      speedMenuCard.classList.add('is-open');
      positionSpeedMenu(speedBadge);
      if (options.vibrate) vibrateForLongPress();
    }

    function cancelSpeedLongPress() {
      window.clearTimeout(speedLongPressTimer);
      speedLongPressTimer = null;
      speedLongPressStart = null;
    }

    function startSpeedLongPress(event) {
      if (event.button > 0 || switchingSpeedMode) return;
      speedLongPressStart = { x: event.clientX || 0, y: event.clientY || 0 };
      speedLongPressOpened = false;
      window.clearTimeout(speedLongPressTimer);
      speedLongPressTimer = window.setTimeout(() => {
        speedLongPressOpened = true;
        suppressSpeedClickUntil = Date.now() + 900;
        clearNativeSelection();
        openSpeedMenu({ vibrate: true });
      }, 560);
    }

    function moveSpeedLongPress(event) {
      if (!speedLongPressStart) return;
      const dx = Math.abs((event.clientX || 0) - speedLongPressStart.x);
      const dy = Math.abs((event.clientY || 0) - speedLongPressStart.y);
      if (dx > 10 || dy > 10) cancelSpeedLongPress();
    }

    function finishSpeedPress(event) {
      const opened = speedLongPressOpened;
      cancelSpeedLongPress();
      if (opened) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
      }
    }

    function closeContextQuickCard() {
      contextQuickCard.classList.remove('is-open');
      contextQuickCard.style.left = '';
      contextQuickCard.style.top = '';
    }

    function positionContextQuickCard(anchorElement = topStatus) {
      if (!anchorElement || typeof anchorElement.getBoundingClientRect !== 'function') return;
      const anchor = anchorElement.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const margin = 10;
      const cardWidth = contextQuickCard.offsetWidth || 112;
      const cardHeight = contextQuickCard.offsetHeight || 54;
      const rightAlignedLeft = anchor.right - cardWidth;
      const left = Math.max(margin, Math.min(viewportWidth - cardWidth - margin, rightAlignedLeft));
      const belowTop = anchor.bottom + 7;
      const aboveTop = anchor.top - cardHeight - 7;
      const top = belowTop + cardHeight + margin <= viewportHeight ? belowTop : Math.max(margin, aboveTop);
      contextQuickCard.style.left = `${Math.round(left)}px`;
      contextQuickCard.style.top = `${Math.round(top)}px`;
    }

    function openContextQuickCard(options = {}) {
      threadMenu.classList.remove('is-open');
      closeThreadActionCard();
      closeReasoningMenu();
      closeModelMenu();
      closeSpeedMenu();
      contextQuickCard.classList.add('is-open');
      positionContextQuickCard(topStatus);
      if (options.vibrate) vibrateForLongPress();
    }

    function cancelContextLongPress() {
      window.clearTimeout(contextLongPressTimer);
      contextLongPressTimer = null;
      contextLongPressStart = null;
    }

    function startContextLongPress(event) {
      if (event.button > 0) return;
      contextLongPressStart = { x: event.clientX || 0, y: event.clientY || 0 };
      contextLongPressOpened = false;
      window.clearTimeout(contextLongPressTimer);
      contextLongPressTimer = window.setTimeout(() => {
        contextLongPressOpened = true;
        suppressContextClickUntil = Date.now() + 900;
        clearNativeSelection();
        openContextQuickCard({ vibrate: true });
      }, 560);
    }

    function moveContextLongPress(event) {
      if (!contextLongPressStart) return;
      const dx = Math.abs((event.clientX || 0) - contextLongPressStart.x);
      const dy = Math.abs((event.clientY || 0) - contextLongPressStart.y);
      if (dx > 10 || dy > 10) cancelContextLongPress();
    }

    function finishContextPress(event) {
      const opened = contextLongPressOpened;
      cancelContextLongPress();
      if (opened) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
      }
    }

    async function sendContextCompactCommand() {
      closeContextQuickCard();
      await sendText({
        text: CONTEXT_COMPACT_COMMAND,
        commandKind: 'compact',
        userLabel: '你 · 压缩',
        sendingNotice: '正在发送压缩指令…',
        sentNotice: '已发送压缩指令',
      });
    }

    function startThreadStateWatcher() {
      if (threadStateTimer) clearInterval(threadStateTimer);
      threadStateTimer = setInterval(() => {
        if (document.hidden) return;
        refreshThreadRuntimeStates();
      }, 4500);
    }


    function autosize() {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    }

    function updateComposerAction() {
      const running = Boolean(activeAssistant || pollTimer);
      sendButton.hidden = running;
      sendButton.classList.toggle('composer-action-hidden', running);
      stopButton.hidden = !running;
      stopButton.classList.toggle('composer-action-hidden', !running);
      composer.classList.toggle('is-running', running);
      updateTitleDotState();
    }

    function setComposerSending(active) {
      composer.classList.toggle('is-sending', Boolean(active));
      sendButton.classList.toggle('is-sending', Boolean(active));
    }

    async function sendText(options = {}) {
      const hasTextOverride = typeof options.text === 'string';
      const isPendingNewThreadFirstSend = Boolean(pendingNewThread && !selectedThreadId);
      const queueBehindActiveRun = Boolean((activeAssistant || pollTimer) && !isPendingNewThreadFirstSend);
      if (isPendingNewThreadFirstSend && (activeAssistant || pollTimer)) detachForegroundRunForNewThread();
      const text = hasTextOverride ? options.text : textarea.value;
      const attachmentsToSend = hasTextOverride ? [] : [...pendingAttachments];
      if (!text.trim() && !attachmentsToSend.length) return;
      const commandKind = options.commandKind || commandKindForText(text);
      const textCommandUi = commandUi(commandKind);
      clearLocalStopSuppression(selectedThreadId);

      setComposerSending(true);
      sendButton.disabled = true;
      setWorkingDot(true);
      setNotice(options.sendingNotice || (queueBehindActiveRun ? '正在发送到 Codex 队列…' : '正在发送到 Codex…'), 'ok');
      try {
        await ensureRouteForSend();
        await syncCodexThread(selectedThreadId, { quiet: true, force: true });
      } catch (error) {
        setNotice(error.message || '同步 Codex 线程失败，已取消发送', 'error');
        setComposerSending(false);
        sendButton.disabled = false;
        setWorkingDot(false);
        if (hasTextOverride) restoreLayoutAfterKeyboard();
        else textarea.focus({ preventScroll: true });
        return;
      }

      const queuedSendId = queueBehindActiveRun ? addQueuedSend(text, attachmentsToSend, 'sending', { commandKind }) : '';
      if (!queueBehindActiveRun) {
        const user = messageEl('user', text || (attachmentsToSend.length ? ' ' : ''), { label: options.userLabel || textCommandUi?.userLabel || (attachmentsToSend.length ? `你 · ${attachmentsToSend.length} 张图片` : '你') });
        appendImagesToBubble(user, attachmentsToSend);
      }
      const queuedAssistant = queueBehindActiveRun
        ? null
        : messageEl('assistant', textCommandUi?.pendingText || '已发送，等待 Codex 回复…', { label: textCommandUi ? textCommandUi.runningLabel('0s') : 'Codex · 运行 0s', pending: true });
      if (!queueBehindActiveRun) {
        activeAssistant = queuedAssistant;
        activeAssistant.commandKind = commandKind;
        setActiveRunStart('', Date.now());
      }
      if (selectedThreadId && !queueBehindActiveRun) {
        applyThreadRuntimeState(selectedThreadId, {
          status: 'waiting',
          active: true,
          startedAt: new Date().toISOString(),
          completedAt: '',
          updatedAt: new Date().toISOString(),
          turnId: '',
        }, { detectTransitions: false });
      }
      renderThreadMenu();
      updateComposerAction();
      if (!hasTextOverride) {
        textarea.value = '';
        pendingAttachments = [];
        renderAttachmentTray();
        autosize();
      }
      try {
        const clientRequestId = `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const res = await fetchApi('/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
          body: JSON.stringify({
            clientRequestId,
            text,
            target,
            threadId: selectedThreadId,
            previousThreadId: pendingNewThread?.previousThreadId || '',
            expectedCwd: pendingNewThread?.cwd || pendingNewThread?.projectPath || '',
            assumeThreadSynced: true,
            expectNewThread: isPendingNewThreadFirstSend,
            directPasteWithoutClick: isPendingNewThreadFirstSend,
            attachments: attachmentsToSend.map(({ name, type, dataUrl }) => ({ name, type, dataUrl })),
          }),
          apiTimeoutMs: 60000,
          routeSwitchQuiet: true,
          retryProbeTimeoutMs: 900,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || '发送失败');
        if (queueBehindActiveRun) updateQueuedSend(queuedSendId, 'queued');
        setNotice(options.sentNotice || (queueBehindActiveRun ? '已发送，Codex 会排在当前回复后继续处理' : '已发送'), 'ok');
        serializeMessages();
        if (!queueBehindActiveRun) startPolling(data.watch || { since: new Date().toISOString() });
      } catch (error) {
        if (queueBehindActiveRun) {
          removeQueuedSend(queuedSendId);
          messageEl('assistant', error.message || '发送失败', { label: 'Codex2Frp' });
        } else if (activeAssistant) {
          activeAssistant.article.classList.remove('pending');
          setMarkdown(activeAssistant.bubble, error.message || '发送失败');
          activeAssistant = null;
          stopPolling();
        }
        setNotice(error.message || '发送失败', 'error');
      } finally {
        setComposerSending(false);
        sendButton.disabled = false;
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
        if (hasTextOverride) restoreLayoutAfterKeyboard();
        else textarea.focus({ preventScroll: true });
      }
    }

    async function stopCodexResponse() {
      if (stopButton.disabled) return;
      const shouldRestoreTextareaFocus = document.activeElement === textarea;
      stopButton.disabled = true;
      setWorkingDot(true);
      setNotice('正在切到当前 Codex 线程并发送终止指令…', 'ok');
      try {
        const stopThreadId = activeWatch?.threadId || selectedThreadId || '';
        const response = await fetchApi('/codex/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mobile-typer-token': token },
          body: JSON.stringify({ threadId: stopThreadId }),
          apiTimeoutMs: 15000,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.message || '终止失败');
        markThreadLocallyStopped(stopThreadId);
        applyThreadRuntimeState(stopThreadId, {
          status: 'idle',
          active: false,
          startedAt: '',
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          turnId: '',
        }, { detectTransitions: false });
        renderThreadMenuIfVisualChanged();
        if (activeAssistant) {
          const preservedSteps = captureVisibleProcessSteps(activeAssistant);
          activeAssistant.article.classList.remove('pending');
          activeAssistant.meta.textContent = 'Codex · 已取消';
          setMarkdown(activeAssistant.bubble, '已取消当前回复。');
          activeAssistant.article.querySelector('details.process')?.remove();
          addDetails(activeAssistant, preservedSteps);
          activeAssistant = null;
        }
        stopPolling();
        serializeMessages();
        setNotice('已发送终止指令', 'ok');
      } catch (error) {
        setNotice(error.message || '终止失败', 'error');
      } finally {
        stopButton.disabled = false;
        if (!activeAssistant && !pollTimer) setWorkingDot(false);
        if (shouldRestoreTextareaFocus) textarea.focus({ preventScroll: true });
        else restoreLayoutAfterKeyboard();
      }
    }

    composer.addEventListener('submit', event => { event.preventDefault(); sendText(); });
    textarea.addEventListener('input', autosize);
    textarea.addEventListener('touchstart', prepareTextareaFocus, { passive: false });
    composer.addEventListener('touchstart', prepareComposerFocus, { passive: false });
    textarea.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch') prepareTextareaFocus(event);
    });
    composer.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch') prepareComposerFocus(event);
    });
    document.addEventListener('touchstart', noteOutsideComposerTouch, { passive: true, capture: true });
    document.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch') noteOutsideComposerTouch(event);
    }, { capture: true });
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault(); sendText();
      }
    });
    textarea.addEventListener('focus', beginKeyboardAlignment);
    textarea.addEventListener('click', scheduleKeyboardAlignment);
    textarea.addEventListener('touchend', scheduleKeyboardAlignment, { passive: true });
    textarea.addEventListener('blur', restoreLayoutAfterKeyboard);
    window.addEventListener('scroll', keepLayoutViewportPinned, { passive: true });
    window.addEventListener('resize', alignComposerForKeyboard);
    window.addEventListener('resize', positionThreadMenuCard);
    window.addEventListener('orientationchange', () => window.setTimeout(scheduleKeyboardAlignment, 250));
    window.addEventListener('orientationchange', () => window.setTimeout(positionThreadMenuCard, 250));
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', alignComposerForKeyboard);
      window.visualViewport.addEventListener('scroll', alignComposerForKeyboard);
      window.visualViewport.addEventListener('resize', positionThreadMenuCard);
      window.visualViewport.addEventListener('scroll', positionThreadMenuCard);
    }
    newThreadButton.addEventListener('click', createNewThreadInCurrentProject);

    let stopPointerTriggeredAt = 0;
    let sendPointerTriggeredAt = 0;
    function keepKeyboardForStopButton(event) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    }

    function keepKeyboardForSendButton(event) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    }

    function triggerStopButtonAction(event) {
      keepKeyboardForStopButton(event);
      stopPointerTriggeredAt = Date.now();
      stopCodexResponse();
    }

    function triggerSendButtonAction(event) {
      keepKeyboardForSendButton(event);
      if (sendButton.disabled || sendButton.hidden) return;
      sendPointerTriggeredAt = Date.now();
      sendText();
    }

    stopButton.addEventListener('pointerdown', keepKeyboardForStopButton, { passive: false });
    stopButton.addEventListener('pointerup', triggerStopButtonAction, { passive: false });
    stopButton.addEventListener('touchstart', keepKeyboardForStopButton, { passive: false });
    stopButton.addEventListener('touchend', event => {
      if (window.PointerEvent) {
        keepKeyboardForStopButton(event);
        return;
      }
      triggerStopButtonAction(event);
    }, { passive: false });
    stopButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() - stopPointerTriggeredAt < 700) return;
      stopCodexResponse();
    });
    sendButton.addEventListener('pointerdown', keepKeyboardForSendButton, { passive: false });
    sendButton.addEventListener('pointerup', triggerSendButtonAction, { passive: false });
    sendButton.addEventListener('touchstart', keepKeyboardForSendButton, { passive: false });
    sendButton.addEventListener('touchend', event => {
      if (window.PointerEvent) {
        keepKeyboardForSendButton(event);
        return;
      }
      triggerSendButtonAction(event);
    }, { passive: false });
    sendButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() - sendPointerTriggeredAt < 700) return;
      if (sendButton.disabled || sendButton.hidden) return;
      sendText();
    });
    attachButton.addEventListener('click', () => {
      fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files || []].filter(file => file.type.startsWith('image/'));
      try {
        for (const file of files) {
          const dataUrl = await fileToDataUrl(file);
          pendingAttachments.push({ name: file.name || 'image', type: file.type || 'image/png', dataUrl });
        }
        if (files.length) {
          renderAttachmentTray();
          setNotice(`已添加 ${files.length} 张图片，点击发送后会和文字一起发给 Codex`, 'ok');
        }
      } catch (error) {
        setNotice(error.message || '读取图片失败', 'error');
      }
      fileInput.value = '';
      textarea.focus({ preventScroll: true });
    });

    function keepActionTap(event) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    }

    function wireInstantActionButton(button, handler) {
      let pointerTriggeredAt = 0;
      const trigger = event => {
        keepActionTap(event);
        pointerTriggeredAt = Date.now();
        handler();
      };
      button.addEventListener('pointerdown', keepActionTap, { passive: false });
      button.addEventListener('pointerup', trigger, { passive: false });
      button.addEventListener('touchstart', keepActionTap, { passive: false });
      button.addEventListener('touchend', event => {
        if (window.PointerEvent) {
          keepActionTap(event);
          return;
        }
        trigger(event);
      }, { passive: false });
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() - pointerTriggeredAt < 700) return;
        handler();
      });
    }

    wireInstantActionButton(threadActionArchive, archiveCurrentThread);
    wireInstantActionButton(threadActionRename, showRenamePanel);
    wireInstantActionButton(threadActionPinToggle, toggleCurrentThreadPin);
    wireInstantActionButton(threadRenameCancel, cancelThreadRename);
    wireInstantActionButton(threadRenameSave, renameCurrentThread);
    wireInstantActionButton(contextQuickCompact, sendContextCompactCommand);
    let renameKeyboardSubmitAt = 0;
    function submitRenameFromKeyboard(event) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (Date.now() - renameKeyboardSubmitAt < 700) return;
      renameKeyboardSubmitAt = Date.now();
      renameCurrentThread();
    }
    threadRenameInput.addEventListener('beforeinput', event => {
      if (event.inputType === 'insertLineBreak') submitRenameFromKeyboard(event);
    });
    threadRenameInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === 'Return') {
        submitRenameFromKeyboard(event);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelThreadRename();
      }
    });
    threadRenameInput.addEventListener('keyup', event => {
      if (event.key === 'Enter' || event.key === 'Return') {
        submitRenameFromKeyboard(event);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelThreadRename();
      }
    });
    threadActionCard.addEventListener('pointerdown', event => event.stopPropagation());
    threadActionCard.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
    threadActionCard.addEventListener('click', event => event.stopPropagation());

    function cancelThreadLongPress() {
      window.clearTimeout(threadLongPressTimer);
      threadLongPressTimer = null;
      threadLongPressStart = null;
    }

    function clearNativeSelection() {
      try {
        const selection = window.getSelection && window.getSelection();
        if (selection && !selection.isCollapsed) selection.removeAllRanges();
      } catch {}
      try {
        if (document.activeElement && document.activeElement !== textarea && document.activeElement !== threadRenameInput) {
          document.activeElement.blur();
        }
      } catch {}
    }

    function threadMenuEdgeGap() {
      const styles = window.getComputedStyle(threadMenu);
      const cssGap = parseFloat(styles.getPropertyValue('--thread-menu-edge-gap'));
      if (Number.isFinite(cssGap) && cssGap > 0) return cssGap;
      const left = parseFloat(styles.left);
      return Number.isFinite(left) && left > 0 ? left : 12;
    }

    function positionThreadMenuCard() {
      if (!threadMenu) return;
      const styles = window.getComputedStyle(threadMenu);
      if (styles.position !== 'fixed') {
        threadMenu.style.top = '';
        threadMenu.style.maxHeight = '';
        if (threadMenuScrim) {
          threadMenuScrim.style.top = '';
          threadMenuScrim.style.bottom = '';
        }
        return;
      }
      const gap = threadMenuEdgeGap();
      const topbarBottom = topbar ? topbar.getBoundingClientRect().bottom : 0;
      const top = Math.max(0, topbarBottom + gap);
      const viewportBottom = window.visualViewport
        ? window.visualViewport.offsetTop + window.visualViewport.height
        : window.innerHeight;
      const composerTop = composer
        ? composer.getBoundingClientRect().top
        : (composerShell ? composerShell.getBoundingClientRect().top : viewportBottom);
      const bottom = Math.min(viewportBottom - gap, composerTop - gap);
      const maxHeight = Math.max(180, bottom - top);
      threadMenu.style.top = `${Math.round(top)}px`;
      threadMenu.style.maxHeight = `${Math.round(maxHeight)}px`;
      if (threadMenuScrim) {
        threadMenuScrim.style.top = `${Math.round(topbarBottom)}px`;
        threadMenuScrim.style.bottom = `${Math.max(0, Math.round(window.innerHeight - composerTop))}px`;
      }
    }

    function toggleThreadMenuFromTitle() {
      closeReasoningMenu();
      closeModelMenu();
      closeSpeedMenu();
      closeThreadActionCard();
      const willOpen = !threadMenu.classList.contains('is-open');
      threadMenu.classList.toggle('is-open');
      if (willOpen) positionThreadMenuCard();
      loadThreads({ detectTransitions: true, renderMenu: 'ifChanged' }).catch(error => setNotice(error.message || '读取线程失败', 'error'));
    }

    function startThreadLongPress(event) {
      if (!selectedThreadId || event.button > 0) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      threadLongPressStart = { x: event.clientX || 0, y: event.clientY || 0 };
      threadLongPressOpened = false;
      window.clearTimeout(threadLongPressTimer);
      threadLongPressTimer = window.setTimeout(() => {
        threadLongPressOpened = true;
        suppressThreadClickUntil = Date.now() + 900;
        clearNativeSelection();
        openThreadActionCard(selectedThreadId, { vibrate: true });
      }, 560);
    }

    function moveThreadLongPress(event) {
      if (!threadLongPressStart) return;
      const dx = Math.abs((event.clientX || 0) - threadLongPressStart.x);
      const dy = Math.abs((event.clientY || 0) - threadLongPressStart.y);
      if (dx > 10 || dy > 10) cancelThreadLongPress();
    }

    function finishThreadPress(event) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const shouldOpenMenu = Boolean(threadLongPressStart && !threadLongPressOpened && Date.now() >= suppressThreadClickUntil);
      cancelThreadLongPress();
      if (!shouldOpenMenu) return;
      suppressThreadClickUntil = Date.now() + 500;
      toggleThreadMenuFromTitle();
    }

    threadButton.addEventListener('pointerdown', startThreadLongPress);
    threadButton.addEventListener('pointermove', moveThreadLongPress);
    threadButton.addEventListener('pointerup', finishThreadPress);
    threadButton.addEventListener('pointercancel', cancelThreadLongPress);
    threadButton.addEventListener('contextmenu', event => {
      event.preventDefault();
      cancelThreadLongPress();
      suppressThreadClickUntil = Date.now() + 900;
      clearNativeSelection();
      openThreadActionCard(selectedThreadId, { vibrate: true });
    });
    threadButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressThreadClickUntil) return;
      toggleThreadMenuFromTitle();
    });
    reasoningMenuCard.addEventListener('pointerdown', event => event.stopPropagation());
    reasoningMenuCard.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
    reasoningMenuCard.addEventListener('click', event => event.stopPropagation());
    modelMenuCard.addEventListener('pointerdown', event => event.stopPropagation());
    modelMenuCard.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
    modelMenuCard.addEventListener('click', event => event.stopPropagation());
    speedMenuCard.addEventListener('pointerdown', event => event.stopPropagation());
    speedMenuCard.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
    speedMenuCard.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', event => {
      if (!threadMenu.contains(event.target) && !threadButton.contains(event.target) && !newThreadButton.contains(event.target) && !reasoningBadge.contains(event.target) && !modelBadge.contains(event.target) && !speedBadge.contains(event.target)) threadMenu.classList.remove('is-open');
      if (!threadActionCard.contains(event.target) && !threadButton.contains(event.target) && !reasoningBadge.contains(event.target) && !modelBadge.contains(event.target) && !speedBadge.contains(event.target)) closeThreadActionCard();
      if (!contextQuickCard.contains(event.target) && !topStatus.contains(event.target)) closeContextQuickCard();
      if (!reasoningMenuCard.contains(event.target) && !reasoningBadge.contains(event.target)) closeReasoningMenu();
      if (!modelMenuCard.contains(event.target) && !modelBadge.contains(event.target)) closeModelMenu();
      if (!speedMenuCard.contains(event.target) && !speedBadge.contains(event.target)) closeSpeedMenu();
    });
    keepAwakeButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      closeReasoningMenu();
      closeModelMenu();
      closeSpeedMenu();
      toggleKeepAwake();
    });
    topStatus.addEventListener('pointerdown', startContextLongPress);
    topStatus.addEventListener('pointermove', moveContextLongPress);
    topStatus.addEventListener('pointerup', finishContextPress);
    topStatus.addEventListener('pointercancel', cancelContextLongPress);
    topStatus.addEventListener('contextmenu', event => {
      event.preventDefault();
      cancelContextLongPress();
      suppressContextClickUntil = Date.now() + 900;
      clearNativeSelection();
      openContextQuickCard({ vibrate: true });
    });
    topStatus.addEventListener('click', event => {
      if (Date.now() < suppressContextClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      cycleContextDisplayMode();
    });
    topStatus.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        cycleContextDisplayMode();
      }
    });
    reasoningBadge.addEventListener('pointerdown', startReasoningLongPress);
    reasoningBadge.addEventListener('pointermove', moveReasoningLongPress);
    reasoningBadge.addEventListener('pointerup', finishReasoningPress);
    reasoningBadge.addEventListener('pointercancel', cancelReasoningLongPress);
    reasoningBadge.addEventListener('contextmenu', event => {
      event.preventDefault();
      cancelReasoningLongPress();
      suppressReasoningClickUntil = Date.now() + 900;
      clearNativeSelection();
      openReasoningMenu({ vibrate: true });
    });
    reasoningBadge.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressReasoningClickUntil) return;
      if (reasoningMenuCard.classList.contains('is-open')) closeReasoningMenu();
      else openReasoningMenu();
    });
    reasoningBadge.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openReasoningMenu();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        openReasoningMenu();
      }
    });
    modelBadge.addEventListener('pointerdown', startModelLongPress);
    modelBadge.addEventListener('pointermove', moveModelLongPress);
    modelBadge.addEventListener('pointerup', finishModelPress);
    modelBadge.addEventListener('pointercancel', cancelModelLongPress);
    modelBadge.addEventListener('contextmenu', event => {
      event.preventDefault();
      cancelModelLongPress();
      suppressModelClickUntil = Date.now() + 900;
      clearNativeSelection();
      openModelMenu({ vibrate: true });
    });
    modelBadge.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressModelClickUntil) return;
      closeReasoningMenu();
      closeModelMenu();
      openModelMenu();
    });
    modelBadge.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        closeReasoningMenu();
        closeModelMenu();
        closeSpeedMenu();
        openModelMenu();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        openModelMenu();
      }
    });
    speedBadge.addEventListener('pointerdown', startSpeedLongPress);
    speedBadge.addEventListener('pointermove', moveSpeedLongPress);
    speedBadge.addEventListener('pointerup', finishSpeedPress);
    speedBadge.addEventListener('pointercancel', cancelSpeedLongPress);
    speedBadge.addEventListener('contextmenu', event => {
      event.preventDefault();
      cancelSpeedLongPress();
      suppressSpeedClickUntil = Date.now() + 900;
      clearNativeSelection();
      openSpeedMenu({ vibrate: true });
    });
    speedBadge.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressSpeedClickUntil) return;
      closeReasoningMenu();
      closeModelMenu();
      closeSpeedMenu();
      openSpeedMenu();
    });
    speedBadge.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        closeReasoningMenu();
        closeModelMenu();
        closeSpeedMenu();
        openSpeedMenu();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        openSpeedMenu();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleForegroundStateRefresh();
    });
    window.addEventListener('pageshow', scheduleForegroundStateRefresh);
    window.addEventListener('focus', scheduleForegroundStateRefresh);

    lockViewportZoom();
    lockComposerDrag();
    lockPageScrollToThread();
    applyViewportSize();
    autosize();
    async function bootApp() {
      markPerf('boot:start');
      updateRouteBadge();
      renderReasoningBadge(bestReasoningMode(null, selectedThreadId));
      renderModelBadge(bestModelInfo(null, selectedThreadId));
      renderSpeedBadge(bestSpeedMode(null, selectedThreadId));
      setNotice('正在连接 Codex2Frp…', 'ok');

      const configPromise = loadApiConfig()
        .then(() => chooseApiCandidate({
          preferCurrent: shouldPreferCurrentApiBase,
          preferLocal: !shouldPreferCurrentApiBase,
          quiet: true,
          probeTimeoutMs: shouldPreferCurrentApiBase ? 1800 : 900,
        }))
        .then(() => refreshSakuraStatus())
        .catch(error => console.warn('Codex2Frp config startup skipped:', error));

      const threadsPromise = loadThreads({ renderMenu: 'always' })
        .catch(error => {
          setNotice(error.message || '读取线程失败', 'error');
          throw error;
        });

      const historyPromise = threadsPromise
        .then(() => selectedThreadId ? loadThreadHistory(selectedThreadId) : Promise.resolve())
        .catch(error => console.warn('Codex2Frp history startup skipped:', error));

      await Promise.allSettled([configPromise, threadsPromise.catch(() => null), historyPromise, refreshKeepAwakeStatus()]);
      startAutoRefresh();
      startThreadStateWatcher();
      startRouteMonitor();
      markPerf('boot:ready', { marks: perfMarks.length });
    }

    bootApp().catch(error => setNotice(error.message || '启动失败', 'error'));
    if (!window.matchMedia('(max-width: 700px), (pointer: coarse)').matches) {
      textarea.focus({ preventScroll: true });
    }
