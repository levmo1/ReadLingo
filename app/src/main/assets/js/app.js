/* ============ ReadLingo 应用逻辑 ============ */
(function () {
  'use strict';

  const DB_NAME = 'readlingo';
  const DB_VER = 3;
  // 导入边界：避免异常大的用户文件耗尽 WebView/IndexedDB 内存或配额。
  const MAX_BOOK_BYTES = 64 * 1024 * 1024;
  const MAX_FONT_BYTES = 8 * 1024 * 1024;
  const MAX_FONT_TOTAL_BYTES = 32 * 1024 * 1024;
  const MAX_WORDBOOK_BYTES = 8 * 1024 * 1024;
  const MAX_WORDBOOK_WORDS = 100000;
  const BUILTIN_BOOKS = [
    { path: 'books/pg2701.epub', title: 'Moby-Dick', author: 'Herman Melville' },
    { path: 'books/pg1342.epub', title: 'Pride and Prejudice', author: 'Jane Austen' },
    { path: 'books/pg11.epub',   title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' },
  ];
  const BUILTIN_WORDBOOKS = [
    // 保留旧 ID 以便迁移已有 IndexedDB；内容已替换为 wordfreq 的开放数据分层。
    { id: 'builtin-cet4', name: '开放英语·核心词汇', cover: 'CORE', path: 'wordbooks/core.txt', sourceVersion: 'wordfreq-3.1.1-v1' },
    { id: 'builtin-cet6', name: '开放英语·进阶词汇', cover: 'LEVEL 2', path: 'wordbooks/intermediate.txt', sourceVersion: 'wordfreq-3.1.1-v1' },
    { id: 'builtin-ielts', name: '开放英语·高阶词汇', cover: 'LEVEL 3', path: 'wordbooks/advanced.txt', sourceVersion: 'wordfreq-3.1.1-v1' },
    { id: 'builtin-toefl', name: '开放英语·扩展词汇', cover: 'EXTEND', path: 'wordbooks/extended.txt', sourceVersion: 'wordfreq-3.1.1-v1' },
  ];

  /* ---------------- 工具 ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden', 'hiding');
    void t.offsetWidth;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.classList.add('hiding');
      setTimeout(() => t.classList.add('hidden'), 200);
    }, 2000);
  }

  /* ---------------- IndexedDB ---------------- */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          const s = db.createObjectStore('books', { keyPath: 'id' });
          s.createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains('vocab')) {
          db.createObjectStore('vocab', { keyPath: 'word' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('collections')) {
          db.createObjectStore('collections', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('wordbooks')) {
          db.createObjectStore('wordbooks', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('words')) {
          db.createObjectStore('words', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('wordState')) {
          db.createObjectStore('wordState', { keyPath: 'wordId' });
        }
        if (!db.objectStoreNames.contains('dailyLog')) {
          db.createObjectStore('dailyLog', { keyPath: 'date' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const idbGet = (store, key) => new Promise((resolve, reject) => {
    const tx = App.db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const idbAll = (store) => new Promise((resolve, reject) => {
    const tx = App.db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const idbPut = (store, val) => new Promise((resolve, reject) => {
    const tx = App.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const idbBulkPut = (store, values) => new Promise((resolve, reject) => {
    const tx = App.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    values.forEach((v) => os.put(v));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const idbDel = (store, key) => new Promise((resolve, reject) => {
    const tx = App.db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  /* ---------------- 全局状态 ---------------- */
  const App = {
    db: null,
    books: [],
    vocab: [],
    collections: [],
    wordbooks: [],   // 词书 {id, name, createdAt, source}
    words: [],       // 单词 {id, word, phonetic, meaning, example, bookId}
    wordStates: {},  // 记忆状态 {wordId, status, reps, lapses, streak, interval, nextReview, lastReviewAt}
    dailyLog: null,  // 今日记录
    dailyLogs: [],   // 历史每日学习记录
    libState: 'all', // 'all' | collectionId（书架当前显示模式）
    studySession: null, // 背词会话
    studyPicker: { sourceId: '', query: '', draftIds: [], filteredWords: [], renderedCount: 0 },
    settings: { theme: 'light', fontSize: 19, lineHeight: 1.8, flow: 'paginated', pageAnim: 'slide', font: 'literata', dailyTarget: 20, progressMode: 'bar', customFonts: [] },
    current: null, // { id, book(epub.js), rendition, title }
    dictQueue: null,
  };
  let readerNavigationBusy = false;

  /* ================= 书架 ================= */
  async function loadLibrary() {
    App.books = (await idbAll('books')).sort((a, b) => a.addedAt - b.addedAt);
    // 迁移：旧版单合集字段 collectionId → 多合集数组 collectionIds（一次性）
    let migrated = false;
    for (const b of App.books) {
      if (!Array.isArray(b.collectionIds)) {
        b.collectionIds = b.collectionId ? [b.collectionId] : [];
        delete b.collectionId;
        try { await idbPut('books', b); } catch (e) { /* 忽略 */ }
        migrated = true;
      }
    }
    if (migrated) App.books = (await idbAll('books')).sort((a, b) => a.addedAt - b.addedAt);
    App.collections = (await idbAll('collections')).sort((a, b) => a.createdAt - b.createdAt);
    // 合集被删除等异常后兜底回全部
    if (App.libState !== 'all' && !App.collections.find((c) => c.id === App.libState)) {
      App.libState = 'all';
    }
    renderLibrary();
  }

  // 书的合集归属判断（兼容数组）
  function inCollection(book, colId) {
    return Array.isArray(book.collectionIds) && book.collectionIds.includes(colId);
  }

  // 长按手势（书架卡片用）：500ms 无位移触发，触发后吞掉随后的 click
  function bindLibLongPress(el, onLong) {
    let timer = null, sx = 0, sy = 0, pressed = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      pressed = true; sx = e.clientX; sy = e.clientY;
      el.dataset.suppressClick = '0';
      timer = setTimeout(() => {
        if (pressed) {
          el.dataset.suppressClick = '1';
          onLong(e);
        }
      }, 500);
    });
    const end = () => { pressed = false; clearTimeout(timer); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointermove', (e) => {
      if (pressed && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) {
        pressed = false; clearTimeout(timer);
      }
    });
  }

  // 合集横条渲染（仅"全部"模式显示）
  function renderCollectionsBar() {
    const bar = $('#collections-bar');
    const list = $('#collections-list');
    // 释放上一次渲染的 blob URL（封面缩略图）
    list.querySelectorAll('img[src^="blob:"]').forEach((img) => {
      try { URL.revokeObjectURL(img.src); } catch (e) { /* 忽略 */ }
    });
    list.innerHTML = '';
    if (App.libState !== 'all' || App.collections.length === 0) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    App.collections.forEach((c) => {
      // 取合集前 4 本书的封面做 2x2 竖版封面网格（微信读书书架风格，完整显示不裁切）
      const colBooks = App.books.filter((b) => inCollection(b, c.id));
      const books = colBooks.slice(0, 4);
      const count = colBooks.length;
      const card = document.createElement('div');
      card.className = 'collection-card';
      card.dataset.id = c.id;
      const covers = document.createElement('div');
      covers.className = 'col-covers';
      for (let i = 0; i < 4; i++) {
        const cell = document.createElement('div');
        cell.className = 'col-cover';
        const bk = books[i];
        if (bk && bk.cover) {
          const img = document.createElement('img');
          img.src = URL.createObjectURL(bk.cover);
          img.alt = '';
          cell.appendChild(img);
        } else {
          cell.textContent = '📁';
        }
        covers.appendChild(cell);
      }
      const meta = document.createElement('div');
      meta.className = 'col-meta';
      meta.innerHTML = `<div class="col-name">${esc(c.name)}</div><div class="col-count">${count} 本</div>`;
      card.appendChild(covers);
      card.appendChild(meta);
      card.addEventListener('click', () => {
        // 长按触发过则吞掉本次 click（防菜单弹出后误入合集）
        if (card.dataset.suppressClick === '1') { card.dataset.suppressClick = '0'; return; }
        enterCollection(c.id);
      });
      bindLibLongPress(card, () => {
        showLibMenu([
          { icon: '✏️', text: '重命名合集', fn: () => renameCollection(c.id) },
          { icon: '🗑️', text: '删除合集', danger: true, fn: () => deleteCollection(c.id) },
        ], card);
      });
      list.appendChild(card);
    });
  }

  function enterCollection(id) {
    App.libState = id;
    renderLibrary();
  }
  function exitCollection() {
    App.libState = 'all';
    renderLibrary();
  }

  /* ---------------- 书架长按菜单 ---------------- */
  let libMenuAnchor = null; // 当前菜单锚点元素（document pointerdown 关菜单时用于吞掉锚点卡的 click）
  function showLibMenu(items, anchorEl) {
    hideLibMenu();
    libMenuAnchor = anchorEl || null;
    const menu = $('#lib-menu');
    menu.innerHTML = '';
    items.forEach((it) => {
      const btn = document.createElement('button');
      btn.className = 'lm-item' + (it.danger ? ' lm-danger' : '');
      btn.innerHTML = `<span>${it.icon}</span><span>${esc(it.text)}</span>`;
      btn.addEventListener('click', () => { hideLibMenu(); it.fn(); });
      menu.appendChild(btn);
    });
    menu.classList.remove('hidden');
    const r = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 200;
    let x = r.left, y = r.bottom + 6;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';
  }
  function hideLibMenu() {
    const m = $('#lib-menu');
    if (!m.classList.contains('hidden')) m.classList.add('hidden');
  }

  /* ---------------- 输入/确认弹窗 ---------------- */
  let dialogOnOk = null, confirmOnOk = null, confirmOnCancel = null;
  function showInputDialog(title, placeholder, initial, onOk) {
    $('#dialog-title').textContent = title;
    $('#dialog-input').placeholder = placeholder || '请输入名称';
    $('#dialog-input').value = initial || '';
    $('#dialog-mask').classList.remove('hidden');
    $('#input-dialog').classList.remove('hidden');
    dialogOnOk = onOk;
    setTimeout(() => { try { $('#dialog-input').focus(); } catch (e) { /* 忽略 */ } }, 60);
  }
  function hideInputDialog() {
    $('#dialog-mask').classList.add('hidden');
    $('#input-dialog').classList.add('hidden');
    dialogOnOk = null;
  }
  function showConfirmDialog(text, onOk, onCancel) {
    $('#confirm-text').textContent = text;
    $('#dialog-mask').classList.remove('hidden');
    $('#confirm-dialog').classList.remove('hidden');
    confirmOnOk = onOk;
    confirmOnCancel = onCancel || null;
  }
  function hideConfirmDialog() {
    $('#dialog-mask').classList.add('hidden');
    $('#confirm-dialog').classList.add('hidden');
    confirmOnOk = null;
    confirmOnCancel = null;
  }

  /* ---------------- 合集/书籍操作 ---------------- */
  async function createCollection(bookId) {
    showInputDialog('新建合集', '合集名称', '', async (name) => {
      name = (name || '').trim();
      if (!name) { toast('名称不能为空'); return; }
      const col = { id: uid(), name, createdAt: Date.now() };
      await idbPut('collections', col);
      App.collections.push(col);
      App.collections.sort((a, b) => a.createdAt - b.createdAt);
      if (bookId) {
        const rec = App.books.find((b) => b.id === bookId);
        if (rec) {
          if (!Array.isArray(rec.collectionIds)) rec.collectionIds = [];
          if (!rec.collectionIds.includes(col.id)) rec.collectionIds.push(col.id);
          await idbPut('books', rec);
        }
      }
      toast(`已创建合集「${name}」`);
      renderLibrary();
    });
  }
  // 添加至合集：显示合集列表（已在的标记 ✓，点击 = 加入/退出 toggle）
  function addToCollection(bookId) {
    if (App.collections.length === 0) {
      toast('还没有合集，请先「创建合集」');
      return;
    }
    const rec = App.books.find((b) => b.id === bookId);
    if (!rec) return;
    const items = App.collections.map((c) => {
      const joined = inCollection(rec, c.id);
      return {
        icon: joined ? '✅' : '📁',
        text: (joined ? '✓ ' : '') + c.name,
        fn: async () => {
          if (!Array.isArray(rec.collectionIds)) rec.collectionIds = [];
          if (joined) {
            rec.collectionIds = rec.collectionIds.filter((x) => x !== c.id);
            toast(`已从「${c.name}」移出`);
          } else {
            rec.collectionIds.push(c.id);
            toast(`已加入「${c.name}」`);
          }
          await idbPut('books', rec);
          renderLibrary();
        },
      };
    });
    items.unshift({ icon: '➕', text: '新建合集…', fn: () => createCollection(bookId) });
    const menu = $('#lib-menu');
    menu.innerHTML = '';
    items.forEach((it) => {
      const btn = document.createElement('button');
      btn.className = 'lm-item';
      btn.innerHTML = `<span>${it.icon}</span><span>${esc(it.text)}</span>`;
      btn.addEventListener('click', () => { hideLibMenu(); it.fn(); });
      menu.appendChild(btn);
    });
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 260;
    let x = window.innerWidth - mw - 16, y = 120;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';
  }
  function renameBook(bookId) {
    const rec = App.books.find((b) => b.id === bookId);
    if (!rec) return;
    showInputDialog('重命名书籍', '书籍名称', rec.title, async (name) => {
      name = (name || '').trim();
      if (!name) { toast('名称不能为空'); return; }
      rec.title = name;
      await idbPut('books', rec);
      toast('已重命名');
      renderLibrary();
    });
  }
  async function deleteBook(bookId) {
    const rec = App.books.find((b) => b.id === bookId);
    if (!rec) return;
    showConfirmDialog(`确定删除「${rec.title}」吗？删除后无法恢复。`, async () => {
      await idbDel('books', bookId);
      App.books = App.books.filter((b) => b.id !== bookId);
      toast('已删除');
      renderLibrary();
    });
  }
  function renameCollection(colId) {
    const col = App.collections.find((c) => c.id === colId);
    if (!col) return;
    showInputDialog('重命名合集', '合集名称', col.name, async (name) => {
      name = (name || '').trim();
      if (!name) { toast('名称不能为空'); return; }
      col.name = name;
      await idbPut('collections', col);
      toast('已重命名');
      renderLibrary();
    });
  }
  async function deleteCollection(colId) {
    const col = App.collections.find((c) => c.id === colId);
    if (!col) return;
    showConfirmDialog(`确定删除合集「${col.name}」吗？合集内书籍将回到书架，书籍本身不会被删除。`, async () => {
      await idbDel('collections', colId);
      App.collections = App.collections.filter((c) => c.id !== colId);
      // 从所有书的合集数组中移除该合集
      for (const b of App.books) {
        if (Array.isArray(b.collectionIds) && b.collectionIds.includes(colId)) {
          b.collectionIds = b.collectionIds.filter((x) => x !== colId);
          await idbPut('books', b);
        }
      }
      if (App.libState === colId) App.libState = 'all';
      toast('已删除合集');
      renderLibrary();
    });
  }
  async function removeFromCollection(bookId) {
    const rec = App.books.find((b) => b.id === bookId);
    if (!rec) return;
    if (Array.isArray(rec.collectionIds)) {
      rec.collectionIds = rec.collectionIds.filter((x) => x !== App.libState);
    }
    await idbPut('books', rec);
    toast('已退出合集');
    renderLibrary();
  }

  async function ensureBuiltinBooks() {
    const existing = await idbAll('books');
    if (existing.length > 0) return;
    for (const b of BUILTIN_BOOKS) {
      try {
        const resp = await fetch(b.path);
        if (!resp.ok) continue;
        const data = await resp.arrayBuffer();
        await importBookBuffer(data, b.title, b.author, true);
      } catch (e) { console.warn('内置书导入失败', b.path, e); }
    }
  }

  async function importBookBuffer(data, title, author, builtin) {
    if (!data || typeof data.byteLength !== 'number' || data.byteLength > MAX_BOOK_BYTES) {
      if (!builtin) toast('EPUB 文件过大，最大支持 64 MB');
      return null;
    }
    // 去重：同一文件内容重复导入时跳过（比对字节数与首 64 字节）
    const head = new Uint8Array(data.slice(0, 64));
    const existing = await idbAll('books');
    const dup = existing.find((b) => {
      if (!b.data || b.data.byteLength !== data.byteLength) return false;
      const bHead = new Uint8Array(b.data.slice(0, 64));
      for (let i = 0; i < head.length; i++) {
        if (head[i] !== bHead[i]) return false;
      }
      return true;
    });
    if (dup) return dup;

    let meta = { title, author };
    let coverBlob = null;
    try {
      const book = ePub(data);
      const m = await book.loaded.metadata;
      meta = { title: m.title || title, author: m.creator || author };
      try {
        const coverUrl = await book.coverUrl();
        if (coverUrl) {
          const r = await fetch(coverUrl);
          coverBlob = await r.blob();
        }
      } catch (e) { /* 无封面 */ }
      book.destroy();
    } catch (e) { console.warn('元数据解析失败', e); }

    const rec = {
      id: uid(),
      title: meta.title,
      author: meta.author,
      data: data,
      cover: coverBlob,
      progressCfi: null,
      progressPct: 0,
      addedAt: Date.now(),
      builtin: !!builtin,
      collectionIds: [], // 多对多：一本书可属于多个合集
    };
    await idbPut('books', rec);
    return rec;
  }

  function renderLibrary() {
    const grid = $('#library-grid');
    const empty = $('#library-empty');
    // 释放上一次渲染创建的 blob URL（防止多次重绘累积泄漏）
    grid.querySelectorAll('img[src^="blob:"]').forEach((img) => {
      try { URL.revokeObjectURL(img.src); } catch (e) { /* 忽略 */ }
    });
    grid.innerHTML = '';
    $('#vocab-count').textContent = App.vocab.length;

    // 合集模式 UI：头部返回条 / 合集横条（全部模式）
    const colHeader = $('#collection-header');
    const colNameEl = $('#collection-name');
    if (App.libState !== 'all') {
      const col = App.collections.find((c) => c.id === App.libState);
      colHeader.classList.remove('hidden');
      colNameEl.textContent = col ? col.name : '合集';
    } else {
      colHeader.classList.add('hidden');
    }
    renderCollectionsBar();

    // 按当前模式过滤书籍
    const visible = App.libState === 'all'
      ? App.books
      : App.books.filter((b) => inCollection(b, App.libState));

    if (visible.length === 0) {
      grid.classList.add('hidden');
      empty.classList.remove('hidden');
      $('#empty-text').textContent = App.libState === 'all' ? '书架上还没有书' : '这个合集还没有书';
      return;
    }
    grid.classList.remove('hidden');
    empty.classList.add('hidden');

    for (let i = 0; i < visible.length; i++) {
      const b = visible[i];
      const card = document.createElement('div');
      card.className = 'book-card';
      card.title = `${b.title} — ${b.author}`;
      // 入场 stagger：每张卡片延迟 60ms
      card.style.animationDelay = (i * 60) + 'ms';

      const cover = document.createElement('div');
      cover.className = 'book-cover';
      if (b.cover) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(b.cover);
        img.alt = b.title;
        cover.appendChild(img);
      } else {
        const fb = document.createElement('div');
        fb.className = 'book-cover-fallback';
        fb.textContent = (b.title || '?').trim().charAt(0).toUpperCase();
        cover.appendChild(fb);
      }

      const meta = document.createElement('div');
      meta.className = 'book-meta';
      meta.innerHTML =
        `<div class="book-title">${esc(b.title)}</div>` +
        `<div class="book-author">${esc(b.author || '')}</div>`;
      if (b.progressPct > 0) {
        meta.innerHTML +=
          `<div class="book-progress-track"><div class="book-progress-fill" style="width:${Math.round(b.progressPct * 100)}%"></div></div>`;
      }

      card.appendChild(cover);
      card.appendChild(meta);
      card.dataset.id = b.id; // 供进度原位更新定位（避免每翻一页全量重绘书架）
      card.addEventListener('click', () => {
        // 长按触发过则吞掉本次 click（防菜单弹出后误开书）
        if (card.dataset.suppressClick === '1') { card.dataset.suppressClick = '0'; return; }
        openBook(b.id);
      });
      // 长按 → 上下文菜单（全部模式：创建合集/添加至合集/重命名/删除；合集模式：退出合集/重命名/删除）
      bindLibLongPress(card, () => {
        const inCollection = App.libState !== 'all';
        const items = inCollection
          ? [
              { icon: '📤', text: '退出合集', fn: () => removeFromCollection(b.id) },
              { icon: '✏️', text: '重命名', fn: () => renameBook(b.id) },
              { icon: '🗑️', text: '删除书籍', danger: true, fn: () => deleteBook(b.id) },
            ]
          : [
              { icon: '📁', text: '创建合集', fn: () => createCollection(b.id) },
              { icon: '➕', text: '添加至合集', fn: () => addToCollection(b.id) },
              { icon: '✏️', text: '重命名', fn: () => renameBook(b.id) },
              { icon: '🗑️', text: '删除书籍', danger: true, fn: () => deleteBook(b.id) },
            ];
        showLibMenu(items, card);
      });
      grid.appendChild(card);
    }
  }

  // 防抖保存阅读进度（relocated 每翻一页触发；防抖避免写库 + 重绘开销）
  let progressSaveTimer = null;
  function scheduleProgressSave(rec) {
    clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(() => {
      try { idbPut('books', rec); } catch (e) { /* 忽略 */ }
    }, 600);
    updateBookCardProgress(rec);
  }
  // 原地更新书架卡片进度条（不整表重绘，避免每翻一页重建书卡 + blob URL 泄漏）
  function updateBookCardProgress(rec) {
    const card = document.querySelector('.book-card[data-id="' + rec.id + '"]');
    if (!card) return;
    let track = card.querySelector('.book-progress-track');
    if (!track) {
      track = document.createElement('div');
      track.className = 'book-progress-track';
      const fill = document.createElement('div');
      fill.className = 'book-progress-fill';
      track.appendChild(fill);
      const meta = card.querySelector('.book-meta');
      if (meta) meta.appendChild(track);
    }
    const fill = track.querySelector('.book-progress-fill');
    fill.style.width = Math.round(rec.progressPct * 100) + '%';
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  // 读取 File 为 ArrayBuffer（兼容 File.arrayBuffer 缺失的旧 WebView）
  function readFileAsBuffer(file, maxBytes = MAX_BOOK_BYTES) {
    return new Promise((resolve) => {
      if (!file || (Number.isFinite(file.size) && file.size > maxBytes)) {
        resolve(null);
        return;
      }
      const finish = (data) => {
        resolve(data && data.byteLength <= maxBytes ? data : null);
      };
      if (typeof file.arrayBuffer === 'function') {
        file.arrayBuffer().then(finish).catch(() => readViaFileReader(file, finish));
      } else {
        readViaFileReader(file, finish);
      }
    });
  }
  function readViaFileReader(file, done) {
    const r = new FileReader();
    r.onload = () => done(r.result);
    r.onerror = () => done(null);
    r.readAsArrayBuffer(file);
  }

  /* ================= 阅读器 ================= */
  async function openBook(id) {
    const rec = App.books.find((b) => b.id === id);
    if (!rec) return;
    switchView('view-reader');
    // 兜底：开新书前清理残留的阅读器 UI（防异常路径退出残留的浮窗）
    cleanupReaderUI();

    // 销毁上一本书（重建/切换模式时防止新旧 rendition 并存导致资源请求竞态）
    if (App.current && App.current.book) {
      try {
        App.current.book.destroy();
        App.current.rendition && App.current.rendition.destroy();
      } catch (e) { /* 忽略 */ }
      App.current = null;
    }

    const container = $('#reader-container');
    container.innerHTML = '';

    const book = ePub(rec.data.slice(0));
    App.current = { id, book, rec, pageStats: { chapterPages: {} } };

    const rendition = book.renderTo(container, {
      width: '100%',
      height: '100%',
      flow: App.settings.flow,
      spread: 'none',
      allowScriptedContent: false,
    });
    App.current.rendition = rendition;

    $('#reader-title').textContent = rec.title;
    $('#progress-bar').style.width = '0%';
    $('#progress-label').textContent = '全书进度';
    $('#progress-text').textContent = '0%';
    $('#reader-status').dataset.mode = App.settings.progressMode || 'bar';
    syncReaderFlowUI();

    applyReaderSettings();
    buildToc(book);
    bindThemeSerialize(book); // async：内部等 spine 就绪后再注册，不阻塞后续
    bindRenditionEvents(rendition);
    bindPageZones(rendition);
    bindSwipe(rendition);
    bindSelectionClamp(rendition);
    bindThemeInject(rendition);
    bindCustomSelection(rendition);

    try {
      if (rec.progressCfi) {
        await rendition.display(rec.progressCfi);
      } else {
        await rendition.display();
      }
    } catch (e) {
      console.warn('进度跳转失败，从头开始', e);
      try { await rendition.display(); } catch (e2) { /* 忽略 */ }
    }
  }

  function buildToc(book) {
    const list = $('#toc-list');
    list.innerHTML = '';
    // Gutenberg 老书的 ncx 把插图说明与章节标题拼接成 label
    // （如 "A note for Miss Bennet. CHAPTER VII."、"“At the door.” CHAPTERXXVIII."），
    // 清洗规则：CHAPTER 标记不在 label 开头（前面有插图 caption）→ 只保留章节号并规范化；
    // CHAPTER 在开头（如 "CHAPTER 1. Loomings"）→ 保留原文（章节名是正常标题的一部分）
    const cleanTocLabel = (raw) => {
      const label = raw.trim();
      const m = label.match(/(?:CHAPTER|Chapter)\s*([IVXLCDM]+|\d+)\.?/i);
      if (!m) return label;
      if (m.index > 0) return 'CHAPTER ' + m[1] + '.';
      // CHAPTER 在开头：后面无其他文本（纯章节号，如 "Chapter XLVI."）→ 统一大写；
      // 后面有章节名（如 "CHAPTER 1. Loomings"）→ 保留原文
      const rest = label.slice(m[0].length).trim();
      return rest ? label : 'CHAPTER ' + m[1] + '.';
    };
    book.loaded.navigation.then((nav) => {
      const walk = (items, depth) => {
        for (const it of items) {
          const label = cleanTocLabel(it.label);
          // 通用过滤：无意义子项（空 label 或纯编号如 "I."、"II."、"1."）不渲染——
          // Gutenberg 书常见：章内锚点子项 label 只有罗马数字/数字、无标题文字
          // （如《福尔摩斯探案集》A SCANDAL IN BOHEMIA 下三个空子项）
          if (depth > 0 && (!label || /^[IVXLCDM]+\.?$/.test(label) || /^\d+\.?$/.test(label))) {
            if (it.subitems && it.subitems.length) walk(it.subitems, depth + 1);
            continue;
          }
          const li = document.createElement('li');
          if (depth > 0) li.className = 'sub';
          const a = document.createElement('a');
          a.textContent = label;
          a.href = '#';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            closeToc();
            App.current.rendition.display(it.href);
          });
          li.appendChild(a);
          list.appendChild(li);
          if (it.subitems && it.subitems.length) walk(it.subitems, depth + 1);
        }
      };
      walk(nav.toc, 0);
      if (!nav.toc.length) {
        list.innerHTML = '<li style="padding:12px 18px;color:#aaa;font-size:13px;">（本书无目录）</li>';
      }
    });
  }

  function renderReaderProgress(location) {
    if (!location || !location.start || !App.current) return 0;
    const start = location.start;
    let pct = Number(start.percentage) || 0;
    const spineLen = (App.current.book.spine && App.current.book.spine.length) || 1;
    const chapterIndex = typeof start.index === 'number' ? start.index : 0;
    if (pct === 0 && spineLen > 1) pct = chapterIndex / spineLen;
    pct = Math.min(1, Math.max(0, pct));

    const displayed = start.displayed || {};
    const chapterPage = Math.max(1, Number(displayed.page) || 1);
    const chapterTotal = Math.max(chapterPage, Number(displayed.total) || 1);
    const stats = App.current.pageStats || (App.current.pageStats = { chapterPages: {} });
    stats.chapterPages[chapterIndex] = chapterTotal;
    const known = Object.keys(stats.chapterPages).map((k) => Number(stats.chapterPages[k])).filter((n) => n > 0);
    const average = known.length ? known.reduce((a, b) => a + b, 0) / known.length : chapterTotal;
    let before = 0;
    for (let i = 0; i < chapterIndex; i++) before += stats.chapterPages[i] || average;
    const bookTotal = Math.max(1, Math.round(known.reduce((a, b) => a + b, 0) + Math.max(0, spineLen - known.length) * average));
    const bookPage = Math.min(bookTotal, Math.max(1, Math.round(before + chapterPage)));
    const mode = App.settings.progressMode || 'bar';
    const status = $('#reader-status');
    const bar = $('#progress-bar');
    status.dataset.mode = mode;
    if (mode === 'page') {
      $('#progress-label').textContent = '全书页码（估算）';
      $('#progress-text').textContent = `第 ${bookPage} / ${bookTotal} 页`;
      bar.style.width = Math.round(bookPage / bookTotal * 100) + '%';
    } else if (mode === 'chapter') {
      $('#progress-label').textContent = `第 ${chapterIndex + 1} 章`;
      $('#progress-text').textContent = `本章 ${chapterPage} / ${chapterTotal} 页`;
      bar.style.width = Math.round(chapterPage / chapterTotal * 100) + '%';
    } else {
      $('#progress-label').textContent = '全书进度';
      $('#progress-text').textContent = Math.round(pct * 100) + '%';
      bar.style.width = Math.round(pct * 100) + '%';
    }
    return pct;
  }

  function bindRenditionEvents(rendition) {
    let highlightsApplied = false;
    rendition.on('relocated', (location) => {
      if (!location || !location.start) return;
      // 恢复持久化的划线（内容渲染完成后应用一次）
      if (!highlightsApplied && App.current && App.current.rec) {
        highlightsApplied = true;
        try {
          const hs = App.current.rec.highlights;
          if (hs && hs.length) {
            hs.forEach((h) => {
              try { rendition.annotations.highlight(h.cfi, {}, () => {}, 'rl-highlight'); } catch (e) { /* 忽略 */ }
            });
          }
        } catch (e) { /* 忽略 */ }
      }
      // iframe 就绪后确保主题/行距注入生效（首次打开或切换章节时）
      try {
        injectThemeCss(rendition, App.settings.theme);
        injectSpacingCss(rendition, App.settings.lineHeight, App.settings.fontSize);
        injectFontCss(rendition, App.settings.font);
      } catch (e) { /* 忽略 */ }
      // 统一更新底部进度：条形 / 全书页码估算 / 本章页码。
      const pct = renderReaderProgress(location);
      // 保存进度（防抖：每翻一页 relocated 都触发，避免大书快速翻页频繁写库 + 全量重绘）
      const rec = App.books.find((b) => b.id === App.current.id);
      if (rec) {
        rec.progressCfi = location.start.cfi;
        rec.progressPct = pct;
        scheduleProgressSave(rec);
      }
    });

    // 选中文本 → 显示自定义菜单（替换系统菜单：复制/划线/单词翻译/句子翻译）
    rendition.on('selected', (cfiRange, contents) => {
      selectionActive = true;
      if (dragExtending) return; // 拖动扩展选区中不弹菜单（touchend 后统一显示）
      try {
        clampSelectionToPage(contents);
        const selText = contents.window.getSelection().toString().trim();
        if (!selText) return;
        const range = contents.window.getSelection().getRangeAt(0);
        selMenuCtx = { contents, range, text: selText };
        showSelMenu(contents, range);
      } catch (e) { console.error('showSelMenu 异常:', e); }
    });
    // 选区被取消（点空白处）→ 关闭浮窗/菜单
    rendition.on('deselected', () => {
      selectionActive = false;
      if (!$('#sel-menu').classList.contains('hidden')) {
        clearSelAfterAction();
      }
      const popup = $('#dict-popup');
      if (!popup.classList.contains('hidden')) {
        closeDictPopup();
      }
    });

    // 键盘翻页（同时绑 rendition 和 document，保证焦点不在 iframe 也能用）
    rendition.on('keydown', (e) => {
      if (e.key === 'ArrowRight') { navigateReader(false, rendition); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { navigateReader(true, rendition); e.preventDefault(); }
    });
  }

  // 点击翻页热区：左 1/3 上一页，右 1/3 下一页，中间显示/隐藏工具栏
  // 注意：epub.js 内容在 iframe 里，外层容器收不到点击，必须用 rendition.on('click')
  function bindPageZones(rendition) {
    rendition.on('click', (e, contents) => {
      if (!App.current || !App.current.rendition) return;
      // 菜单开着时点击外部的 click 已在 touchend 消费（真机 click 延迟到达场景）
      if (tapConsumed) {
        tapConsumed = false;
        return;
      }
      // 菜单刚关闭（600ms 内）的 click：可能是点击关闭菜单的延迟 click，不翻页
      // （deselected 250ms 后关菜单+清选区，click 延迟到达时所有检查都通过，靠时间戳拦截）
      if (Date.now() - menuClosedAt < 600) return;
      // 自定义选区菜单打开时：点击正文任意位置 → 收回菜单（不翻页）
      if (!$('#sel-menu').classList.contains('hidden')) {
        clearSelAfterAction();
        return;
      }
      // 查词浮窗打开时：点击正文任意位置 → 关闭浮窗（不翻页）
      if (!$('#dict-popup').classList.contains('hidden')) {
        closeDictPopup();
        return;
      }
      // 目录打开时不响应翻页
      if (!$('#toc-drawer').classList.contains('hidden')) return;
      // 设置面板打开时：点击正文任意位置 → 关闭面板（遮罩已挡住正文，此为兜底）
      if (!$('#settings-panel').classList.contains('hidden')) {
        closeWithAnim($('#settings-panel'));
        return;
      }
      // 存在选区（用户刚选过词/拖过选区）→ 点击正文 = 关闭选区，不翻页
      try {
        const sel = contents.window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          clearSelAfterAction();
          return;
        }
      } catch (err) { /* 忽略 */ }

      // 选区非空且浮窗仍开着（用户可能想查词/拖选区）时不翻页；
      // 浮窗关闭后恢复翻页（点击正文会先取消选区，不会误触发查词）
      if (selectionActive && !$('#dict-popup').classList.contains('hidden')) {
        try {
          const sel = contents.window.getSelection();
          if (sel && sel.toString().trim()) return;
        } catch (err) { /* 忽略 */ }
      }
      if (readerNavigationBusy) return;

      // 计算点击相对位置
      // 注意：epub.js 分页模式把 iframe 拉伸到所有列宽（如 16800px）再平移显示当前列，
      // e.clientX 是 iframe 内部坐标，必须加上 iframe 的偏移（left 为负）转换到可视坐标
      let x, w;
      try {
        const iframeEl = e.target.ownerDocument.defaultView.frameElement;
        const ifrRect = (iframeEl && typeof iframeEl.getBoundingClientRect === 'function') ? iframeEl.getBoundingClientRect() : null;
        if (ifrRect && ifrRect.width > window.innerWidth) {
          x = e.clientX + ifrRect.left; // 可视坐标
          w = window.innerWidth;
        } else {
          x = e.clientX;
          w = window.innerWidth;
        }
      } catch (err) {
        x = e.clientX;
        w = window.innerWidth;
      }
      if (!w) return;
      const rendition = App.current.rendition;

      // 滚动模式下点击热区禁用翻页。
      const isPaginated = App.settings.flow !== 'scrolled-doc';
      if (x < w * 0.33) {
        if (isPaginated) navigateReader(true, rendition);
      } else if (x > w * 0.67) {
        if (isPaginated) navigateReader(false, rendition);
      } else {
        $('#reader-topbar').classList.toggle('toolbar-hidden');
        $('#reader-status').classList.toggle('toolbar-hidden');
      }
    });
  }

  // 滑动翻页：监听 rendition 转发的 touch 事件（epub.js 默认管理器不做 swipe，需自实现）
  function bindSwipe(rendition) {
    let startX = null, startY = null, startT = 0, hadSelection = false;

    rendition.on('touchstart', (e, contents) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      startT = Date.now();
      // 触摸开始时若有选区（拖动选择手柄扩展选区），整个手势都视为选区操作
      hadSelection = false;
      try {
        const sel = contents.window.getSelection();
        hadSelection = !!(sel && !sel.isCollapsed && sel.toString().trim());
      } catch (err) { /* 忽略 */ }
    });

    rendition.on('touchend', (e, contents) => {
      if (startX === null) return;
      const ct = e.changedTouches && e.changedTouches[0];
      const dx = ct.clientX - startX;
      const dy = ct.clientY - startY;
      const dt = Date.now() - startT;
      startX = startY = null;

      // 仅在分页模式下滑动翻页（滚动模式下滑动应滚动正文）
      if (App.settings.flow === 'scrolled-doc' || readerNavigationBusy) return;
      // 自定义菜单打开时滑动 = 翻页意图：先收回菜单再翻页（选区已无拖动手柄，不会误触）
      const menuWasOpen = !$('#sel-menu').classList.contains('hidden');
      if (menuWasOpen) {
        clearSelAfterAction();
      }
      // 浮窗/目录/设置打开时不响应
      if (!$('#dict-popup').classList.contains('hidden')) return;
      if (!$('#toc-drawer').classList.contains('hidden')) return;
      if (!$('#settings-panel').classList.contains('hidden')) return;
      // 触摸开始时有选区（拖动选择手柄）→ 不翻页（菜单刚收回的场景跳过）
      if (hadSelection && !menuWasOpen) return;
      // 全局选区状态（selected 事件曾触发）→ 不翻页
      if (selectionActive && !menuWasOpen) return;
      // 长按选词（>600ms）不触发
      if (dt > 600) return;
      // 水平位移 > 60px 且明显大于垂直位移（排除上下滚动意图）
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      // 当前有选区（用户可能想查词）不翻页
      try {
        const sel = contents.window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim() && !menuWasOpen) return;
      } catch (err) { /* 忽略 */ }

      if (dx < 0) { navigateReader(false, rendition); }
      else { navigateReader(true, rendition); }
    });
  }

  /* ---------------- 点词查词 ---------------- */
  // 关闭查词浮窗并清除选区：查词结束 = 恢复翻页交互
  // （浮窗开着时选区保留可拖动扩展；关闭后必须清选区，否则选区/标志会拦截翻页）
  function closeDictPopup() {
    closeWithAnim($('#dict-popup'));
    selectionActive = false;
    try {
      if (App.current && App.current.rendition) {
        App.current.rendition.getContents().forEach((c) => {
          const sel = c.window.getSelection();
          if (sel && !sel.isCollapsed) sel.removeAllRanges();
        });
      }
    } catch (e) { /* 忽略 */ }
  }

  // 退出阅读器时清理阅读器 UI 残留（查词浮窗/选区菜单/选区状态）：
  // 这些是主文档元素，destroy book 不会自动关闭——不清理会导致退出再进时
  // 浮窗仍停在原位置（真机反馈 bug）
  function cleanupReaderUI() {
    try {
      readerNavigationBusy = false;
      const popup = $('#dict-popup');
      if (!popup.classList.contains('hidden')) {
        popup.classList.add('hidden');
        popup.classList.remove('closing');
      }
      const menu = $('#sel-menu');
      if (!menu.classList.contains('hidden')) menu.classList.add('hidden');
      // 目录抽屉/遮罩也一并清理（防异常路径残留，再进书直接显示）
      const toc = $('#toc-drawer');
      if (!toc.classList.contains('hidden')) {
        toc.classList.add('hidden');
        toc.classList.remove('closing');
      }
      const dmask = $('#drawer-mask');
      if (!dmask.classList.contains('hidden')) {
        dmask.classList.add('hidden');
        dmask.classList.remove('closing');
      }
      selectionActive = false;
      selMenuCtx = null;
      dictMode = 'word';
      $('#reader-topbar').classList.remove('toolbar-hidden');
      $('#reader-status').classList.remove('toolbar-hidden');
    } catch (e) { /* 忽略 */ }
  }

  // 弹窗定位：贴近选区显示（上方优先），无选区时不移动（避免点击空白时弹窗跳动）
  // 系统菜单浮在选区上方 6~64px，弹窗放其上方（更贴近选区且不遮选区）
  function positionDictPopup(contents) {
    const popup = $('#dict-popup');
    if (popup.classList.contains('hidden')) return;
    let selRect = null;
    try {
      const sel = contents && contents.window ? contents.window.getSelection() : null;
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect && typeof rect.top === 'number' && typeof rect.bottom === 'number') {
          // Range 的 getBoundingClientRect 是 iframe 内部坐标系，弹窗定位在主文档，
          // 必须加上 iframe 元素相对主文档的垂直偏移（顶栏高度），否则弹窗整体偏高 ~顶栏高度、
          // 靠近底部时还会溢出视口（showSelMenu 的菜单定位已加 ifrRect.top，这里保持一致）
          let iframeTop = 0;
          try {
            const fe = contents.document.defaultView.frameElement;
            if (fe && typeof fe.getBoundingClientRect === 'function') iframeTop = fe.getBoundingClientRect().top || 0;
          } catch (e2) { /* 忽略 */ }
          selRect = { top: rect.top + iframeTop, bottom: rect.bottom + iframeTop };
        }
      }
    } catch (e) { /* 忽略 */ }
    if (!selRect) return; // 无选区：保持当前位置，不重置

    const vh = window.innerHeight;
    const ph = popup.offsetHeight || 260;
    const selBottom = selRect.bottom;

    // 优先：弹窗紧贴选区上方（系统菜单已禁用，无需预留空间）
    const tUp = selRect.top - 8 - ph / 2;
    if (tUp - ph / 2 >= 10) {
      popup.style.top = Math.round(tUp) + 'px';
      return;
    }
    // 其次：弹窗紧贴选区下方
    const tDown = selBottom + 8 + ph / 2;
    if (tDown + ph / 2 <= vh - 14) {
      popup.style.top = Math.round(tDown) + 'px';
      return;
    }
    // 都放不下（弹窗过高）→ 保持当前位置
  }

  // 把选区钳制在当前页范围内：拖动选择手柄到页边缘时，
  // 不允许选区越过当前页末尾进入下一页内容
  function clampSelectionToPage(contents) {
    if (!App.current || !App.current.rendition) return;
    const loc = App.current.rendition.currentLocation();
    if (!loc || !loc.end || !loc.end.cfi) return;

    const sel = contents.window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const selRange = sel.getRangeAt(0);

    try {
      const CFICls = window.ePub && window.ePub.CFI;
      if (!CFICls) return;
      // 当前页末尾 CFI → DOM Range
      const endRange = new CFICls(loc.end.cfi).toRange(contents.document);
      if (!endRange || !endRange.startContainer) return;

      // 选区终点是否越过页末尾
      const cmp = selRange.compareBoundaryPoints(Range.END_TO_END, endRange);
      if (cmp > 0) {
        // 收缩选区终点到页末尾（必须用 iframe 自己的 document 建 range）
        const newRange = contents.document.createRange();
        newRange.setStart(selRange.startContainer, selRange.startOffset);
        newRange.setEnd(endRange.startContainer, endRange.startOffset);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    } catch (e) { /* 忽略（CFI 解析失败等） */ }
  }

  // 实时禁止选区跨页：在 iframe 文档上直接监听 selectionchange，
  // 拖动选择手柄的过程中，选区一越过页边界立即被拉回（不等 250ms 防抖）
  // 在 relocated（翻页/章节切换后 iframe 重建）时重新绑定
  function bindSelectionClamp(rendition) {
    rendition.on('relocated', () => {
      try {
        rendition.getContents().forEach((contents) => {
          if (!contents || !contents.document || contents._clampBound) return;
          contents._clampBound = true;
          contents.document.addEventListener('selectionchange', () => {
            try { clampSelectionToPage(contents); } catch (e) { /* 忽略 */ }
            // 选区移动时系统菜单跟随，弹窗同步避让
            try { positionDictPopup(contents); } catch (e) { /* 忽略 */ }
          }, { passive: true });
        });
      } catch (e) { /* 忽略 */ }
    });
  }

  /* ---------------- 自定义选区菜单（替换系统菜单） ---------------- */
  // 长按检测 + 程序化选词（程序化选区不触发系统 ActionMode 菜单）
  // 菜单项：复制 / 划线 / 单词翻译 / 句子翻译
  let selMenuCtx = null; // { contents, range, text }
  let dragExtending = false; // 拖动扩展选区中（抑制 selected 事件弹菜单）
  let tapConsumed = false; // 菜单开着时点击外部已被 touchend 消费（防延迟 click 误翻页）
  let menuClosedAt = 0; // 菜单最近关闭时间（click 延迟到达时 deselected 已关菜单，靠它拦截）

  // 程序化选中触摸点所在"词"（英文单词 / 中文连续字串），返回锚点 {node, offset} 或 null
  function selectWordAt(contents, doc, x, y) {
    const range = doc.caretRangeFromPoint(x, y);
    if (!range || !range.startContainer) return null;
    const node = range.startContainer;
    if (node.nodeType !== 3) return null; // 必须是文本节点
    const text = node.textContent;
    const pos = range.startOffset;
    const re = /[A-Za-z][A-Za-z'’-]*|[\u4e00-\u9fff]+/g;
    let m, best = null;
    while ((m = re.exec(text))) {
      if (pos >= m.index && pos <= m.index + m[0].length) { best = m; break; }
      if (m.index > pos) break;
    }
    if (!best) return null;
    const sel = contents.window.getSelection();
    sel.removeAllRanges();
    const r = doc.createRange();
    r.setStart(node, best.index);
    r.setEnd(node, best.index + best[0].length);
    sel.addRange(r);
    return { node, offset: best.index };
  }

  // 整词扩展：选区边界落在单词/中文串中间时，自动扩展到完整词
  // 划线/取消划线前调用，保证按整词处理
  function expandSelectionToWords(contents) {
    try {
      const sel = contents.window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
      const range = sel.getRangeAt(0);
      const doc = contents.document;
      let startNode = range.startContainer, startOffset = range.startOffset;
      let endNode = range.endContainer, endOffset = range.endOffset;
      let changed = false;

      const isWordChar = (ch) => !!ch && /[A-Za-z'’-]/.test(ch);
      const isCjk = (ch) => !!ch && /[\u4e00-\u9fff]/.test(ch);

      // 起点：若起点在词中间（前一个字符是词字符/汉字且当前位置也是），向前扩到词首
      if (startNode.nodeType === 3) {
        const t = startNode.textContent;
        const cur = t[startOffset];
        const prev = t[startOffset - 1];
        if (isWordChar(cur) && isWordChar(prev)) {
          const m = t.slice(0, startOffset).match(/[A-Za-z'’-]*$/);
          if (m) { startOffset -= m[0].length; changed = true; }
        } else if (isCjk(cur) && isCjk(prev)) {
          const m = t.slice(0, startOffset).match(/[\u4e00-\u9fff]*$/);
          if (m) { startOffset -= m[0].length; changed = true; }
        }
      }
      // 终点：若终点在词中间（前一个字符是词字符/汉字且当前位置也是），向后扩到词尾
      if (endNode.nodeType === 3) {
        const t = endNode.textContent;
        const cur = t[endOffset - 1];
        const next = t[endOffset];
        if (isWordChar(cur) && isWordChar(next)) {
          const m = t.slice(endOffset).match(/^[A-Za-z'’-]*/);
          if (m) { endOffset += m[0].length; changed = true; }
        } else if (isCjk(cur) && isCjk(next)) {
          const m = t.slice(endOffset).match(/^[\u4e00-\u9fff]*/);
          if (m) { endOffset += m[0].length; changed = true; }
        }
      }

      if (!changed) return false;
      const nr = doc.createRange();
      nr.setStart(startNode, startOffset);
      nr.setEnd(endNode, endOffset);
      sel.removeAllRanges();
      sel.addRange(nr);
      return true;
    } catch (e) { return false; }
  }

  // 自定义长按选词：Android 层 setOnLongClickListener 已禁用系统选词，
  // 这里在 iframe 内监听触摸：长按 400ms 选中触摸点所在"词"，之后继续拖动可扩展选区。
  // 程序化选区不触发系统 ActionMode 菜单，且会触发 selectionchange → selected → 自定义菜单
  function bindCustomSelection(rendition) {
    rendition.on('relocated', () => {
      try {
        rendition.getContents().forEach((contents) => {
          if (!contents || !contents.document || contents._selBound) return;
          contents._selBound = true;
          const doc = contents.document;
          let lx = 0, ly = 0, lt = 0, longPress = false, extending = false;
          let anchorNode = null, anchorOffset = 0;

          doc.addEventListener('touchstart', (e) => {
            const t = e.touches && e.touches[0];
            if (!t) return;
            lx = t.clientX; ly = t.clientY; lt = Date.now();
            longPress = true; extending = false;
            dragExtending = false;
          }, { passive: true });

          doc.addEventListener('touchmove', (e) => {
            const t = e.touches && e.touches[0];
            if (!t) return;
            // 扩展模式：拖动中实时扩展选区（锚点 → 当前位置）
            if (extending) {
              try {
                const r = doc.caretRangeFromPoint(t.clientX, t.clientY);
                if (r && r.startContainer) {
                  const sel = contents.window.getSelection();
                  const nr = doc.createRange();
                  nr.setStart(anchorNode, anchorOffset);
                  nr.setEnd(r.startContainer, r.startOffset);
                  sel.removeAllRanges();
                  sel.addRange(nr);
                }
              } catch (err) { /* 忽略 */ }
              return;
            }
            if (!longPress) return;
            // 位移超过阈值：长按已达成则先选词并进入扩展模式，否则视为滑动取消长按
            if (Math.abs(t.clientX - lx) > 12 || Math.abs(t.clientY - ly) > 12) {
              if (Date.now() - lt > 400) {
                // 长按已达成 → 先用起点坐标选中词，再进入扩展模式
                const w = selectWordAt(contents, doc, lx, ly);
                if (w) {
                  anchorNode = w.node;
                  anchorOffset = w.offset;
                  extending = true;
                  dragExtending = true;
                  hideSelMenu(); // 拖动中不显示菜单，touchend 再显示
                } else {
                  longPress = false; // 起点不是文本节点，放弃
                }
              } else {
                longPress = false;
              }
            }
          }, { passive: true });

          doc.addEventListener('touchend', (e) => {
            // 菜单开着 + 本次是点击（短按无位移）→ 收回菜单并消费后续 click（防止真机 click 延迟到达导致误翻页）
            if (!longPress && !extending && !$('#sel-menu').classList.contains('hidden')) {
              try {
                const ct = e.changedTouches && e.changedTouches[0];
                if (ct && Math.abs(ct.clientX - lx) < 12 && Math.abs(ct.clientY - ly) < 12) {
                  clearSelAfterAction();
                  tapConsumed = true;
                  setTimeout(() => { tapConsumed = false; }, 500);
                  return;
                }
              } catch (err) { /* 忽略 */ }
            }
            const wasExtending = extending;
            extending = false;
            dragExtending = false;
            // 扩展结束：有选区则显示菜单
            if (wasExtending) {
              try {
                const sel = contents.window.getSelection();
                if (!sel.isCollapsed && sel.rangeCount > 0) {
                  const r = sel.getRangeAt(0);
                  const text = sel.toString().trim();
                  if (text) {
                    selMenuCtx = { contents, range: r, text };
                    showSelMenu(contents, r);
                  }
                }
              } catch (err) { /* 忽略 */ }
              return;
            }
            if (!longPress) return;
            const dt = Date.now() - lt;
            if (dt < 400) return; // 不足 400ms 不算长按
            const w = selectWordAt(contents, doc, lx, ly);
            if (!w) return;
            anchorNode = w.node;
            anchorOffset = w.offset;
            // 选中词后显示菜单（用户也可继续拖动扩展）
            try {
              const sel = contents.window.getSelection();
              const r = sel.getRangeAt(0);
              const text = sel.toString().trim();
              selMenuCtx = { contents, range: r, text };
              showSelMenu(contents, r);
            } catch (err) { /* 忽略 */ }
          }, { passive: true });
        });
      } catch (e) { /* 忽略 */ }
    });
  }

  // 显示自定义菜单：位置和箭头精准跟随选区
  // 单行选区 → 箭头指向选区中心；多行选区 → 箭头指向最上行选区中心；
  // 选区太靠上 → 菜单放选区下方，箭头自动翻转朝上
  function showSelMenu(contents, range) {
    const menu = $('#sel-menu');
    // 动态判断：选中内容是否已划线 → 按钮显示"取消划线"
    const selText = (function () {
      try { return contents.window.getSelection().toString().trim(); } catch (e) { return ''; }
    })();
    const hlBtn = menu.querySelector('[data-act="underline"]');
    if (hlBtn) {
      const rec = App.current && App.books.find((b) => b.id === App.current.id);
      // 部分重叠即视为已划线（选中划线区域的一部分 → 显示"取消划线"）
      const hasHL = !!(rec && rec.highlights && selText &&
        rec.highlights.some((h) => h.text.includes(selText) || selText.includes(h.text)));
      hlBtn.textContent = hasHL ? '取消划线' : '划线';
    }

    // 选区每行矩形（按文档顺序，第一行 = 视觉最上行）
    let rects = [];
    try {
      rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    } catch (e) { /* 忽略 */ }
    if (!rects.length) {
      try {
        const br = range.getBoundingClientRect();
        if (br && br.width > 0) rects = [br];
      } catch (e) { /* 忽略 */ }
    }
    if (!rects.length) return;

    // iframe 元素：frameElement 才是 DOM 元素（contents.viewport 可能是内部对象）
    let iframeEl = null;
    try {
      iframeEl = contents.document.defaultView.frameElement;
    } catch (e) { /* 忽略 */ }
    if (!iframeEl || typeof iframeEl.getBoundingClientRect !== 'function') return;
    const ifrRect = iframeEl.getBoundingClientRect();

    // 先显示以测量实际宽度（hidden 时 offsetWidth=0）
    menu.classList.remove('hidden');
    const menuW = menu.offsetWidth || 300;
    const menuH = 42, arrowH = 6;
    const topRect = rects[0]; // 最上行选区
    // 箭头目标点：最上行选区矩形水平中心
    const targetX = ifrRect.left + topRect.left + topRect.width / 2;
    const targetY = ifrRect.top + topRect.top;

    // 默认菜单在选区上方（箭头朝下）；太靠上则放下方（箭头朝上）
    let top = targetY - menuH - arrowH - 10;
    let below = false;
    if (top < 8) {
      top = ifrRect.top + topRect.bottom + arrowH + 10;
      below = true;
    }
    // 菜单左边缘：以 targetX 为中心（箭头对准），整体不出屏
    const left = Math.max(8, Math.min(targetX - menuW / 2, window.innerWidth - menuW - 8));

    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.classList.toggle('below', below);
    // 箭头水平偏移：对准目标点（菜单被 clamp 时箭头不居中）
    const arrow = menu.querySelector('.sel-menu-arrow');
    if (arrow) {
      arrow.style.left = Math.round(targetX - left) + 'px';
    }
  }

  function hideSelMenu() {
    const menu = $('#sel-menu');
    menu.classList.add('hidden');
    // 保留选区但清空上下文？菜单操作后由调用方决定
  }

  // 选区菜单动作
  async function actCopy() {
    if (!selMenuCtx) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(selMenuCtx.text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = selMenuCtx.text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('已复制');
    } catch (e) { toast('复制失败'); }
    clearSelAfterAction();
  }

  function actUnderline() {
    if (!selMenuCtx || !App.current || !App.current.rendition) return;
    const contents = selMenuCtx.contents;
    const rec = App.books.find((b) => b.id === App.current.id);
    try {
      // 划线/取消前：选区边界在半词时自动扩展为整词（按整词处理）
      expandSelectionToWords(contents);
      const sel = contents.window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const text = sel.toString().trim();
      if (!text) return;
      const cfiRange = contents.cfiFromRange(range);

      // 与任何划线部分重叠 → 取消（移除所有重叠的划线，不做"加深"）
      const overlapping = (rec && rec.highlights)
        ? rec.highlights.filter((h) => h.text.includes(text) || text.includes(h.text))
        : [];
      if (overlapping.length) {
        overlapping.forEach((h) => {
          try { App.current.rendition.annotations.remove(h.cfi, 'highlight'); } catch (e) { /* 忽略 */ }
        });
        if (rec) {
          rec.highlights = rec.highlights.filter(
            (h) => !(h.text.includes(text) || text.includes(h.text)));
          idbPut('books', rec);
        }
        toast('已取消划线');
      } else {
        // 划线
        App.current.rendition.annotations.highlight(cfiRange, {}, () => {}, 'rl-highlight');
        if (rec) {
          rec.highlights = rec.highlights || [];
          rec.highlights.push({ cfi: cfiRange, text, time: Date.now() });
          idbPut('books', rec);
        }
        toast('已划线');
      }
    } catch (e) { toast('划线操作失败'); }
    clearSelAfterAction();
  }

  function actWord() {
    if (!selMenuCtx) return;
    const m = selMenuCtx.text.match(/[A-Za-z][A-Za-z'’-]*/);
    const contents = selMenuCtx.contents; // 先保存（下面置 null）
    // 只隐藏菜单，不清选区：清除选区会触发 deselected 把刚弹出的浮窗关掉
    hideSelMenu();
    selMenuCtx = null;
    if (m) {
      showDictPopup(m[0].toLowerCase(), contents);
    } else {
      toast('选中内容不含英文单词');
    }
  }

  async function actSentence() {
    if (!selMenuCtx) return;
    const ctx = selMenuCtx;
    // 直接翻译用户手动选中的区域（不扩展成整句）
    dictContents = ctx.contents; // 记录 contents：弹窗定位需用当前选区的 iframe（首次句子翻译也贴选区）
    const sentence = ctx.text.trim();
    if (!sentence) return;
    // 只隐藏菜单，不清选区：清除选区会触发 deselected 把刚弹出的浮窗关掉
    hideSelMenu();
    selMenuCtx = null;
    // 调有道翻译（走本地代理）——翻译模式：头部只保留关闭按钮
    dictMode = 'translate';
    const popup = $('#dict-popup');
    if (popup.classList.contains('hidden')) {
      openWithAnim(popup);
    }
    positionDictPopup(dictContents); // 紧贴选区定位
    $('#dict-word').textContent = '📖 句子翻译';
    $('#dict-phonetic').textContent = '';
    $('#dict-body').innerHTML = '<div class="dict-loading">翻译中…</div>';
    $('#dict-save').style.display = 'none';
    $('#dict-speak').style.display = 'none';
    try {
      const resp = await fetch('/api/translate?text=' + encodeURIComponent(sentence));
      const data = await resp.json();
      const tgt = data && data.translation && data.translation[0];
      if (tgt) {
        $('#dict-body').innerHTML = '<div class="def-block"><span class="def-pos">译文</span><div class="def-item">' + esc(tgt) + '</div></div>' +
          '<div class="def-example">' + esc(sentence) + '</div>';
      } else {
        $('#dict-body').innerHTML = '<div class="dict-error">翻译失败（服务不可用）。</div>';
      }
    } catch (e) {
      $('#dict-body').innerHTML = '<div class="dict-error">翻译失败（网络不可用）。</div>';
    }
  }

  // 菜单动作完成后：隐藏菜单 + 清除选区
  function clearSelAfterAction() {
    hideSelMenu();
    menuClosedAt = Date.now(); // 记录关闭时间（拦截延迟到达的 click）
    try {
      if (selMenuCtx && selMenuCtx.contents) {
        const sel = selMenuCtx.contents.window.getSelection();
        if (sel) sel.removeAllRanges();
      }
    } catch (e) { /* 忽略 */ }
    selectionActive = false;
    selMenuCtx = null;
  }

  // 绑定菜单按钮 + 点击外部关闭
  function bindSelMenuEvents() {
    $$('#sel-menu .sel-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'copy') actCopy();
        else if (act === 'underline') actUnderline();
        else if (act === 'word') actWord();
        else if (act === 'sentence') actSentence();
      });
    });
    document.addEventListener('click', (e) => {
      const menu = $('#sel-menu');
      if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
        clearSelAfterAction();
      }
    });
  }

  // 书架主题弹窗：同步当前主题高亮 + 按钮图标
  function syncThemePopupUI() {
    const t = App.settings.theme;
    $$('#seg-theme-lib .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === t);
    });
    const icons = { light: '☀', sepia: '📜', dark: '🌙' };
    $('#btn-theme-lib').textContent = (icons[t] || '🌙') + ' 主题';
  }

  // 全局选区状态：selected 置 true / deselected 置 false
  // 翻页手势（click/swipe）检查它，防止拖动选择手柄时误翻页
  let selectionActive = false;
  // 防抖：长按/拖动选区过程中不立即弹窗，停止变化 250ms 后才查词
  let selDebounce = null;
  function handleSelection(rawText, contents) {
    clearTimeout(selDebounce);
    selDebounce = setTimeout(() => {
      // 只取第一个词
      const m = rawText.match(/[A-Za-z][A-Za-z'’-]*/);
      if (!m) return;
      const word = m[0].toLowerCase();
      showDictPopup(word, contents);
      // 注意：不清除选区——保留选择手柄，用户可继续拖动扩展为整句
    }, 250);
  }

  let dictAbort = null;
  let dictContents = null; // 当前查词的 iframe contents（用于弹窗定位避让系统菜单）
  let dictMode = 'word'; // 'word'=单词查词（显示音标/收藏/朗读） | 'translate'=句子翻译（仅译文）
  async function showDictPopup(word, contents) {
    const popup = $('#dict-popup');
    if (contents) dictContents = contents;
    dictMode = 'word';
    // 恢复单词模式下的头部元素
    $('#dict-save').style.display = '';
    $('#dict-speak').style.display = '';
    const alreadyOpen = !popup.classList.contains('hidden');
    // 同一个词且浮窗已开：不重复请求（拖动扩展选区时首词未变）
    if (alreadyOpen && $('#dict-word').textContent === word && !$('#dict-body').querySelector('.dict-loading')) {
      return;
    }
    if (!alreadyOpen) {
      openWithAnim(popup); // 首次弹出才播动画
    }
    // 打开后立即定位（避开系统菜单）
    positionDictPopup(dictContents);
    $('#dict-word').textContent = word;
    $('#dict-phonetic').textContent = '';
    $('#dict-body').innerHTML = '<div class="dict-loading">查词中…</div>';
    $('#dict-save').textContent = '☆ 收藏';
    $('#dict-save').classList.remove('saved');

    // 已在生词本？
    const existed = await idbGet('vocab', word);
    if (existed) {
      $('#dict-save').textContent = '★ 已收藏';
      $('#dict-save').classList.add('saved');
      $('#dict-save').onclick = () => toast('已在生词本中');
    } else {
      $('#dict-save').textContent = '☆ 收藏';
      $('#dict-save').classList.remove('saved');
      $('#dict-save').onclick = null; // 等释义加载后再绑定
    }

    if (dictAbort) dictAbort.abort();
    dictAbort = new AbortController();

    // 双词典源容错：
    // 1) 本地代理 /api/dict（Android 壳内置，绕过 CORS 直连有道，返回中文释义）
    // 2) dictionaryapi.dev（Web 版无代理时兜底，英文释义）
    try {
      const proxied = await fetch(`/api/dict?q=${encodeURIComponent(word)}`, {
        signal: dictAbort.signal,
      });
      if (proxied.ok) {
        const data = await proxied.json();
        if (data.ec && data.ec.word && data.ec.word.length) {
          renderYoudaoResult(data.ec.word[0], data);
          return;
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      // 代理不可用（Web 版无代理），继续尝试兜底源
    }

    try {
      const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
        signal: dictAbort.signal,
      });
      if (!resp.ok) throw new Error('not found');
      const data = await resp.json();
      renderDictResult(data[0]);
    } catch (e) {
      if (e.name === 'AbortError') return;
      $('#dict-body').innerHTML =
        '<div class="dict-error">未找到释义（词库未收录或网络不可用）。</div>' +
        '<div class="def-example">可点击「☆ 收藏」手动记录这个词。</div>';
      positionDictPopup(dictContents); // 失败分支也重新定位
      // 查不到也能手动收藏
      const existed2 = await idbGet('vocab', word);
      if (!existed2) {
        $('#dict-save').textContent = '☆ 收藏';
        $('#dict-save').classList.remove('saved');
        $('#dict-save').onclick = () => saveVocabWord(null);
      }
    }
  }

  /* ---- 有道结果渲染（中文释义） ---- */
  function renderYoudaoResult(w, full) {
    const body = $('#dict-body');
    const word = $('#dict-word').textContent;

    // 音标：英式优先，无则美式
    const phonetic = w.ukphone || w.usphone || '';
    $('#dict-phonetic').textContent = phonetic ? '/' + phonetic + '/' : '';

    // 发音按钮：有道 dictvoice
    const speakBtn = $('#dict-speak');
    speakBtn.style.display = '';
    speakBtn.onclick = null;
    const audioPart = w.ukspeech || w.usspeech;
    if (audioPart) {
      // 发音走本地代理 /api/voice（同源绕开 ORB）；audioPart 形如 "world&type=1"
      const type = String(audioPart).includes('type=2') ? '2' : '1';
      speakBtn.onclick = () => {
        speakWord(word);
      };
    } else {
      speakBtn.style.display = 'none';
    }

    // 释义：trs[].tr[].l.i[] 形如 "n. 鲸；<非正式>巨大的东西"
    const trs = (w.trs || []).slice(0, 5);
    let html = '';
    for (const tr of trs) {
      const items = (tr.tr || []).flatMap((t) => (t.l && t.l.i ? t.l.i : []));
      for (const it of items) {
        const m = String(it).match(/^([a-zA-Z]+)\.\s*(.*)$/);
        if (m) {
          html += `<div class="def-block"><span class="def-pos">${esc(m[1])}</span><div class="def-item">${esc(m[2])}</div></div>`;
        } else {
          html += `<div class="def-item">${esc(it)}</div>`;
        }
      }
    }
    // 词形变化
    const wfs = (w.wfs || []).slice(0, 4);
    if (wfs.length) {
      html += '<div class="def-block"><span class="def-pos">变形</span>' +
        wfs.map((x) => `<span class="def-item" style="display:inline;margin-right:10px;font-size:13px;color:var(--text-dim)">${esc(x.wf.name)}: ${esc(x.wf.value)}</span>`).join('') +
        '</div>';
    }
    if (!html) html = '<div class="dict-error">未找到释义。</div>';
    body.innerHTML = html;
    positionDictPopup(dictContents); // 内容渲染后重新定位（避开系统菜单）

    // 收藏按钮
    const existed = App.vocab.find((v) => v.word === word);
    const saveBtn = $('#dict-save');
    if (existed) {
      saveBtn.textContent = '★ 已收藏';
      saveBtn.classList.add('saved');
      saveBtn.onclick = () => { toast('已在生词本中'); };
    } else {
      saveBtn.textContent = '☆ 收藏';
      saveBtn.classList.remove('saved');
      saveBtn.onclick = () => saveVocabWordYoudao(w);
    }
  }

  async function saveVocabWordYoudao(w) {
    const word = $('#dict-word').textContent;
    const phonetic = $('#dict-phonetic').textContent;
    // 提取第一条中文释义摘要
    let summary = '';
    if (w.trs && w.trs[0] && w.trs[0].tr && w.trs[0].tr[0]) {
      const i = w.trs[0].tr[0].l && w.trs[0].tr[0].l.i;
      if (i && i[0]) summary = String(i[0]).replace(/^[a-zA-Z]+\.\s*/, '');
    }
    const rec = {
      word,
      phonetic,
      summary,
      time: Date.now(),
      bookTitle: App.current ? App.current.rec.title : '',
    };
    try {
      await idbPut('vocab', rec);
      App.vocab = await idbAll('vocab');
      $('#dict-save').textContent = '★ 已收藏';
      $('#dict-save').classList.add('saved');
      $('#dict-save').onclick = () => toast('已在生词本中');
      $('#vocab-count').textContent = App.vocab.length;
      toast(`已收藏「${word}」`);
    } catch (e) {
      toast('收藏失败');
    }
  }

  function renderDictResult(entry) {
    const body = $('#dict-body');
    // 音标
    let phonetic = entry.phonetic || '';
    if (!phonetic && entry.phonetics) {
      const p = entry.phonetics.find((x) => x.text);
      phonetic = p ? p.text : '';
    }
    $('#dict-phonetic').textContent = phonetic || '';

    // 发音按钮
    const speakBtn = $('#dict-speak');
    speakBtn.style.display = '';
    speakBtn.onclick = null;
    if (entry.phonetics) {
      const audio = entry.phonetics.find((x) => x.audio);
      if (audio) {
        speakBtn.onclick = () => {
          const a = new Audio(audio.audio);
          a.play();
        };
      } else {
        speakBtn.style.display = 'none';
      }
    } else {
      speakBtn.style.display = 'none';
    }

    // 释义（最多 3 个词性，每个最多 2 条释义）
    const meanings = (entry.meanings || []).slice(0, 3);
    let html = '';
    for (const m of meanings) {
      html += `<div class="def-block"><span class="def-pos">${esc(m.partOfSpeech)}</span>`;
      const defs = (m.definitions || []).slice(0, 2);
      for (const d of defs) {
        html += `<div class="def-item">${esc(d.definition || '')}</div>`;
        if (d.example) html += `<div class="def-example">“${esc(d.example)}”</div>`;
      }
      html += '</div>';
    }
    if (!html) html = '<div class="dict-error">未找到释义。</div>';
    body.innerHTML = html;
    positionDictPopup(dictContents); // 内容渲染后重新定位（避开系统菜单）

    // 收藏按钮
    const word = $('#dict-word').textContent;
    const existed = App.vocab.find((v) => v.word === word);
    const saveBtn = $('#dict-save');
    if (existed) {
      saveBtn.textContent = '★ 已收藏';
      saveBtn.classList.add('saved');
      saveBtn.onclick = () => { toast('已在生词本中'); };
    } else {
      saveBtn.textContent = '☆ 收藏';
      saveBtn.classList.remove('saved');
      saveBtn.onclick = () => saveVocabWord(entry);
    }
  }

  async function saveVocabWord(entry) {
    const word = $('#dict-word').textContent;
    const phonetic = $('#dict-phonetic').textContent;
    // 提取第一条释义摘要
    let summary = '';
    if (entry && entry.meanings && entry.meanings[0] && entry.meanings[0].definitions[0]) {
      summary = entry.meanings[0].definitions[0].definition;
    }
    const rec = {
      word,
      phonetic,
      summary,
      time: Date.now(),
      bookTitle: App.current ? App.current.rec.title : '',
    };
    try {
      await idbPut('vocab', rec);
      App.vocab = await idbAll('vocab');
      $('#dict-save').textContent = '★ 已收藏';
      $('#dict-save').classList.add('saved');
      $('#dict-save').onclick = () => toast('已在生词本中');
      $('#vocab-count').textContent = App.vocab.length;
      toast(`已收藏「${word}」`);
    } catch (e) {
      toast('收藏失败');
    }
  }

  /* ---------------- 阅读设置 ---------------- */
  // 阅读字体（仅作用于 epub 正文 iframe；文件在 fonts/，400/700 两字重）
  const FONT_FILE = {
    literata: 'literata',
    'source-serif': 'source-serif-4',
    inter: 'inter',
    hyperlegible: 'atkinson-hyperlegible',
  };
  const FONT_FAMILY = {
    literata: "'Literata', Georgia, 'Times New Roman', serif",
    'source-serif': "'Source Serif 4', Georgia, 'Times New Roman', serif",
    inter: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    hyperlegible: "'Atkinson Hyperlegible', Verdana, sans-serif",
    songti: "'Noto Serif CJK SC', 'Songti SC', SimSun, serif",
    kaiti: "'KaiTi', 'Kaiti SC', 'STKaiti', 'Noto Serif CJK SC', serif",
    heiti: "'Noto Sans CJK SC', 'Heiti SC', SimHei, Arial, sans-serif",
  };
  function customFontDataUrl(font) {
    if (font.dataUrl) return font.dataUrl;
    const bytes = new Uint8Array(font.data || new ArrayBuffer(0));
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    font.dataUrl = `data:${font.mime || 'font/woff2'};base64,${btoa(binary)}`;
    return font.dataUrl;
  }
  function buildFontCss(key) {
    const custom = String(key || '').startsWith('custom:') && (App.settings.customFonts || []).find((f) => 'custom:' + f.id === key);
    if (custom) {
      const family = custom.family || ('ReadLingoCustom_' + custom.id);
      return `@font-face{font-family:'${family}';src:url(${customFontDataUrl(custom)}) format('${custom.format || 'woff2'}');font-weight:100 900;font-display:swap;}body{font-family:'${family}'!important;}`;
    }
    const file = FONT_FILE[key];
    const fam = FONT_FAMILY[key] || FONT_FAMILY.literata;
    if (!file) return `body{font-family:${fam}!important;}`;
    const origin = location.origin;
    return `@font-face{font-family:'${file}';src:url(${origin}/fonts/${file}-400.woff2) format('woff2');font-weight:400;font-display:swap;}` +
      `@font-face{font-family:'${file}';src:url(${origin}/fonts/${file}-700.woff2) format('woff2');font-weight:700;font-display:swap;}` +
      `body{font-family:${fam}!important;}`;
  }
  // 字体注入（替换式）
  function injectFontCss(rendition, fontKey) {
    const css = buildFontCss(fontKey);
    rendition.getContents().forEach((c) => {
      try { c.addStylesheetCss(css, 'readlingo-font'); } catch (e) { /* 忽略 */ }
    });
  }

  function fontMime(name) {
    const ext = String(name).toLowerCase().split('.').pop();
    return ext === 'ttf' ? 'font/ttf' : ext === 'otf' ? 'font/otf' : ext === 'woff' ? 'font/woff' : 'font/woff2';
  }
  function fontFormat(name) {
    const ext = String(name).toLowerCase().split('.').pop();
    return ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : ext;
  }
  function renderCustomFontList() {
    const list = $('#custom-font-list');
    if (!list) return;
    list.innerHTML = '';
    (App.settings.customFonts || []).forEach((font) => {
      const row = document.createElement('div');
      row.className = 'custom-font-item';
      row.innerHTML = `<span class="custom-font-name">${esc(font.name)}</span><button class="btn btn-ghost custom-font-use">应用</button><button class="btn btn-ghost custom-font-delete">删除</button>`;
      row.querySelector('.custom-font-use').addEventListener('click', () => setFont('custom:' + font.id));
      row.querySelector('.custom-font-delete').addEventListener('click', async () => {
        App.settings.customFonts = (App.settings.customFonts || []).filter((f) => f.id !== font.id);
        if (App.settings.font === 'custom:' + font.id) App.settings.font = 'literata';
        await idbPut('settings', { key: 'settings', ...App.settings });
        renderCustomFontList(); syncSettingsUI(); applyReaderSettings(); toast(`已删除字体「${font.name}」`);
      });
      list.appendChild(row);
    });
  }
  async function importCustomFonts(files) {
    const list = App.settings.customFonts || (App.settings.customFonts = []);
    let totalBytes = list.reduce((sum, f) => sum + (f.data && f.data.byteLength ? f.data.byteLength : 0), 0);
    let imported = 0;
    let skipped = 0;
    for (const file of files) {
      const data = await readFileAsBuffer(file, MAX_FONT_BYTES);
      if (!data || !data.byteLength || totalBytes + data.byteLength > MAX_FONT_TOTAL_BYTES) {
        skipped++;
        continue;
      }
      const id = uid();
      list.push({ id, name: file.name, family: 'ReadLingoCustom_' + id, mime: fontMime(file.name), format: fontFormat(file.name), data });
      totalBytes += data.byteLength;
      imported++;
    }
    await idbPut('settings', { key: 'settings', ...App.settings });
    renderCustomFontList(); syncSettingsUI();
    if (imported) {
      toast(`已导入 ${imported} 个字体${skipped ? `，跳过 ${skipped} 个超限文件` : ''}`);
    } else if (skipped) {
      toast('字体未导入：单个最大 8 MB，累计最大 32 MB');
    }
  }

  function flowKey() {
    return ['paginated', 'scrolled-doc'].includes(App.settings.flow)
      ? App.settings.flow
      : 'paginated';
  }
  function syncReaderFlowUI() {
    const flow = flowKey();
    const labels = { paginated: '滑动', 'scrolled-doc': '滚动' };
    const badge = $('#reader-mode-badge');
    if (badge) {
      badge.textContent = labels[flow] || labels.paginated;
      badge.title = `当前翻页：${labels[flow] || labels.paginated}`;
    }
    const stage = $('#reader-stage');
    if (stage) stage.dataset.flow = flow;
    const container = $('#reader-container');
    if (container) container.dataset.flow = flow;
  }
  function syncSettingsUI() {
    // 主题高亮
    $$('#seg-theme .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.theme === App.settings.theme);
    });
    // 翻页方式高亮
    $$('#seg-flow .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.flow === flowKey());
    });
    // 字体下拉选择
    const fontSelect = $('#font-select');
    if (fontSelect) {
      const custom = String(App.settings.font || '').startsWith('custom:');
      fontSelect.value = custom || fontSelect.querySelector(`option[value="${App.settings.font}"]`) ? App.settings.font : 'literata';
    }
    // 底部进度显示高亮
    $$('#seg-progress .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.progress === (App.settings.progressMode || 'bar'));
    });
    // 字号
    $('#font-size-val').textContent = App.settings.fontSize;
    const fPct = ((App.settings.fontSize - 13) / (32 - 13)) * 100;
    $('#font-track-fill').style.width = Math.round(fPct) + '%';
    $('#font-minus').disabled = App.settings.fontSize <= 13;
    $('#font-plus').disabled = App.settings.fontSize >= 32;
    // 行距
    $('#line-height-val').textContent = App.settings.lineHeight.toFixed(1);
    const lPct = ((App.settings.lineHeight - 1.4) / (2.4 - 1.4)) * 100;
    $('#lh-track-fill').style.width = Math.round(lPct) + '%';
    $('#lh-minus').disabled = App.settings.lineHeight <= 1.4;
    $('#lh-plus').disabled = App.settings.lineHeight >= 2.4;
  }

  // 把主题同步到整个 UI 外壳（body[data-theme] 驱动 CSS 变量 + 系统状态栏颜色）
  function applyThemeToUI() {
    const t = App.settings.theme;
    document.body.setAttribute('data-theme', t);

    // 状态栏/导航栏颜色（Android WebView 通过 AndroidBridge 同步）
    const barColors = { light: '#f6f4ef', sepia: '#f4ecd8', dark: '#141414' };
    const barColor = barColors[t] || barColors.light;
    // darkText=true → LIGHT_STATUS_BAR（深色文字，用于浅色背景）
    const darkText = (t === 'light' || t === 'sepia');
    if (window.AndroidBridge && typeof window.AndroidBridge.setBarColors === 'function') {
      window.AndroidBridge.setBarColors(barColor, darkText);
    }
    // 书架封面兜底渐变也随主题微调
    $$('.book-cover').forEach((c) => {
      c.style.background = t === 'dark'
        ? 'linear-gradient(135deg, #2d2a45, #1e1e2e)'
        : 'linear-gradient(135deg, #6c5ce7, #a29bfe)';
    });
  }

  // 把主题 CSS 注入 epub iframe（替换式，不累积）
  function injectThemeCss(rendition, theme) {
    const defs = {
      light: { bg: '#ffffff', fg: '#1c1b1a', link: '#6c5ce7' },
      sepia: { bg: '#f4ecd8', fg: '#4a3f2f', link: '#8d6e2f' },
      dark:   { bg: '#141414', fg: '#d4d4d4', link: '#a29bfe' },
    };
    const d = defs[theme] || defs.light;
    const css = `body { background: ${d.bg} !important; color: ${d.fg} !important; } a:link, a:visited { color: ${d.link} !important; } a:not([href]) { color: inherit !important; display: contents !important; }`;
    let applied = false;
    rendition.getContents().forEach((c) => {
      try {
        c.addStylesheetCss(css, 'readlingo-theme'); // 固定 key → 每次替换
        applied = true;
      } catch (e) { /* 忽略 */ }
    });
    return applied;
  }

  // 在 srcdoc HTML 生成阶段直接注入主题 <style>（最早的注入点）
  // epub.js 的 section.render → hooks.serialize.trigger(output, section) 在 iframe 加载前触发。
  // 注意：Hook.trigger 的返回值会被丢弃，必须直接改 section.output 才生效
  async function bindThemeSerialize(book) {
    try {
      await book.loaded.spine; // 等 spine 加载完成（book.spine 此时才可用）
      const hook = book.spine && book.spine.hooks && book.spine.hooks.serialize;
      if (!hook) return;
      hook.register((output, section) => {
        try {
          // epub.js 的 substituteResources（先注册）会把资源 URL 替换成 blob 并写回 section.output。
          // 必须基于替换后的内容注入 style，否则覆盖替换导致 epub 资源 404。
          let base = output;
          if (section && typeof section.output === 'string' && section.output !== output) {
            base = section.output;
          }
          if (typeof base !== 'string') return output;
          const s = App.settings;
          const defs = {
            light: { bg: '#ffffff', fg: '#1c1b1a', link: '#6c5ce7' },
            sepia: { bg: '#f4ecd8', fg: '#4a3f2f', link: '#8d6e2f' },
            dark:   { bg: '#141414', fg: '#d4d4d4', link: '#a29bfe' },
          };
          const d = defs[s.theme] || defs.light;
          // 注意：id 必须与运行时 addStylesheetCss 的 key 一致（epubjs-inserted-css-<key>），
          // 这样运行时替换的是同一个 style 元素，避免双 style 级联冲突（主题切换不同步）
          const themeStyle = `<style id="epubjs-inserted-css-readlingo-theme">` +
            `html,body{background:${d.bg}!important;color:${d.fg}!important;}` +
            // 链接色只作用于真实链接（:link/:visited）；无 href 的 Gutenberg 章节锚点
            // （<a id="CHAPTER_X"> 未闭合，浏览器容错把整章包进 <a>）恢复正文色并拆盒，
            // 否则整章被染成链接色 + inline 包块级产生分页空白（真机实测 CHAPTER IX/X 变紫）
            `a:link,a:visited{color:${d.link}!important;}a:not([href]){color:inherit!important;display:contents!important;}` +
            `</style>`;
          const spacingStyle = `<style id="epubjs-inserted-css-readlingo-spacing">` +
            `body{line-height:${s.lineHeight}!important;font-size:${s.fontSize}px!important;` +
            `text-align:left!important;margin-left:0!important;margin-right:0!important;}` +
            `p{margin-bottom:0.6em!important;}` +
            (s.fontSize <= 13 ? `h1,h2,h3,h4{page-break-before:auto!important;break-before:auto!important;}` : `h1,h2,h3,h4{page-break-before:always!important;break-before:column!important;}`) +
            `</style>`;
          const fontStyle = `<style id="epubjs-inserted-css-readlingo-font">` +
            buildFontCss(s.font) +
            `</style>`;
          let injected = base;
          if (/<\/head>/i.test(injected)) {
            injected = injected.replace(/<\/head>/i, themeStyle + spacingStyle + fontStyle + '</head>');
          } else {
            injected = themeStyle + spacingStyle + fontStyle + injected;
          }
          // 直接改写 section.output（render 链 resolve 的是它）
          if (section && typeof section === 'object') {
            section.output = injected;
          }
          return injected;
        } catch (e) { return output; }
      });
    } catch (e) { /* 忽略 */ }
  }

  // 在 contents 创建时（内容加载完成、显示之前）注入主题/行距
  // 消除翻页时"先白底后主题"的闪烁：epub.js 每次翻页重建 iframe document，
  // 必须用 hooks.content 在 document 就绪的第一时间注入
  function bindThemeInject(rendition) {
    try {
      rendition.hooks.content.register((view) => {
        try {
          const contents = view && view.contents;
          if (!contents || !contents.document) return;
          const s = App.settings;
          contents.addStylesheetCss(
            (() => {
              const defs = {
                light: { bg: '#ffffff', fg: '#1c1b1a', link: '#6c5ce7' },
                sepia: { bg: '#f4ecd8', fg: '#4a3f2f', link: '#8d6e2f' },
                dark:   { bg: '#141414', fg: '#d4d4d4', link: '#a29bfe' },
              };
              const d = defs[s.theme] || defs.light;
              return `body { background: ${d.bg} !important; color: ${d.fg} !important; } a:link, a:visited { color: ${d.link} !important; } a:not([href]) { color: inherit !important; display: contents !important; }`;
            })(),
            'readlingo-theme'
          );
          contents.addStylesheetCss(
            `html,body { min-height:100% !important; } body { line-height: ${s.lineHeight} !important; font-size:${s.fontSize}px !important; min-width:0 !important; overflow-wrap:break-word !important; } p { margin-bottom: 0.6em !important; } ` +
            (s.fontSize <= 13 ? `h1,h2,h3,h4 { page-break-before:auto !important; break-before:auto !important; }` : `h1,h2,h3,h4 { page-break-before: always !important; break-before: column !important; }`),
            'readlingo-spacing'
          );
        } catch (e) { /* 忽略 */ }
      });
    } catch (e) { /* 忽略 */ }
  }

  // 行距/字号/正文对齐注入（替换式，不累积）
  // 覆盖 epub 原样式的 justify 两端对齐（窄列会产生大单词间距）与 10% 边距；
  // 正文左对齐（主流阅读器做法），标题 h1-h6 原样式 center 不受影响
  function injectSpacingCss(rendition, lineHeight, fontSize) {
    const headingRule = fontSize <= 13
      ? 'h1,h2,h3,h4{page-break-before:auto!important;break-before:auto!important;}'
      : 'h1,h2,h3,h4{page-break-before:always!important;break-before:column!important;}';
    const css = `html,body { min-height:100% !important; } body { line-height: ${lineHeight} !important; font-size: ${fontSize}px !important; min-width:0 !important; overflow-wrap:break-word !important; ` +
      `text-align:left !important; margin-left:0 !important; margin-right:0 !important; } p { margin-bottom:0.6em !important; } ${headingRule}`;
    rendition.getContents().forEach((c) => {
      try { c.addStylesheetCss(css, 'readlingo-spacing'); } catch (e) { /* 忽略 */ }
    });
  }

  async function applyReaderSettings() {
    applyThemeToUI();
    syncReaderFlowUI();
    if (!App.current || !App.current.rendition) return;
    const { rendition } = App.current;
    const s = App.settings;

    // 主题：注入式（替换），不依赖 epub.js 的 register/select（会累积旧规则导致切换失效）
    injectThemeCss(rendition, s.theme);

    // 字号 / 行距 / 对齐（替换式注入；themes.fontSize 是 insertRule 累积式，弃用）
    injectSpacingCss(rendition, s.lineHeight, s.fontSize);

    // 阅读字体（仅正文 iframe）
    injectFontCss(rendition, s.font);
  }

  async function setTheme(theme) {
    App.settings.theme = theme;
    await idbPut('settings', { key: 'settings', ...App.settings });
    applyReaderSettings();
    syncSettingsUI();
  }

  async function refreshReaderLayout() {
    if (!App.current || !App.current.rendition) return;
    const rendition = App.current.rendition;
    try {
      const box = $('#reader-container').getBoundingClientRect();
      // 只触发布局重算，不重新 display CFI，避免字号连续调整时 iframe 被反复销毁。
      if (typeof rendition.resize === 'function') rendition.resize(Math.round(box.width), Math.round(box.height));
    } catch (e) { /* 下一次 relocated 会自然重排 */ }
  }

  async function changeFontSize(delta) {
    App.settings.fontSize = Math.min(32, Math.max(13, App.settings.fontSize + delta));
    await idbPut('settings', { key: 'settings', ...App.settings });
    applyReaderSettings();
    await refreshReaderLayout();
    syncSettingsUI();
  }

  async function changeLineHeight(delta) {
    App.settings.lineHeight = Math.min(2.4, Math.max(1.4, Math.round((App.settings.lineHeight + delta) * 10) / 10));
    await idbPut('settings', { key: 'settings', ...App.settings });
    applyReaderSettings();
    await refreshReaderLayout();
    syncSettingsUI();
  }

  async function setProgressMode(mode) {
    App.settings.progressMode = mode;
    await idbPut('settings', { key: 'settings', ...App.settings });
    if (App.current && App.current.rendition) {
      try { renderReaderProgress(App.current.rendition.currentLocation()); } catch (e) { /* 等下一次 relocated */ }
    }
    syncSettingsUI();
  }

  async function setFont(font) {
    App.settings.font = font;
    await idbPut('settings', { key: 'settings', ...App.settings });
    applyReaderSettings(); // 注入到正文 iframe（仅阅读界面）
    await refreshReaderLayout();
    syncSettingsUI();
  }

  async function setFlow(flow) {
    const prevFlow = App.settings.flow;
    App.settings.flow = (flow === 'scrolled-doc' || flow === 'paginated') ? flow : 'paginated';
    App.settings.pageAnim = 'slide';
    await idbPut('settings', { key: 'settings', ...App.settings });
    syncSettingsUI();
    syncReaderFlowUI();
    if (!App.current || !App.current.rendition || App.settings.flow === prevFlow) return;
    const rendition = App.current.rendition;
    const cfi = rendition.currentLocation() ? rendition.currentLocation().start.cfi : null;
    try { rendition.flow(App.settings.flow); if (cfi) rendition.display(cfi); }
    catch (e) { await openBook(App.current.id); if (cfi) App.current.rendition.display(cfi); }
  }

  /* ---------------- 生词本 ---------------- */
  async function loadVocab() {
    App.vocab = (await idbAll('vocab')).sort((a, b) => b.time - a.time);
    renderVocab();
  }

  function renderVocab() {
    const list = $('#vocab-list');
    const empty = $('#vocab-empty');
    $('#vocab-count').textContent = App.vocab.length;
    list.innerHTML = '';

    if (App.vocab.length === 0) {
      list.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    list.classList.remove('hidden');
    empty.classList.add('hidden');

    for (let i = 0; i < App.vocab.length; i++) {
      const v = App.vocab[i];
      const item = document.createElement('div');
      item.className = 'vocab-item';
      item.style.animationDelay = (i * 40) + 'ms';
      const d = new Date(v.time);
      const timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      item.innerHTML =
        `<span class="v-word">${esc(v.word)}${v.mastered ? ' <span class="v-mastered">✓ 已牢记</span>' : ''}</span>` +
        (v.phonetic ? `<span class="v-phonetic">${esc(v.phonetic)}</span>` : '') +
        `<div class="v-summary">${esc(compactMeaningText(v.summary) || '（无释义）')}</div>` +
        `<div class="v-time">${timeStr}${v.bookTitle ? ' · ' + esc(v.bookTitle) : ''}</div>` +
        `<div class="v-actions">` +
        `<button class="btn btn-danger" data-del="${esc(v.word)}">删除</button>` +
        `<button class="btn btn-speak2" data-word="${esc(v.word)}">🔊 发音</button>` +
        `</div>`;

      item.addEventListener('click', (e) => {
        if (e.target.dataset.del || e.target.dataset.word) return;
        item.classList.toggle('expanded');
      });

      item.querySelector('[data-del]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await idbDel('vocab', e.target.dataset.del);
        loadVocab();
        toast('已删除');
      });
      item.querySelector('[data-word]').addEventListener('click', (e) => {
        e.stopPropagation();
        speakWord(e.target.dataset.word);
      });

      list.appendChild(item);
    }
  }

  // 生词本发音：优先本地代理 /api/voice（同源，绕开 Chromium ORB 对跨源音频的阻止
  // net::ERR_BLOCKED_BY_ORB），代理不可用时兜底直连有道 dictvoice（桌面浏览器可播）
  // type=1 英音 → type=2 美音 → 直连 → 失败提示
  function speakWord(word) {
    const enc = encodeURIComponent(word);
    const tryPlay = (url, next) => {
      const a = new Audio(url);
      a.onerror = () => { if (next) next(); else toast('发音失败'); };
      a.play().catch(() => { if (next) next(); else toast('发音失败'); });
    };
    tryPlay(`/api/voice?word=${enc}&type=1`, () =>
      tryPlay(`/api/voice?word=${enc}&type=2`, () =>
        tryPlay(`https://dict.youdao.com/dictvoice?audio=${enc}&type=1`, () =>
          toast('发音失败'))));
  }

  function exportVocab() {
    if (!App.vocab.length) { toast('生词本是空的'); return; }
    const rows = [['word', 'phonetic', 'summary', 'book', 'time']];
    for (const v of App.vocab) {
      rows.push([v.word, v.phonetic || '', v.summary || '', v.bookTitle || '', new Date(v.time).toISOString()]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'readlingo-vocab.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 CSV');
  }

  /* ---------------- 背词模块（墨墨规则简化版，数据全部走有道本地代理，国内直连） ---------------- */
  // 记忆规则：
  async function ensureBuiltinWordbooks() {
    let replaced = false;
    for (const desc of BUILTIN_WORDBOOKS) {
      const existing = await idbGet('wordbooks', desc.id);
      if (existing && existing.sourceVersion === desc.sourceVersion) continue;
      try {
        const resp = await fetch(desc.path);
        if (!resp.ok) continue;
        const rows = parseWordbookText(await resp.text());
        if (!rows.length) continue;
        // 旧版本的同名内置词书来自无明确再分发授权的考试词表。
        // 只有确认新资源可读且解析成功后才删除旧内容，避免离线更新时丢数据。
        if (existing) {
          const oldWords = (await idbAll('words')).filter((w) => w.bookId === desc.id);
          for (const old of oldWords) {
            await idbDel('words', old.id);
            await idbDel('wordState', old.id);
          }
          await idbDel('wordbooks', desc.id);
          replaced = true;
        }
        const wb = { id: desc.id, name: desc.name, cover: desc.cover, createdAt: Date.now(), builtin: true, source: 'wordfreq', sourceVersion: desc.sourceVersion, path: desc.path };
        const words = rows.map((w, i) => ({
          id: desc.id + '-' + i,
          word: w.word,
          phonetic: w.phonetic || '',
          meaning: w.meaning || '',
          example: w.example || '',
          bookId: desc.id,
          builtin: true,
        }));
        await idbPut('wordbooks', wb);
        if (words.length) await idbBulkPut('words', words);
      } catch (e) {
        console.warn('预设词书导入失败', desc.id, e);
      }
    }
    if (replaced) {
      // 旧 wordId 与新词条序号可能相同，清掉旧的今日选词，避免串词。
      const logs = await idbAll('dailyLog');
      for (const log of logs) {
        if (Array.isArray(log.selectedNewIds) && log.selectedNewIds.length) {
          log.selectedNewIds = [];
          await idbPut('dailyLog', log);
        }
      }
    }
  }

  // 背词模型：DHP/FSRS 风格的 D-S-R 简化模型。
  // D = 难度，S = 稳定性（在目标回忆率下的建议间隔），R = 当前可提取率。
  // 这里只实现公开模型的可解释子集，不复制任何私有产品参数。
  const TARGET_RETENTION = 0.9;
  const MIN_STABILITY = 0.25;
  const MAX_STABILITY = 3650;
  const SAME_DAY_REPEAT_LIMIT = 2;
  const RATING_SCORE = { forgot: 1, fuzzy: 2, known: 3, master: 4 };

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(dateKey, days) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  }
  function dateDiff(from, to) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    return Math.max(0, Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / 86400000));
  }
  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }
  // 用指数遗忘曲线：R(t,S)=0.9^(t/S)，因此 t=S 时预测回忆率为 90%。
  function recallProbability(elapsedDays, stability) {
    const t = Math.max(0, Number(elapsedDays) || 0);
    const s = Math.max(MIN_STABILITY, Number(stability) || MIN_STABILITY);
    return Math.max(0, Math.min(1, Math.pow(TARGET_RETENTION, t / s)));
  }
  function elapsedDaysForState(st, now = Date.now()) {
    if (!st) return 0;
    if (st.lastReviewAt) return Math.max(0, (now - st.lastReviewAt) / 86400000);
    if (st.lastReviewDate) return dateDiff(st.lastReviewDate, todayKey());
    return 0;
  }
  function stateRetrievability(st, offsetDays = 0) {
    if (!st || st.status === 'mastered') return 1;
    if (!st.stability) return 0.35;
    return recallProbability(elapsedDaysForState(st) + Math.max(0, offsetDays), st.stability);
  }
  function updateDifficulty(st, kind) {
    const changes = { forgot: 0.72, fuzzy: 0.28, known: -0.16, master: -0.36 };
    const old = clampNumber(st.difficulty, 1, 10, 5.5);
    // 轻微向中间回归，避免一次异常反馈永久把难度推到极端。
    st.difficulty = clampNumber(old + (changes[kind] || 0) + (5.5 - old) * 0.025, 1, 10, 5.5);
    return st.difficulty;
  }
  function nextStableInterval(st) {
    return Math.max(1, Math.min(MAX_STABILITY, Math.round(clampNumber(st.stability, MIN_STABILITY, MAX_STABILITY, 1))));
  }
  function appendReviewHistory(st, event) {
    if (!Array.isArray(st.reviewHistory)) st.reviewHistory = [];
    st.reviewHistory.push(event);
    // 每个词保留最近 32 次，足够统计又避免 IndexedDB 无限膨胀。
    if (st.reviewHistory.length > 32) st.reviewHistory.splice(0, st.reviewHistory.length - 32);
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  async function loadStudyData() {
    // 背词页可能从书架直接进入；确保生词本内存数据已就绪，避免旧设备/首次进入时
    // “熟知词”和“已选词”面板读到空的 App.vocab。
    if (!Array.isArray(App.vocab) || App.vocab.length === 0) {
      App.vocab = (await idbAll('vocab')).sort((a, b) => b.time - a.time);
    }
    App.wordbooks = (await idbAll('wordbooks')).sort((a, b) => a.createdAt - b.createdAt);
    App.words = await idbAll('words');
    const states = await idbAll('wordState');
    App.wordStates = {};
    states.forEach((st) => { App.wordStates[st.wordId] = st; });
    // 将旧版只有 interval/streak 的状态补齐到 D-S-R 字段，保证老用户也能立即看到真实曲线。
    const migratedStates = [];
    states.forEach((st) => {
      const needsMigration = typeof st.difficulty !== 'number' || typeof st.stability !== 'number' || !Array.isArray(st.reviewHistory) || (!st.lastReviewDate && st.lastReviewAt);
      const normalized = stateForWord(st.wordId);
      App.wordStates[st.wordId] = normalized;
      if (needsMigration) migratedStates.push(normalized);
    });
    if (migratedStates.length) await idbBulkPut('wordState', migratedStates);
    // 兼容旧版本仅写入 vocab.mastered、尚未创建 wordState 的记录。
    // 有 wordState 时以新的记忆状态为准，避免“恢复复习”后又被旧标记覆盖。
    const legacyMasteredStates = [];
    App.vocab.forEach((v) => {
      if (!v.mastered) return;
      const wid = 'vocab-' + v.word.toLowerCase();
      if (App.wordStates[wid]) return;
      const st = stateForWord(wid);
      st.status = 'mastered';
      st.reps = Math.max(st.reps || 0, 1);
      st.streak = Math.max(st.streak || 0, 3);
      st.nextReview = null;
      st.masteredAt = v.time || Date.now();
      App.wordStates[wid] = st;
      legacyMasteredStates.push(st);
    });
    if (legacyMasteredStates.length) await idbBulkPut('wordState', legacyMasteredStates);
    const today = todayKey();
    App.dailyLogs = (await idbAll('dailyLog')).sort((a, b) => a.date.localeCompare(b.date));
    App.dailyLog = App.dailyLogs.find((x) => x.date === today) || await idbGet('dailyLog', today);
    if (!App.dailyLog) {
      App.dailyLog = {
        date: today,
        target: App.settings.dailyTarget || 20,
        learned: 0,
        newCompleted: 0,
        completed: 0,
        mastered: 0,
        reviewed: 0,
        forgot: 0,
        fuzzy: 0,
        known: 0,
        spelled: 0,
        prelearned: 0,
        spellPending: [],
        spellPlanDate: today,
        spellMode: 'today',
        selectedNewIds: [],
      };
      await idbPut('dailyLog', App.dailyLog);
      App.dailyLogs.push(App.dailyLog);
    } else {
      // 兼容 DB_VER=3 早期版本的字段。
      if (typeof App.dailyLog.newCompleted !== 'number') App.dailyLog.newCompleted = 0;
      if (typeof App.dailyLog.completed !== 'number') App.dailyLog.completed = App.dailyLog.mastered || 0;
      if (typeof App.dailyLog.forgot !== 'number') App.dailyLog.forgot = 0;
      if (typeof App.dailyLog.fuzzy !== 'number') App.dailyLog.fuzzy = 0;
      if (typeof App.dailyLog.known !== 'number') App.dailyLog.known = 0;
      if (typeof App.dailyLog.spelled !== 'number') App.dailyLog.spelled = 0;
      if (typeof App.dailyLog.prelearned !== 'number') App.dailyLog.prelearned = 0;
      if (!Array.isArray(App.dailyLog.spellPending)) App.dailyLog.spellPending = [];
      if (!App.dailyLog.spellPlanDate) App.dailyLog.spellPlanDate = today;
      if (!App.dailyLog.spellMode) App.dailyLog.spellMode = 'today';
      if (!Array.isArray(App.dailyLog.selectedNewIds)) App.dailyLog.selectedNewIds = [];
    }
  }

  function selectedStudySources() {
    const ids = App.settings.studySources;
    return Array.isArray(ids) && ids.length ? new Set(ids) : null;
  }

  function wordSourceEnabled(bookId, selected = selectedStudySources()) {
    // 没有历史选择时保持兼容：默认启用全部词源。
    return !selected || selected.has(bookId);
  }

  // 词库 = 已选词书单词 + 可选生词本自动词库。
  function getStudyWords(includeAll = false) {
    const map = new Map();
    const selected = includeAll ? null : selectedStudySources();
    App.words.forEach((w) => {
      if (!includeAll && !wordSourceEnabled(w.bookId, selected)) return;
      const st = App.wordStates[w.id];
      if (st && st.status === 'ignored') return;
      if (!map.has(w.word.toLowerCase())) map.set(w.word.toLowerCase(), w);
    });
    App.vocab.forEach((v) => {
      if (!includeAll && !wordSourceEnabled('vocab-source', selected)) return;
      const key = v.word.toLowerCase();
      const id = 'vocab-' + key;
      const st = App.wordStates[id];
      if (st && st.status === 'ignored') return;
      if (!map.has(key)) map.set(key, { id, word: v.word, phonetic: v.phonetic || '', meaning: v.summary || '', example: '', bookId: 'vocab' });
    });
    return Array.from(map.values());
  }

  function isDueWord(w, today = todayKey()) {
    const st = App.wordStates[w.id];
    if (st && (st.status === 'mastered' || st.status === 'ignored')) return false;
    if (!st || st.status === 'new') return false;
    return !st.nextReview || st.nextReview <= today;
  }
  function isFreshWord(w) {
    const st = App.wordStates[w.id];
    return !st || st.status === 'new';
  }
  function duePriority(w, today) {
    const st = App.wordStates[w.id] || {};
    const overdue = st.nextReview ? dateDiff(st.nextReview, today) : 0;
    const recallRisk = 1 - stateRetrievability(st);
    return overdue * 16 + recallRisk * 30 + (st.lapses || 0) * 5 + Math.max(0, 3 - (st.streak || 0));
  }
  function getDueWordCount() { return getStudyWords().filter((w) => isDueWord(w)).length; }
  function getFreshWordCount() { return getStudyWords().filter(isFreshWord).length; }

  function getPickedStudyWords() {
    const ids = Array.isArray(App.dailyLog && App.dailyLog.selectedNewIds) ? App.dailyLog.selectedNewIds : [];
    const map = new Map(App.words.map((w) => [w.id, w]));
    App.vocab.forEach((v) => map.set('vocab-' + v.word.toLowerCase(), { id: 'vocab-' + v.word.toLowerCase(), word: v.word, phonetic: v.phonetic || '', meaning: v.summary || '', example: '', bookId: 'vocab' }));
    return ids.map((id) => map.get(id)).filter((w) => w && !(App.wordStates[w.id] && App.wordStates[w.id].status === 'ignored'));
  }

  function isWordMastered(w) {
    if (!w) return false;
    const st = App.wordStates[w.id];
    if (st) return st.status === 'mastered';
    if (w.bookId !== 'vocab') return false;
    const v = App.vocab.find((x) => x.word.toLowerCase() === w.word.toLowerCase());
    return !!(v && v.mastered);
  }

  // dailyTarget 表示“每日新增词”数量；到期复习不挤占新词配额。
  function buildTodayQueue(mode = 'today') {
    const words = getStudyWords();
    const today = todayKey();
    const due = words.filter((w) => isDueWord(w, today));
    due.sort((a, b) => duePriority(b, today) - duePriority(a, today));
    if (mode === 'review') return due;
    const pickedFresh = getPickedStudyWords().filter(isFreshWord);
    if (mode === 'tomorrow') return pickedFresh;
    return due.concat(pickedFresh);
  }

  function stateForWord(wid) {
    const old = App.wordStates[wid];
    if (old) {
      if (typeof old.reps !== 'number') old.reps = old.reviewCount || old.knownCount || 0;
      if (typeof old.streak !== 'number') old.streak = old.knownCount || 0;
      if (typeof old.lapses !== 'number') old.lapses = 0;
      if (typeof old.interval !== 'number') old.interval = 0;
      if (typeof old.difficulty !== 'number') {
        old.difficulty = clampNumber(5.5 + (old.lapses || 0) * 0.45 - (old.streak || 0) * 0.12, 1, 10, 5.5);
      }
      if (typeof old.stability !== 'number') {
        old.stability = clampNumber((old.interval || 0) * 1.5 || (old.reviewCount ? 1 : 0.5), MIN_STABILITY, MAX_STABILITY, 0.5);
      }
      if (!Array.isArray(old.reviewHistory)) old.reviewHistory = [];
      if (!old.lastReviewDate && old.lastReviewAt) {
        const d = new Date(old.lastReviewAt);
        old.lastReviewDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }
      return old;
    }
    return {
      wordId: wid,
      status: 'new',
      reps: 0,
      streak: 0,
      lapses: 0,
      interval: 0,
      nextReview: todayKey(),
      reviewCount: 0,
      difficulty: 5.5,
      stability: 0.5,
      reviewHistory: [],
    };
  }

  function createRecognitionSession(queueWords, mode) {
    return {
      phase: 'recognition',
      mode,
      planDate: mode === 'tomorrow' ? addDays(todayKey(), 1) : todayKey(),
      queue: queueWords.map((w) => w.id),
      freshIds: new Set(queueWords.filter(isFreshWord).map((w) => w.id)),
      done: {},
      sees: {},
      total: queueWords.length,
      answerCount: 0,
      revealed: false,
      history: [],
      result: { completed: 0, forgot: 0, fuzzy: 0, known: 0, mastered: 0, answers: 0 },
    };
  }

  function createSpellingSession(ids, planDate, mode, result) {
    const valid = ids.filter((id) => findWordById(id));
    return {
      phase: 'spelling',
      mode,
      planDate,
      spellQueue: valid,
      spellIndex: 0,
      spellDone: [],
      result: result ? { ...result } : { completed: 0, forgot: 0, fuzzy: 0, known: 0, mastered: 0, answers: 0 },
    };
  }

  function promptStudyWordSelection() {
    toast('请先在“词书”面板选择今日新增单词');
  }

  function startStudySession(mode = 'today') {
    if ((mode === 'today' || mode === 'tomorrow') && !(App.dailyLog.selectedNewIds && App.dailyLog.selectedNewIds.length)) {
      promptStudyWordSelection();
      return;
    }
    if (mode === 'today' && App.dailyLog.spellPending && App.dailyLog.spellPending.length) {
      App.studySession = createSpellingSession(App.dailyLog.spellPending, App.dailyLog.spellPlanDate || todayKey(), App.dailyLog.spellMode || 'today');
      switchView('view-study-session');
      renderStudyCard();
      return;
    }
    if (mode !== 'today' && App.dailyLog.spellPending && App.dailyLog.spellPending.length) {
      toast('请先完成当前拼写巩固');
      return;
    }
    const queueWords = buildTodayQueue(mode);
    if (!queueWords.length) {
      toast(mode === 'review' ? '今天没有到期复习' : '所选词书没有可学习的新词');
      return;
    }
    App.studySession = createRecognitionSession(queueWords, mode);
    if (mode === 'today') App.dailyLog.learned = Math.max(App.dailyLog.learned || 0, queueWords.filter(isFreshWord).length);
    idbPut('dailyLog', App.dailyLog);
    $('#study-session-title').textContent = mode === 'tomorrow' ? '明日预习' : (mode === 'review' ? '今日复习' : todayKey() + ' 背词');
    switchView('view-study-session');
    renderStudyCard();
  }

  function findWordById(wid) {
    let w = App.words.find((x) => x.id === wid);
    if (!w && wid.startsWith('vocab-')) {
      const key = wid.slice(6);
      const v = App.vocab.find((x) => x.word.toLowerCase() === key);
      if (v) w = { id: wid, word: v.word, phonetic: v.phonetic || '', meaning: v.summary || '', example: '', bookId: 'vocab' };
    }
    return w;
  }

  function revealStudyCard() {
    const s = App.studySession;
    if (!s || s.phase !== 'recognition' || !s.queue.length) return;
    s.revealed = true;
    $('#study-card').classList.add('revealed');
    $('#study-reveal').classList.add('hidden');
    $$('.study-btn').forEach((btn) => { btn.disabled = false; });
  }

  async function enrichStudyWord(w) {
    if (!w || w._studyEnriching || (w.meaning && w.example)) return;
    w._studyEnriching = true;
    try {
      let data = null;
      try {
        const resp = await fetch('/api/dict?q=' + encodeURIComponent(w.word));
        if (resp.ok) data = await resp.json();
      } catch (e) {}
      const e = data && data.ec && data.ec.word && data.ec.word[0];
      if (e) {
        w.phonetic = w.phonetic || e.ukphone || e.usphone || '';
        w.meaning = extractMeaning(e) || w.meaning;
        w.example = w.example || extractExample(data);
      }
      if (w.id && !w.id.startsWith('vocab-') && data) await idbPut('words', w);
      const s = App.studySession;
      if (s && s.phase === 'recognition' && s.queue[0] === w.id) {
        $('#study-card-phonetic').textContent = w.phonetic ? '/' + w.phonetic.replace(/^\/|\/$/g, '') + '/' : '';
        $('#study-card-meaning').textContent = compactMeaningText(w.meaning) || '（暂无中文释义）';
        $('#study-card-example').textContent = w.example || '';
      }
    } catch (e) { /* Web 版或离线时保留词书原始内容 */ }
    finally { delete w._studyEnriching; }
  }

  function renderStudyCard() {
    const s = App.studySession;
    if (!s) return;
    if (s.phase === 'spelling') return renderSpellingCard();
    $('#study-memory-panel').classList.remove('hidden');
    $('#study-spell-panel').classList.add('hidden');
    const doneCount = Object.keys(s.done).length;
    $('#study-session-progress').textContent = doneCount + ' / ' + s.total;
    if (!s.queue.length) { finishRecognitionSession(); return; }
    const wid = s.queue[0];
    const w = findWordById(wid);
    if (!w) { s.queue.shift(); renderStudyCard(); return; }
    const st = App.wordStates[wid];
    $('#study-card-word').textContent = w.word;
    $('#study-card-phonetic').textContent = w.phonetic ? '/' + w.phonetic.replace(/^\/|\/$/g, '') + '/' : '';
    $('#study-card-meaning').textContent = compactMeaningText(w.meaning) || '（显示释义时尝试查词）';
    $('#study-card-example').textContent = w.example || '';
    $('#study-card-source').textContent = isFreshWord(w)
      ? '新词'
      : (st && st.stability ? `到期复习 · 稳定 ${Math.round(st.stability * 10) / 10} 天` : '待复习');
    $('#btn-study-prev').disabled = !s.history || !s.history.length;
    $('#study-card').classList.remove('revealed');
    $('#study-reveal').classList.remove('hidden');
    $$('.study-btn').forEach((btn) => { btn.disabled = true; });
    s.revealed = false;
    const speakBtn = $('#study-card-speak');
    speakBtn.onclick = (e) => { e.stopPropagation(); speakWord(w.word); };
    enrichStudyWord(w);
  }

  function normalizeSpelling(value) {
    return String(value || '').trim().toLowerCase().replace(/[’]/g, "'");
  }
  function spellingBlanks(word) {
    return Array.from(word).map((ch) => /[A-Za-z]/.test(ch) ? '<span class="spell-blank">_</span>' : `<span class="spell-punctuation">${esc(ch)}</span>`).join(' ');
  }
  function renderSpellingCard() {
    const s = App.studySession;
    if (!s || s.phase !== 'spelling') return;
    $('#study-memory-panel').classList.add('hidden');
    $('#study-spell-panel').classList.remove('hidden');
    const wid = s.spellQueue[s.spellIndex];
    const w = findWordById(wid);
    if (!w) { s.spellIndex++; renderSpellingCard(); return; }
    $('#study-session-progress').textContent = `拼写 ${s.spellIndex + 1} / ${s.spellQueue.length}`;
    $('#study-spell-word-count').textContent = `${s.spellIndex + 1} / ${s.spellQueue.length}`;
    $('#study-spell-meaning').textContent = w.meaning || '（暂无中文释义）';
    $('#study-spell-blanks').innerHTML = spellingBlanks(w.word);
    $('#study-spell-input').value = '';
    $('#study-spell-feedback').textContent = '';
    $('#study-spell-input').focus();
    $('#study-spell-speak').onclick = () => speakWord(w.word);
    enrichStudyWord(w);
  }

  function finishRecognitionSession() {
    const s = App.studySession;
    if (!s) return;
    const freshIds = Array.from(s.freshIds).filter((id) => s.done[id]);
    if (freshIds.length) {
      App.dailyLog.spellPending = freshIds;
      App.dailyLog.spellPlanDate = s.planDate;
      App.dailyLog.spellMode = s.mode;
      idbPut('dailyLog', App.dailyLog);
      App.studySession = createSpellingSession(freshIds, s.planDate, s.mode, s.result);
      renderStudyCard();
      return;
    }
    finishStudySession(s);
  }

  function submitSpelling() {
    const s = App.studySession;
    if (!s || s.phase !== 'spelling') return;
    const wid = s.spellQueue[s.spellIndex];
    const w = findWordById(wid);
    const input = $('#study-spell-input');
    if (!w || !input) return;
    if (normalizeSpelling(input.value) !== normalizeSpelling(w.word)) {
      $('#study-spell-feedback').textContent = '拼写不正确，再试一次；可点击“显示答案”查看后重新输入。';
      input.focus();
      return;
    }
    s.spellDone.push(wid);
    s.spellIndex++;
    App.dailyLog.spelled = (App.dailyLog.spelled || 0) + 1;
    App.dailyLog.spellPending = s.spellQueue.slice(s.spellIndex);
    if (s.mode === 'today') {
      App.dailyLog.newCompleted = (App.dailyLog.newCompleted || 0) + 1;
      App.dailyLog.completed = (App.dailyLog.completed || 0) + 1;
    } else {
      App.dailyLog.prelearned = (App.dailyLog.prelearned || 0) + 1;
    }
    idbPut('dailyLog', App.dailyLog);
    if (s.spellIndex >= s.spellQueue.length) {
      App.dailyLog.spellPending = [];
      idbPut('dailyLog', App.dailyLog);
      finishStudySession(s);
    } else {
      renderSpellingCard();
    }
  }

  function showSpellingAnswer() {
    const s = App.studySession;
    if (!s || s.phase !== 'spelling') return;
    const w = findWordById(s.spellQueue[s.spellIndex]);
    if (w) $('#study-spell-feedback').textContent = `答案：${w.word}（仍需手动输入并检查）`;
  }

  function updateStabilityAfterReview(st, kind, elapsedDays, beforeR) {
    const oldS = clampNumber(st.stability, MIN_STABILITY, MAX_STABILITY, 0.5);
    const difficulty = updateDifficulty(st, kind);
    if (kind === 'forgot') {
      st.stability = Math.max(MIN_STABILITY, oldS * 0.45);
      st.interval = 0;
      return;
    }
    if (kind === 'fuzzy') {
      st.stability = Math.max(MIN_STABILITY, oldS * 0.72);
      st.interval = 1;
      return;
    }

    const growth = kind === 'master' ? 2.1 : 1.15;
    const difficultyFactor = clampNumber(1.16 - (difficulty - 5.5) * 0.055, 0.72, 1.35, 1);
    const spacingFactor = 1 + Math.min(2, Math.log1p(Math.max(0, elapsedDays)) / 3.5);
    const recallFactor = clampNumber(0.82 + (beforeR || 0) * 0.30, 0.82, 1.12, 0.95);
    st.stability = clampNumber(
      oldS * (1 + growth * difficultyFactor * spacingFactor * recallFactor),
      MIN_STABILITY,
      MAX_STABILITY,
      1
    );
    st.interval = kind === 'master' ? 0 : nextStableInterval(st);
  }

  function completeStudyItem(s, wid, kind) {
    s.done[wid] = kind;
    s.result.completed++;
    s.result[kind] = (s.result[kind] || 0) + 1;
    if (!s.freshIds.has(wid)) App.dailyLog.completed = (App.dailyLog.completed || 0) + 1;
    App.dailyLog.mastered = App.dailyLog.mastered || 0;
  }

  async function previousStudyCard() {
    const s = App.studySession;
    if (!s || s.phase !== 'recognition' || !s.history || !s.history.length) return;
    const snap = s.history.pop();
    s.queue = snap.queue;
    s.done = snap.done;
    s.sees = snap.sees;
    s.answerCount = snap.answerCount;
    s.result = snap.result;
    const current = snap.state;
    if (current) {
      App.wordStates[snap.wid] = current;
      await idbPut('wordState', current);
    } else {
      delete App.wordStates[snap.wid];
      await idbDel('wordState', snap.wid);
    }
    App.dailyLog = snap.dailyLog;
    await idbPut('dailyLog', App.dailyLog);
    renderStudyCard();
    toast('已返回上一个词');
  }

  // 反馈：forgot=忘记、fuzzy=模糊、known=认识、master=熟知。
  function studyAnswer(kind) {
    const s = App.studySession;
    if (!s || s.phase !== 'recognition' || !s.queue.length || !s.revealed || !RATING_SCORE[kind]) return;
    const wid = s.queue[0];
    s.history = s.history || [];
    s.history.push({
      wid,
      queue: s.queue.slice(),
      done: { ...s.done },
      sees: { ...s.sees },
      answerCount: s.answerCount,
      result: { ...s.result },
      state: App.wordStates[wid]
        ? { ...App.wordStates[wid], reviewHistory: Array.isArray(App.wordStates[wid].reviewHistory) ? App.wordStates[wid].reviewHistory.map((event) => ({ ...event })) : [] }
        : null,
      dailyLog: { ...App.dailyLog, spellPending: [...(App.dailyLog.spellPending || [])], selectedNewIds: [...(App.dailyLog.selectedNewIds || [])] },
    });
    s.queue.shift();
    const w = findWordById(wid);
    const st = stateForWord(wid);
    const today = s.planDate || todayKey();
    const reviewDate = todayKey();
    const now = Date.now();
    const wasFresh = st.status === 'new';
    const elapsedDays = wasFresh ? 0 : elapsedDaysForState(st, now);
    const beforeR = wasFresh ? 0.35 : stateRetrievability(st);
    const stabilityBefore = clampNumber(st.stability, MIN_STABILITY, MAX_STABILITY, 0.5);
    s.sees[wid] = (s.sees[wid] || 0) + 1;
    const sees = s.sees[wid];
    s.answerCount++;
    s.result.answers++;
    if (wasFresh) App.dailyLog.learned = Math.max(App.dailyLog.learned || 0, 1);
    else App.dailyLog.reviewed = (App.dailyLog.reviewed || 0) + 1;

    st.reviewCount = (st.reviewCount || 0) + 1;
    st.lastReviewAt = now;
    st.lastReviewDate = reviewDate;
    st.lastRating = kind;
    updateStabilityAfterReview(st, kind, elapsedDays, beforeR);

    if (kind === 'forgot') {
      st.status = 'learning'; st.reps = 0; st.streak = 0; st.lapses = (st.lapses || 0) + 1; st.nextReview = today;
      App.dailyLog.forgot = (App.dailyLog.forgot || 0) + 1;
      if (sees < SAME_DAY_REPEAT_LIMIT) s.queue.push(wid); else completeStudyItem(s, wid, kind);
    } else if (kind === 'fuzzy') {
      st.status = 'learning'; st.streak = 0; st.nextReview = today;
      App.dailyLog.fuzzy = (App.dailyLog.fuzzy || 0) + 1;
      if (sees < SAME_DAY_REPEAT_LIMIT) s.queue.push(wid); else completeStudyItem(s, wid, kind);
    } else if (kind === 'known') {
      st.status = 'learning'; st.streak = (st.streak || 0) + 1; st.reps = (st.reps || 0) + 1;
      st.nextReview = addDays(today, st.interval);
      App.dailyLog.known = (App.dailyLog.known || 0) + 1;
      completeStudyItem(s, wid, kind);
    } else if (kind === 'master') {
      st.status = 'mastered'; st.streak = Math.max(st.streak || 0, 3); st.reps = Math.max(st.reps || 0, 1); st.interval = 0; st.nextReview = null; st.masteredAt = now;
      if (w) {
        const v = App.vocab.find((x) => x.word.toLowerCase() === w.word.toLowerCase());
        if (v && !v.mastered) { v.mastered = true; idbPut('vocab', v); }
      }
      completeStudyItem(s, wid, kind);
      App.dailyLog.mastered = (App.dailyLog.mastered || 0) + 1;
    }
    appendReviewHistory(st, {
      date: reviewDate,
      at: now,
      rating: kind,
      score: RATING_SCORE[kind],
      elapsedDays: Math.round(elapsedDays * 100) / 100,
      retrievability: Math.round(beforeR * 1000) / 1000,
      stabilityBefore: Math.round(stabilityBefore * 100) / 100,
      stabilityAfter: Math.round(st.stability * 100) / 100,
      difficulty: Math.round(st.difficulty * 100) / 100,
      scheduledDays: st.interval || 0,
      mode: s.mode,
    });
    App.wordStates[wid] = st;
    idbPut('wordState', st); idbPut('dailyLog', App.dailyLog);
    updateStudyRing(); renderStudyCard();
  }

  function resetStudyProgress() {
    showConfirmDialog('重置学习进度？这会清除所有单词的记忆状态、今日统计和拼写进度，但不会删除词书和单词。', async () => {
      const states = await idbAll('wordState');
      for (const st of states) await idbDel('wordState', st.wordId);
      const logs = await idbAll('dailyLog');
      for (const log of logs) await idbDel('dailyLog', log.date);
      for (const v of App.vocab) { if (v.mastered) { v.mastered = false; await idbPut('vocab', v); } }
      App.studySession = null;
      await loadStudyData();
      renderWordbookList(); renderStudyOverview();
      toast('学习进度已重置');
    });
  }

  function finishStudySession(s) {
    const result = s ? { ...s.result } : null;
    const mode = s ? s.mode : 'today';
    App.studySession = null;
    if (result) {
      const prefix = mode === 'tomorrow' ? '明日预习' : (mode === 'review' ? '今日复习' : '本次学习');
      $('#study-last-session').textContent = `${prefix}完成 ${result.completed} 词 · 忘记 ${result.forgot} · 模糊 ${result.fuzzy} · 认识 ${result.known} · 熟知 ${result.mastered}`;
      $('#study-last-session').classList.remove('hidden');
    }
    toast(mode === 'tomorrow' ? '明日预习完成！' : '本次学习完成！');
    switchView('view-study'); renderStudyOverview(); renderWordbookList();
  }

  // 圆形进度条（按每日新增词的“拼写完成”计数）
  function updateStudyRing() {
    const ring = $('#study-ring-fg');
    const C = 326.7;
    const total = App.dailyLog ? App.dailyLog.target : 1;
    const done = App.dailyLog ? (App.dailyLog.newCompleted || 0) : 0;
    const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    ring.style.strokeDashoffset = String(C * (1 - pct / 100));
    $('#study-pct').textContent = pct + '%';
  }

  function getSourceStats(sourceId) {
    const words = pickerWords(sourceId);
    const selected = new Set(App.dailyLog && App.dailyLog.selectedNewIds || []);
    let fresh = 0, learned = 0, due = 0, mastered = 0;
    words.forEach((w) => {
      const st = App.wordStates[w.id];
      if (!st || st.status === 'new') fresh++;
      else if (st.status === 'mastered') mastered++;
      else learned++;
      if (isDueWord(w)) due++;
    });
    return { total: words.length, selected: words.filter((w) => selected.has(w.id)).length, fresh, learned, due, mastered };
  }

  function reviewEventsSince(days = 30) {
    const cutoff = addDays(todayKey(), -(days - 1));
    const events = [];
    Object.values(App.wordStates || {}).forEach((st) => {
      if (!Array.isArray(st.reviewHistory)) return;
      st.reviewHistory.forEach((event) => {
        if (event && event.date && event.date >= cutoff) events.push(event);
      });
    });
    return events.sort((a, b) => (a.at || 0) - (b.at || 0));
  }

  function studyStatsSnapshot() {
    const words = getStudyWords(true);
    const states = words.map((w) => App.wordStates[w.id]).filter(Boolean);
    const learned = states.filter((st) => st.status === 'learning' || st.status === 'mastered').length;
    const mastered = states.filter((st) => st.status === 'mastered').length;
    const due = getStudyWords().filter((w) => isDueWord(w)).length;
    const memoryStates = states.filter((st) => (st.status === 'learning' && st.stability > 0) || st.status === 'mastered');
    const learningStates = memoryStates.filter((st) => st.status === 'learning');
    const avgStability = learningStates.length
      ? learningStates.reduce((sum, st) => sum + st.stability, 0) / learningStates.length
      : 0;
    const retention = memoryStates.length
      ? Math.round(memoryStates.reduce((sum, st) => sum + stateRetrievability(st), 0) / memoryStates.length * 100)
      : 0;
    const events = reviewEventsSince(30);
    const accuracy = events.length
      ? Math.round(events.reduce((sum, event) => sum + (event.score >= 3 ? 1 : event.score === 2 ? 0.5 : 0), 0) / events.length * 100)
      : null;
    const logs = (App.dailyLogs || []).slice(-14);
    const points = Array.from({ length: 31 }, (_, day) => {
      if (!memoryStates.length) return 0;
      const value = memoryStates.reduce((sum, st) => sum + stateRetrievability(st, day), 0) / memoryStates.length;
      return Math.round(value * 100);
    });
    const curveNote = memoryStates.length
      ? `基于 ${memoryStates.length} 个记忆状态实时预测；近 30 天记录 ${events.length} 次反馈。目标回忆率 ${Math.round(TARGET_RETENTION * 100)}%。`
      : '完成第一次反馈后，这里会根据你的实际记忆状态生成动态遗忘曲线。';
    return {
      total: words.length,
      learned,
      mastered,
      due,
      avgStability,
      retention,
      accuracy,
      logs,
      points,
      curveNote,
    };
  }

  function renderStudyStats() {
    const s = studyStatsSnapshot();
    const learnedEl = $('#study-stat-learned');
    if (!learnedEl) return;
    learnedEl.textContent = s.learned;
    $('#study-stat-mastered').textContent = s.mastered;
    $('#study-stat-due').textContent = s.due;
    $('#study-stat-retention').textContent = s.retention + '%';
    $('#study-stat-interval').textContent = s.avgStability ? (Math.round(s.avgStability * 10) / 10) + ' 天' : '—';
    const accuracyEl = $('#study-stat-accuracy');
    if (accuracyEl) accuracyEl.textContent = s.accuracy == null ? '—' : s.accuracy + '%';
    $('#study-stat-today').textContent = `${App.dailyLog ? (App.dailyLog.newCompleted || 0) : 0} / ${App.dailyLog ? App.dailyLog.target : 20}`;
    const curveNote = $('#study-curve-note');
    if (curveNote) curveNote.textContent = s.curveNote;
    const path = $('#forgetting-curve-path');
    const area = $('#forgetting-curve-area');
    const dots = $('#forgetting-curve-dots');
    if (path && area && dots) {
      const last = Math.max(1, s.points.length - 1);
      const pts = s.points.map((v, i) => [18 + i * 270 / last, 104 - v * .82]);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      path.setAttribute('d', d);
      area.setAttribute('d', d + ' L 288 108 L 18 108 Z');
      const markerIndexes = [0, 7, 30].filter((i) => i < pts.length);
      dots.innerHTML = markerIndexes.map((i) => `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="3.5"></circle>`).join('');
    }
    const bars = $('#study-learning-bars');
    if (bars) {
      const byDate = new Map((App.dailyLogs || []).map((log) => [log.date, log]));
      const logs = Array.from({ length: 7 }, (_, i) => {
        const date = addDays(todayKey(), i - 6);
        return { date, newCompleted: 0, known: 0, mastered: 0, forgot: 0, fuzzy: 0, ...(byDate.get(date) || {}) };
      });
      const totals = logs.map((x) => (x.newCompleted || 0) + (x.known || 0) + (x.mastered || 0) + (x.forgot || 0) + (x.fuzzy || 0));
      const max = Math.max(1, ...totals);
      bars.innerHTML = logs.map((x, i) => {
        const fresh = x.newCompleted || 0;
        const recalled = (x.known || 0) + (x.mastered || 0);
        const weak = (x.forgot || 0) + (x.fuzzy || 0);
        const total = fresh + recalled + weak;
        return `<div class="learning-bar-day" title="${x.date}：新增 ${fresh}，正确回忆 ${recalled}，遗忘/模糊 ${weak}"><div class="learning-bar-stack"><i style="height:${Math.round(fresh / max * 100)}%"></i><b style="height:${Math.round(recalled / max * 100)}%"></b><em style="height:${Math.round(weak / max * 100)}%"></em></div><span>${i === 6 ? '今天' : String(x.date).slice(5)}</span></div>`;
      }).join('');
    }
  }

  function toggleStudyInlinePanel(id, render) {
    const panel = $('#' + id);
    if (!panel) return;
    clearTimeout(panel._inlineTimer);
    if (!panel.classList.contains('hidden')) {
      panel.classList.remove('study-inline-enter');
      panel.classList.add('study-inline-leave');
      panel._inlineTimer = setTimeout(() => { panel.classList.add('hidden'); panel.classList.remove('study-inline-leave'); }, 240);
      return;
    }
    // 两个快捷面板互斥，避免在窄屏上连续打开后内容叠压、滚动位置跳动。
    ['study-selected-panel', 'study-mastered-panel'].forEach((otherId) => {
      if (otherId === id) return;
      const other = $('#' + otherId);
      if (!other) return;
      clearTimeout(other._inlineTimer);
      other.classList.add('hidden');
      other.classList.remove('study-inline-enter', 'study-inline-leave');
    });
    if (render) render();
    panel.classList.remove('hidden', 'study-inline-leave');
    void panel.offsetWidth;
    panel.classList.add('study-inline-enter');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function switchStudyPanel(name) {
    App.studyPanel = name;
    const map = { overview: '#study-overview', books: '.study-books', stats: '#study-stats-panel' };
    Object.keys(map).forEach((key) => {
      const el = document.querySelector(map[key]);
      if (!el) return;
      el.classList.remove('study-panel-enter');
      if (key === name) {
        el.classList.remove('study-panel-hidden');
        void el.offsetWidth;
        el.classList.add('study-panel-enter');
      } else {
        el.classList.add('study-panel-hidden');
      }
    });
    $$('#study-panel-tabs .study-panel-tab').forEach((b) => b.classList.toggle('active', b.dataset.studyPanel === name));
  }

  function formatStudyDate(dateKey) {
    if (!dateKey) return '未安排';
    const today = todayKey();
    if (dateKey === today) return '今天';
    if (dateKey === addDays(today, 1)) return '明天';
    return dateKey;
  }

  function renderSelectedList() {
    const list = $('#study-selected-list');
    if (!list) return;
    const ids = pickerSourceIds();
    const words = getPickedStudyWords();
    list.innerHTML = '';
    $('#study-selected-empty').classList.toggle('hidden', words.length > 0);
    words.forEach((w) => {
      const st = App.wordStates[w.id];
      const mastered = isWordMastered(w);
      const status = mastered ? '熟知' : !st || st.status === 'new' ? '新词' : '学习中';
      const degree = mastered
        ? '100%'
        : st && st.stability
          ? `稳定 ${Math.round(st.stability * 10) / 10} 天 · 难度 ${Math.round((st.difficulty || 5.5) * 10) / 10}`
          : '待开始';
      const item = document.createElement('div');
      item.className = 'mastered-word-item selected-word-item';
      item.innerHTML = `<div><strong>${esc(w.word)}</strong><span class="mastered-word-source">${esc(sourceLabel(w.bookId === 'vocab' ? 'vocab-source' : w.bookId))}</span><div class="mastered-word-meaning">${esc(compactMeaningText(w.meaning) || '暂无释义')}</div></div>` +
        `<div class="selected-word-meta"><span>${status} · ${degree}</span><span>预计：${formatStudyDate(st && st.nextReview)}</span><button class="btn btn-ghost selected-word-remove">移出今日</button></div>`;
      item.querySelector('.selected-word-remove').addEventListener('click', async () => {
        App.dailyLog.selectedNewIds = pickerSourceIds().filter((id) => id !== w.id);
        await idbPut('dailyLog', App.dailyLog);
        renderSelectedList(); renderWordbookList(); renderStudyOverview();
      });
      list.appendChild(item);
    });
  }

  function renderStudyOverview() {
    if (!App.dailyLog) return;
    const target = App.dailyLog.target || App.settings.dailyTarget || 20;
    const newDone = App.dailyLog.newCompleted || 0;
    const dueCount = getDueWordCount();
    const freshCount = getFreshWordCount();
    const hasPendingSpelling = App.dailyLog.spellPending && App.dailyLog.spellPending.length > 0;
    const planComplete = !hasPendingSpelling && (newDone >= target || (freshCount === 0 && newDone > 0));
    $('#study-count-done').textContent = newDone;
    $('#study-count-target').textContent = target;
    $('#study-count-due').textContent = dueCount;
    $('#study-count-mastered').textContent = Object.values(App.wordStates).filter((st) => st.status === 'mastered').length;
    $('#study-target-val').textContent = App.settings.dailyTarget || 20;
    updateStudyRing();
    $('#study-finished').classList.toggle('hidden', !planComplete);
    $('#btn-study-start').classList.toggle('hidden', planComplete ? hasPendingSpelling : !(dueCount || freshCount || hasPendingSpelling));
    $('#btn-study-start').textContent = hasPendingSpelling ? '继续拼写' : (dueCount > 0 ? '开始今日计划' : (newDone > 0 ? '开始新词' : '开始背词'));
    $('#btn-study-review').classList.toggle('hidden', !planComplete || dueCount === 0);
    $('#btn-study-tomorrow').classList.toggle('hidden', !planComplete || freshCount === 0);
    renderMasteredList();
    renderStudyStats();
  }

  function sourceLabel(id) {
    if (id === 'vocab-source') return '生词本';
    const wb = App.wordbooks.find((x) => x.id === id);
    return wb ? wb.name : id;
  }

  function selectedSourceIdsForUI() {
    const selected = selectedStudySources();
    return selected ? Array.from(selected) : App.wordbooks.map((wb) => wb.id).concat(['vocab-source']);
  }

  async function saveStudySourceSelection(ids) {
    const clean = Array.from(new Set(ids));
    if (!clean.length) { toast('至少选择一本词书'); return false; }
    App.settings.studySources = clean;
    await idbPut('settings', { key: 'settings', ...App.settings });
    renderWordbookList();
    renderStudyOverview();
    return true;
  }

  function pickerWords(sourceId) {
    if (sourceId === 'vocab-source') return getStudyWords(true).filter((w) => w.bookId === 'vocab');
    return App.words.filter((w) => w.bookId === sourceId && !(App.wordStates[w.id] && App.wordStates[w.id].status === 'ignored'));
  }

  function pickerSourceIds() {
    return App.dailyLog && Array.isArray(App.dailyLog.selectedNewIds) ? App.dailyLog.selectedNewIds.slice() : [];
  }

  function pickerDraftIds() {
    return Array.isArray(App.studyPicker.draftIds) ? App.studyPicker.draftIds.slice() : pickerSourceIds();
  }

  async function commitPickerSelection() {
    if (!App.dailyLog) return;
    App.dailyLog.selectedNewIds = Array.from(new Set(App.studyPicker.draftIds || []));
    await idbPut('dailyLog', App.dailyLog);
    renderWordbookList();
    renderStudyOverview();
    closeWordPicker();
    toast(`已加入今日计划 ${App.dailyLog.selectedNewIds.length} 词`);
  }

  function updatePickerSummary() {
    const sourceId = App.studyPicker.sourceId;
    const selected = new Set(pickerDraftIds());
    const sourceWords = pickerWords(sourceId);
    const sourceIds = new Set(sourceWords.map((w) => w.id));
    const sourcePicked = Array.from(selected).filter((id) => sourceIds.has(id)).length;
    $('#study-word-picker-count').textContent = `已选 ${sourcePicked} / ${sourceWords.length}（今日总选 ${selected.size}）`;
  }

  function pickerWordLabel(w, selected) {
    const st = App.wordStates[w.id];
    const fresh = isFreshWord(w);
    const checked = selected.has(w.id);
    const item = document.createElement('label');
    item.className = 'study-picker-word' + (checked ? ' picked' : '') + (!fresh && !checked ? ' disabled' : '');
    item.innerHTML = `<input type="checkbox" data-word-id="${esc(w.id)}" ${checked ? 'checked' : ''} ${!fresh && !checked ? 'disabled' : ''}>` +
      `<span class="study-picker-word-main"><strong>${esc(w.word)}</strong><span>${esc(w.meaning || '暂无释义')}</span></span>` +
      `<span class="study-picker-word-state">${checked ? '已选' : (st && st.status === 'mastered' ? '熟知' : (st ? '已学' : '新词'))}</span>`;
    return item;
  }

  function appendPickerWords() {
    const list = $('#study-word-picker-list');
    const words = App.studyPicker.filteredWords || [];
    const pageSize = 120;
    const start = App.studyPicker.renderedCount || 0;
    const end = Math.min(words.length, start + pageSize);
    if (start >= end) return;
    const selected = new Set(pickerDraftIds());
    const fragment = document.createDocumentFragment();
    words.slice(start, end).forEach((w) => fragment.appendChild(pickerWordLabel(w, selected)));
    list.appendChild(fragment);
    App.studyPicker.renderedCount = end;
  }

  function handlePickerWordChange(e) {
    const cb = e.target;
    if (!cb.matches('#study-word-picker-list input[type="checkbox"]')) return;
    const ids = pickerDraftIds();
    const i = ids.indexOf(cb.dataset.wordId);
    if (cb.checked && i < 0) ids.push(cb.dataset.wordId);
    if (!cb.checked && i >= 0) ids.splice(i, 1);
    App.studyPicker.draftIds = ids;
    const item = cb.closest('.study-picker-word');
    if (item) {
      item.classList.toggle('picked', cb.checked);
      const state = item.querySelector('.study-picker-word-state');
      if (state) state.textContent = cb.checked ? '已选' : '新词';
    }
    updatePickerSummary();
  }

  function renderPickerWords() {
    const panel = $('#study-word-picker');
    if (!panel || panel.classList.contains('hidden')) return;
    const sourceId = App.studyPicker.sourceId;
    const query = (App.studyPicker.query || '').trim().toLowerCase();
    const allWords = pickerWords(sourceId);
    App.studyPicker.filteredWords = allWords.filter((w) => !query || w.word.toLowerCase().includes(query));
    App.studyPicker.renderedCount = 0;
    const list = $('#study-word-picker-list');
    $('#study-word-picker-title').textContent = `选择：${sourceLabel(sourceId)}`;
    updatePickerSummary();
    list.innerHTML = '';
    if (!App.studyPicker.filteredWords.length) {
      list.innerHTML = '<div class="study-picker-empty">没有匹配的可选单词</div>';
      return;
    }
    appendPickerWords();
  }

  async function autoPickCurrentWordbook() {
    const sourceId = App.studyPicker.sourceId;
    const target = App.dailyLog.target || App.settings.dailyTarget || 20;
    const sourceIds = new Set(pickerWords(sourceId).map((w) => w.id));
    const keep = pickerDraftIds().filter((id) => !sourceIds.has(id));
    const candidates = shuffle(pickerWords(sourceId).filter(isFreshWord)).slice(0, target).map((w) => w.id);
    App.studyPicker.draftIds = keep.concat(candidates);
    renderPickerWords();
    toast(`已生成 ${candidates.length} 词，点击“确定加入今日计划”后生效`);
  }

  async function clearCurrentWordbookSelection() {
    const sourceIds = new Set(pickerWords(App.studyPicker.sourceId).map((w) => w.id));
    App.studyPicker.draftIds = pickerDraftIds().filter((id) => !sourceIds.has(id));
    renderPickerWords();
    toast('已清空当前词书选择，点击确定后生效');
  }

  async function openWordPicker(sourceId) {
    App.studyPicker = { sourceId, query: '', draftIds: pickerSourceIds(), filteredWords: [], renderedCount: 0 };
    const selected = selectedStudySources();
    if (selected && !selected.has(sourceId)) {
      App.settings.studySources = Array.from(new Set(Array.from(selected).concat(sourceId)));
      await idbPut('settings', { key: 'settings', ...App.settings });
    }
    $('#study-word-search').value = '';
    const picker = $('#study-word-picker');
    picker.classList.remove('hidden', 'study-picker-leave');
    void picker.offsetWidth;
    picker.classList.add('study-picker-enter');
    $('#bottom-nav').classList.add('nav-hidden');
    renderWordPicker();
  }

  function renderWordPicker() {
    renderPickerWords();
    // 打开词书时不主动抢焦点，搜索框由用户自行点击后再输入。
  }

  function closeWordPicker() {
    // X 关闭视为取消，未点确定的勾选不写入当天计划。
    App.studyPicker = { sourceId: '', query: '', draftIds: [], filteredWords: [], renderedCount: 0 };
    const picker = $('#study-word-picker');
    picker.classList.remove('study-picker-enter');
    picker.classList.add('study-picker-leave');
    setTimeout(() => { picker.classList.add('hidden'); picker.classList.remove('study-picker-leave'); }, 260);
    if ($('#view-study').classList.contains('active')) $('#bottom-nav').classList.remove('nav-hidden');
  }

  function renderWordbookList() {
    const list = $('#wordbook-list');
    list.innerHTML = '';
    const pickedIds = new Set(pickerSourceIds());
    $('#study-source-hint').textContent = '点击词书封面进入单词选择；可手动勾选任意数量，也可自动生成当日目标数量。';
    const all = [{ id: 'vocab-source', name: '生词本', icon: '🔗', cover: '生词', count: App.vocab.length, builtin: true }].concat(App.wordbooks.map((wb) => ({
      id: wb.id, name: wb.name, icon: wb.builtin ? '🎓' : '📖', cover: wb.cover || '自定义',
      count: App.words.filter((w) => w.bookId === wb.id).length, builtin: !!wb.builtin,
    })));
    all.forEach((src) => {
      const sourceWords = new Set(pickerWords(src.id).map((w) => w.id));
      const pickedCount = Array.from(pickedIds).filter((id) => sourceWords.has(id)).length;
      const stats = getSourceStats(src.id);
      const item = document.createElement('div');
      item.className = 'wordbook-item'; item.dataset.sourceId = src.id;
      item.innerHTML = `<div class="wb-cover ${src.builtin ? 'wb-cover-preset' : 'wb-cover-custom'}"><span>${esc(src.cover)}</span><i>${src.icon}</i></div>` +
        `<div class="wb-info"><div class="wb-name">${esc(src.name)}</div><div class="wb-subtitle">${src.builtin ? '预设词书' : '导入词书'}</div><div class="wb-progress-line"><strong class="wb-count">${pickedCount}/${src.count}</strong><span class="wb-stats">待学 ${stats.fresh} · 已学 ${stats.learned} · 到期 ${stats.due}</span></div></div>` +
        `<span class="wb-open">›</span>`;
      item.addEventListener('click', () => openWordPicker(src.id));
      list.appendChild(item);
    });
    App.wordbooks.filter((wb) => !wb.builtin).forEach((wb) => {
      const item = Array.from(list.children).find((el) => el.dataset.sourceId === wb.id);
      if (!item) return;
      const del = document.createElement('button');
      del.className = 'wb-del'; del.textContent = '🗑️'; del.title = '删除词书';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        showConfirmDialog(`确定删除词书「${wb.name}」吗？词书单词将从词库移除。`, async () => {
          await idbDel('wordbooks', wb.id);
          const wids = App.words.filter((w) => w.bookId === wb.id).map((w) => w.id);
          for (const wid of wids) await idbDel('words', wid);
          if (Array.isArray(App.settings.studySources)) {
            App.settings.studySources = App.settings.studySources.filter((id) => id !== wb.id);
            await idbPut('settings', { key: 'settings', ...App.settings });
          }
          await loadStudyData();
          renderWordbookList(); renderStudyOverview(); toast('已删除词书');
        });
      });
      item.appendChild(del);
    });
  }

  function renderMasteredList() {
    const list = $('#study-mastered-list');
    if (!list) return;
    const mastered = getStudyWords(true).filter(isWordMastered);
    list.innerHTML = '';
    $('#study-mastered-empty').classList.toggle('hidden', mastered.length > 0);
    mastered.forEach((w) => {
      const item = document.createElement('div');
      item.className = 'mastered-word-item';
      item.innerHTML = `<div><strong>${esc(w.word)}</strong><span class="mastered-word-source">${esc(sourceLabel(w.bookId === 'vocab' ? 'vocab-source' : w.bookId))}</span><div class="mastered-word-meaning">${esc(compactMeaningText(w.meaning) || '暂无释义')}</div></div>` +
        `<div class="mastered-word-actions"><button class="btn btn-ghost unmaster-word">恢复复习</button><button class="btn btn-ghost remove-mastered-word">移出</button></div>`;
      item.querySelector('.unmaster-word').addEventListener('click', async () => {
        const st = stateForWord(w.id); st.status = 'learning'; st.nextReview = todayKey(); st.masteredAt = null; st.interval = 1; st.streak = 0;
        await idbPut('wordState', st);
        App.wordStates[w.id] = st;
        if (w.bookId === 'vocab') {
          const v = App.vocab.find((x) => x.word.toLowerCase() === w.word.toLowerCase());
          if (v && v.mastered) { v.mastered = false; await idbPut('vocab', v); }
        }
        renderMasteredList(); renderStudyOverview(); toast(`已恢复「${w.word}」复习`);
      });
      item.querySelector('.remove-mastered-word').addEventListener('click', async () => {
        if (w.bookId === 'vocab') {
          await idbDel('vocab', w.word);
        } else if (w.bookId.startsWith('builtin-')) {
          const st = stateForWord(w.id); st.status = 'ignored'; st.nextReview = null; await idbPut('wordState', st); App.wordStates[w.id] = st;
        } else {
          await idbDel('words', w.id); App.words = App.words.filter((x) => x.id !== w.id); await idbDel('wordState', w.id); delete App.wordStates[w.id];
        }
        await loadVocab(); renderMasteredList(); renderWordbookList(); renderStudyOverview(); toast(`已移出「${w.word}」`);
      });
      list.appendChild(item);
    });
  }

  // 词书导入解析：每行一词，tab 分隔 word\t音标\t释义\t例句（缺失可空）；兼容 "word 释义" 空格格式
  function parseWordbookText(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const words = [];
    for (const line of lines) {
      if (line.startsWith('#') || line.startsWith('//')) continue;
      const parts = line.split('\t');
      if (parts.length >= 2) {
        words.push({ word: parts[0].trim(), phonetic: (parts[1] || '').trim(), meaning: (parts[2] || '').trim(), example: (parts[3] || '').trim() });
      } else if (/^[A-Za-z][A-Za-z'’-]*$/.test(line)) {
        // 允许开放词表只提供单词，音标/释义由运行时词典补全。
        words.push({ word: line, phonetic: '', meaning: '', example: '' });
      } else {
        const m = line.match(/^([A-Za-z][A-Za-z'’-]*)\s+(.+)$/);
        if (m) words.push({ word: m[1], phonetic: '', meaning: m[2].trim(), example: '' });
      }
    }
    return words.filter((w) => /^[A-Za-z]/.test(w.word));
  }

  // 有道补全（音标/释义/例句）——只走本地代理 /api/dict（国内直连），绝不依赖海外服务
  function extractMeaning(w) {
    const items = [];
    (w.trs || []).forEach((tr) => (tr.tr || []).forEach((t) => ((t.l && t.l.i) || []).forEach((i) => items.push(String(i)))));
    return compactMeaningText(items.join('；'));
  }

  // 背词卡只需要快速回忆提示，不展示词典的完整长释义。
  // 规则：最多保留两个词性，每个词性最多两个释义，并限制每个词性一行的长度。
  function compactMeaningText(value) {
    const raw = String(value || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw) return '';

    const groups = [];
    let current = null;
    const loose = [];
    raw.split(/[；;\n]+/).map((part) => part.trim()).filter(Boolean).forEach((part) => {
      const match = part.match(/^([a-z]{1,8})\.\s*(.*)$/i);
      if (match) {
        current = { pos: match[1].toLowerCase(), items: [] };
        groups.push(current);
        if (match[2]) current.items.push(match[2].trim());
      } else if (current) {
        current.items.push(part);
      } else {
        loose.push(part);
      }
    });

    const shorten = (text, max = 42) => {
      const chars = Array.from(text);
      return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
    };
    if (groups.length) {
      return groups.slice(0, 2).map((group) => {
        const items = group.items.filter(Boolean).slice(0, 2);
        return shorten(`${group.pos}. ${items.join('；')}`);
      }).join('\n');
    }
    return shorten(loose.slice(0, 3).join('；'));
  }
  function extractExample(data) {
    const sents = data.blng_sents_part && data.blng_sents_part['sentence-pair'];
    if (sents && sents.length) {
      const s = sents[0];
      return (s.sentence || '') + (s['sentence-translation'] ? '\n' + s['sentence-translation'] : '');
    }
    return '';
  }
  async function enrichWordData(w) {
    if (w.meaning && w.phonetic) return;
    try {
      const resp = await fetch('/api/dict?q=' + encodeURIComponent(w.word));
      if (!resp.ok) return;
      const data = await resp.json();
      const e = data.ec && data.ec.word && data.ec.word[0];
      if (e) {
        if (!w.phonetic) w.phonetic = e.ukphone || e.usphone || '';
        if (!w.meaning) w.meaning = extractMeaning(e);
        if (!w.example) w.example = extractExample(data);
        await idbPut('words', w);
      }
    } catch (err) { /* 网络失败静默：保留原始内容 */ }
  }

  async function importWordbookFile(file) {
    const text = await readFileAsText(file, MAX_WORDBOOK_BYTES);
    if (!text) { toast('读取词书失败或文件超过 8 MB'); return; }
    const words = parseWordbookText(text);
    if (!words.length) { toast('未解析到有效单词（每行：单词、音标、释义、例句，Tab 分隔）'); return; }
    if (words.length > MAX_WORDBOOK_WORDS) {
      toast('词书最多支持 100000 个单词');
      return;
    }
    const wb = { id: uid(), name: file.name.replace(/\.(txt|csv)$/i, ''), createdAt: Date.now(), builtin: false, source: 'user' };
    await idbPut('wordbooks', wb);
    App.wordbooks.push(wb);
    if (Array.isArray(App.settings.studySources) && App.settings.studySources.length) {
      App.settings.studySources = Array.from(new Set(App.settings.studySources.concat(wb.id)));
      await idbPut('settings', { key: 'settings', ...App.settings });
    }
    let added = 0;
    const knownWords = new Set(App.words.map((x) => x.word.toLowerCase()));
    for (const w of words) {
      const key = w.word.toLowerCase();
      if (knownWords.has(key)) continue; // 词库去重
      const rec = { id: uid(), word: w.word, phonetic: w.phonetic, meaning: w.meaning, example: w.example, bookId: wb.id };
      await idbPut('words', rec);
      App.words.push(rec);
      knownWords.add(key);
      added++;
      enrichWordData(rec); // 有道补全（异步，不阻塞导入）
    }
    await loadStudyData();
    renderWordbookList();
    renderStudyOverview();
    toast(`词书「${wb.name}」导入 ${added} 词（缺音标/释义的将自动用有道补全）`);
  }

  function readFileAsText(file, maxBytes = MAX_WORDBOOK_BYTES) {
    return new Promise((resolve) => {
      if (!file || (Number.isFinite(file.size) && file.size > maxBytes)) {
        resolve(null);
        return;
      }
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsText(file, 'utf-8');
    });
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(name) {
    $$('.view').forEach((v) => v.classList.remove('active', 'view-in'));
    const target = $('#' + name);
    target.classList.add('active');
    const nav = $('#bottom-nav');
    const navVisible = name === 'view-library' || name === 'view-study';
    nav.classList.toggle('nav-hidden', !navVisible);
    document.body.classList.toggle('bottom-nav-hidden', !navVisible);
    // 强制 reflow 后触发入场动画
    void target.offsetWidth;
    target.classList.add('view-in');
  }

  // 带关闭动画的隐藏：先播 .closing 再 hidden
  function closeWithAnim(el) {
    if (el.classList.contains('hidden')) return;
    if (el.classList.contains('closing')) return; // 已在关闭动画中，忽略重复触发（防"弹一下"）
    el.classList.add('closing');
    // 设置面板关闭时联动隐藏遮罩
    if (el.id === 'settings-panel') {
      const mask = $('#sheet-mask');
      mask.classList.add('closing');
      setTimeout(() => mask.classList.add('hidden'), 280);
    }
    setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('closing');
    }, 280);
  }
  function openWithAnim(el) {
    el.classList.remove('hidden', 'closing');
    void el.offsetWidth;
    // 设置面板打开时联动显示遮罩
    if (el.id === 'settings-panel') {
      const mask = $('#sheet-mask');
      mask.classList.remove('hidden', 'closing');
      void mask.offsetWidth;
    }
  }

  function pulseReaderBoundary(back) {
    const container = $('#reader-container');
    if (!container) return;
    const cls = back ? 'reader-edge-prev' : 'reader-edge-next';
    container.classList.remove('reader-edge-prev', 'reader-edge-next');
    void container.offsetWidth;
    container.classList.add(cls);
    setTimeout(() => container.classList.remove(cls), 250);
  }

  function readerAtBoundary(rendition, back) {
    try {
      const location = rendition.currentLocation();
      return !!(location && ((back && location.atStart) || (!back && location.atEnd)));
    } catch (e) { return false; }
  }

  // 轻量页面滑动：不创建快照，不重建 iframe。
  function triggerPageSlide(back) {
    const c = $('#reader-container');
    c.classList.remove('page-slide', 'page-slide-back');
    void c.offsetWidth;
    c.classList.add(back ? 'page-slide-back' : 'page-slide');
    return Promise.resolve(true);
  }

  // 所有点击/滑动/键盘翻页统一从这里进入，避免动画期间重复调用 next/prev。
  async function navigateReader(back, rendition) {
    rendition = rendition || (App.current && App.current.rendition);
    if (!rendition || App.settings.flow === 'scrolled-doc' || readerNavigationBusy) return false;
    if (readerAtBoundary(rendition, back)) {
      pulseReaderBoundary(back);
      return false;
    }

    readerNavigationBusy = true;
    try {
      await triggerPageSlide(back);
      await (back ? rendition.prev() : rendition.next());
      return true;
    } catch (e) {
      return false;
    } finally {
      readerNavigationBusy = false;
    }
  }

  function closeToc() {
    closeWithAnim($('#toc-drawer'));
    closeWithAnim($('#drawer-mask'));
  }

  // 返回上一级（Android 系统返回键/全面屏手势回调）
  // 返回 true = 已消费（留在 app 内），false = 无上一级（允许退出）
  function handleBack() {
    // 0. 书架弹窗/菜单（输入、确认、长按菜单、主题弹窗）→ 逐级关闭
    if (!$('#lib-menu').classList.contains('hidden')) {
      hideLibMenu();
      return true;
    }
    if (!$('#input-dialog').classList.contains('hidden')) {
      hideInputDialog();
      return true;
    }
    if (!$('#confirm-dialog').classList.contains('hidden')) {
      hideConfirmDialog();
      return true;
    }
    if (!$('#theme-popup').classList.contains('hidden')) {
      closeWithAnim($('#theme-popup'));
      return true;
    }
    // 1. 查词浮窗 → 关闭
    if (!$('#dict-popup').classList.contains('hidden')) {
      closeDictPopup();
      return true;
    }
    // 2. 设置面板 → 关闭
    if (!$('#settings-panel').classList.contains('hidden')) {
      closeWithAnim($('#settings-panel'));
      return true;
    }
    // 3. 目录抽屉 → 关闭
    if (!$('#toc-drawer').classList.contains('hidden')) {
      closeToc();
      return true;
    }
    // 4. 阅读器 → 返回书架
    if (document.getElementById('view-reader').classList.contains('active')) {
      cleanupReaderUI();
      if (App.current && App.current.rendition) {
        try { App.current.book.destroy(); } catch (e) {}
        App.current = null;
      }
      switchView('view-library');
      return true;
    }
    // 5. 生词本 → 返回书架
    if (document.getElementById('view-vocab').classList.contains('active')) {
      switchView('view-library');
      return true;
    }
    // 5.5 书架合集模式 → 返回全部
    if (document.getElementById('view-library').classList.contains('active') && App.libState !== 'all') {
      exitCollection();
      return true;
    }
    // 5.6 背词会话 → 背词主页（保留进度）
    if (document.getElementById('view-study-session').classList.contains('active')) {
      App.studySession = null;
      switchView('view-study');
      renderStudyOverview();
      renderWordbookList();
      return true;
    }
    // 5.7 背词主页 → 无上一级，允许退出
    if (document.getElementById('view-study').classList.contains('active')) {
      return false;
    }
    // 6. 书架首页 → 无上一级，允许退出
    return false;
  }

  // 暴露给 Android 壳（onBackPressed 通过 evaluateJavascript 调用）
  window.__handleBack = handleBack;

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    // 书架主题设置：按钮打开弹窗，三选一应用
    $('#btn-theme-lib').addEventListener('click', () => {
      syncThemePopupUI();
      openWithAnim($('#theme-popup'));
    });
    $('#theme-popup-close').addEventListener('click', () => closeWithAnim($('#theme-popup')));
    $$('#seg-theme-lib .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const theme = btn.dataset.theme;
        setTheme(theme);
        syncThemePopupUI(); // 立即更新按钮图标（☀/📜/🌙）
        closeWithAnim($('#theme-popup'));
        toast('已切换主题');
      });
    });
    $('#theme-popup').addEventListener('click', (e) => {
      if (e.target === $('#theme-popup')) closeWithAnim($('#theme-popup'));
    });

    // 书架
    $('#btn-import').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', async (e) => {
      const files = [...e.target.files].filter((f) => f.name.toLowerCase().endsWith('.epub'));
      if (!files.length) { toast('请选择 EPUB 文件'); return; }
      toast(`正在导入 ${files.length} 本书…`);
      for (const f of files) {
        const data = await readFileAsBuffer(f, MAX_BOOK_BYTES);
        if (!data) { toast(`读取失败或文件超过 64 MB：${f.name}`); continue; }
        await importBookBuffer(data, f.name.replace(/\.epub$/i, ''), '');
      }
      await loadLibrary();
      e.target.value = '';
      toast('导入完成');
    });

    // 合集：返回全部
    $('#btn-collection-back').addEventListener('click', exitCollection);

    // 书架长按菜单：点外部关闭（若点的是菜单锚点卡，吞掉该次 click 防误开书/误入合集）
    document.addEventListener('pointerdown', (e) => {
      const menu = $('#lib-menu');
      if (menu.classList.contains('hidden')) return;
      if (menu.contains(e.target)) return;
      const anchor = libMenuAnchor;
      hideLibMenu();
      libMenuAnchor = null;
      if (anchor && anchor.contains(e.target)) {
        anchor.dataset.suppressClick = '1';
      }
    });
    // 弹窗：遮罩点击关闭输入框；确认框打开时点遮罩不关闭（防误触删除流程）
    $('#dialog-mask').addEventListener('click', (e) => {
      if (e.target !== $('#dialog-mask')) return;
      if (!$('#confirm-dialog').classList.contains('hidden')) return;
      hideInputDialog();
    });
    $('#dialog-cancel').addEventListener('click', hideInputDialog);
    $('#dialog-ok').addEventListener('click', () => {
      const fn = dialogOnOk;
      hideInputDialog();
      if (fn) fn($('#dialog-input').value);
    });
    $('#dialog-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const fn = dialogOnOk;
        hideInputDialog();
        if (fn) fn($('#dialog-input').value);
      }
    });
    $('#confirm-cancel').addEventListener('click', () => { const fn = confirmOnCancel; hideConfirmDialog(); if (fn) fn(); });
    $('#confirm-ok').addEventListener('click', () => {
      const fn = confirmOnOk;
      hideConfirmDialog();
      if (fn) fn();
    });

    $('#btn-vocab').addEventListener('click', () => { loadVocab(); switchView('view-vocab'); });
    $('#btn-vocab-back').addEventListener('click', () => switchView('view-library'));

    // 阅读器工具栏
    $('#btn-back').addEventListener('click', () => {
      cleanupReaderUI();
      if (App.current && App.current.rendition) {
        try { App.current.book.destroy(); } catch (e) {}
        App.current = null;
      }
      switchView('view-library');
    });
    $('#btn-toc').addEventListener('click', () => {
      openWithAnim($('#toc-drawer'));
      openWithAnim($('#drawer-mask'));
    });
    $('#btn-toc-close').addEventListener('click', closeToc);
    $('#drawer-mask').addEventListener('click', closeToc);

    // 设置面板遮罩：点击外部关闭面板
    $('#sheet-mask').addEventListener('click', () => closeWithAnim($('#settings-panel')));

    // 设置面板
    $('#btn-settings').addEventListener('click', () => {
      // 先关掉查词弹窗（避免弹窗遮挡设置面板）
      if (!$('#dict-popup').classList.contains('hidden')) {
        closeDictPopup();
      }
      syncSettingsUI();
      renderCustomFontList();
      openWithAnim($('#settings-panel'));
    });
    $('#settings-close').addEventListener('click', () => closeWithAnim($('#settings-panel')));

    // 主题分段按钮
    $$('#seg-theme .seg-btn').forEach((b) => {
      b.addEventListener('click', () => setTheme(b.dataset.theme));
    });
    // 字体：下拉选择 + 同行导入
    $('#font-select').addEventListener('change', (e) => setFont(e.target.value));
    $('#btn-font-import').addEventListener('click', () => $('#font-input').click());
    $('#font-input').addEventListener('change', async (e) => { const files = [...e.target.files]; if (files.length) await importCustomFonts(files); e.target.value = ''; });
    // 字号步进器
    $('#font-minus').addEventListener('click', () => changeFontSize(-2));
    $('#font-plus').addEventListener('click', () => changeFontSize(2));
    // 行距步进器
    $('#lh-minus').addEventListener('click', () => changeLineHeight(-0.2));
    $('#lh-plus').addEventListener('click', () => changeLineHeight(0.2));
    // 翻页方式分段按钮
    $$('#seg-flow .seg-btn').forEach((b) => {
      b.addEventListener('click', () => setFlow(b.dataset.flow));
    });
    // 底部进度显示
    $$('#seg-progress .seg-btn').forEach((b) => {
      b.addEventListener('click', () => setProgressMode(b.dataset.progress));
    });

    // 查词浮窗
    $('#dict-close').addEventListener('click', closeDictPopup);

    // 自定义选区菜单（复制/划线/单词翻译/句子翻译）
    bindSelMenuEvents();

    // 生词本导出
    $('#btn-export').addEventListener('click', exportVocab);

    /* ---------------- 背词模块事件 ---------------- */
    // 底部导航切换
    const switchModule = async (module) => {
      $('#nav-read').classList.toggle('active', module === 'read');
      $('#nav-study').classList.toggle('active', module === 'study');
      if (module === 'study') {
        await loadStudyData();
        await loadVocab(); // 同步生词本内存（联动词库实时）
        switchView('view-study');
        switchStudyPanel(App.studyPanel || 'overview');
        renderStudyOverview();
        renderWordbookList();
      } else {
        switchView('view-library');
      }
    };
    $('#nav-read').addEventListener('click', () => switchModule('read'));
    $('#nav-study').addEventListener('click', () => switchModule('study'));
    // 每日目标设置
    $('#btn-study-target').addEventListener('click', () => {
      showInputDialog('每日背词目标', '每日目标单词数', String(App.settings.dailyTarget || 20), async (val) => {
        const n = parseInt(val, 10);
        if (!n || n < 1 || n > 500) { toast('请输入 1-500 之间的数字'); return; }
        App.settings.dailyTarget = n;
        if (App.dailyLog) { App.dailyLog.target = n; await idbPut('dailyLog', App.dailyLog); }
        await idbPut('settings', { key: 'settings', ...App.settings });
        renderStudyOverview();
        toast(`每日目标设为 ${n} 词`);
      });
    });
    $('#btn-study-reset').addEventListener('click', resetStudyProgress);
    $('#btn-study-prev').addEventListener('click', previousStudyCard);
    // 开始/继续背词、今日复习、明日预习
    $('#btn-study-start').addEventListener('click', () => startStudySession('today'));
    $('#btn-study-review').addEventListener('click', () => startStudySession('review'));
    $('#btn-study-tomorrow').addEventListener('click', () => startStudySession('tomorrow'));
    $$('#study-panel-tabs .study-panel-tab').forEach((b) => b.addEventListener('click', () => switchStudyPanel(b.dataset.studyPanel)));
    $('#btn-study-selected').addEventListener('click', () => toggleStudyInlinePanel('study-selected-panel', renderSelectedList));
    $('#study-selected-close').addEventListener('click', () => toggleStudyInlinePanel('study-selected-panel'));
    $('#btn-study-mastered').addEventListener('click', () => toggleStudyInlinePanel('study-mastered-panel', renderMasteredList));
    $('#study-mastered-close').addEventListener('click', () => toggleStudyInlinePanel('study-mastered-panel'));
    $('#study-word-picker-close').addEventListener('click', closeWordPicker);
    $('#study-word-confirm').addEventListener('click', commitPickerSelection);
    $('#study-word-auto').addEventListener('click', autoPickCurrentWordbook);
    $('#study-word-clear').addEventListener('click', clearCurrentWordbookSelection);
    $('#study-word-picker-list').addEventListener('change', handlePickerWordChange);
    $('#study-word-picker-list').addEventListener('scroll', (e) => {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 260) appendPickerWords();
    });
    $('#study-word-search').addEventListener('input', (e) => { App.studyPicker.query = e.target.value; renderPickerWords(); });
    // 会话退出
    $('#btn-study-exit').addEventListener('click', () => {
      App.studySession = null;
      switchView('view-study');
      renderStudyOverview();
      renderWordbookList();
    });
    // 背词卡：先主动回忆，再显示释义；卡片正文点击也可揭示
    $('#study-reveal').addEventListener('click', revealStudyCard);
    $('#study-card').addEventListener('click', (e) => {
      if (e.target.closest('#study-card-speak')) return;
      if (App.studySession && !App.studySession.revealed) revealStudyCard();
    });
    // 记忆反馈四档：忘记 / 模糊 / 认识 / 熟知
    $('#btn-study-forgot').addEventListener('click', () => studyAnswer('forgot'));
    $('#btn-study-fuzzy').addEventListener('click', () => studyAnswer('fuzzy'));
    $('#btn-study-known').addEventListener('click', () => studyAnswer('known'));
    $('#btn-study-master').addEventListener('click', () => studyAnswer('master'));
    // 拼写巩固
    $('#study-spell-check').addEventListener('click', submitSpelling);
    $('#study-spell-show').addEventListener('click', showSpellingAnswer);
    $('#study-spell-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitSpelling(); } });
    // 词书导入
    $('#btn-study-import').addEventListener('click', () => $('#wordbook-input').click());
    $('#wordbook-input').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      for (const f of files) await importWordbookFile(f);
      e.target.value = '';
    });

    // 键盘：阅读器中 Esc 关浮窗/设置/目录；左右方向键翻页
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#dict-popup').classList.contains('hidden')) {
          closeDictPopup();
        } else if (!$('#settings-panel').classList.contains('hidden')) {
          closeWithAnim($('#settings-panel'));
        } else if (!$('#toc-drawer').classList.contains('hidden')) {
          closeToc();
        }
      }
      // 背词会话快捷键：认知阶段空格揭示，拼写阶段回车提交
      if (document.getElementById('view-study-session').classList.contains('active')) {
        if (App.studySession && App.studySession.phase === 'spelling' && e.key === 'Enter') {
          e.preventDefault(); submitSpelling(); return;
        }
        if (App.studySession && App.studySession.phase === 'recognition' && (e.key === ' ' || e.key === 'Enter')) {
          if (!App.studySession.revealed) revealStudyCard();
          e.preventDefault(); return;
        }
      }
      if (!document.getElementById('view-reader').classList.contains('active')) return;
      if (!App.current || !App.current.rendition) return;
      if (e.key === 'ArrowRight') { navigateReader(false, App.current.rendition); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { navigateReader(true, App.current.rendition); e.preventDefault(); }
    });
  }

  /* ---------------- 启动 ---------------- */
  async function init() {
    App.db = await openDB();
    bindEvents();
    await loadVocab();
    await loadLibrary();
    await ensureBuiltinBooks();
    await loadLibrary(); // 内置书导入后刷新
    // 加载设置并确保预设词书已落库
    const s = await idbGet('settings', 'settings');
    if (s) App.settings = { ...App.settings, ...s };
    if (!Array.isArray(App.settings.customFonts)) App.settings.customFonts = [];
    if (!['paginated', 'scrolled-doc'].includes(App.settings.flow)) {
      App.settings.flow = 'paginated';
      await idbPut('settings', { key: 'settings', ...App.settings });
    }
    if (!['bar', 'page', 'chapter'].includes(App.settings.progressMode)) App.settings.progressMode = 'bar';
    App.settings.pageAnim = 'slide';
    await ensureBuiltinWordbooks();
    applyThemeToUI();
    syncThemePopupUI();
  }

  init().catch((e) => {
    console.error('启动失败', e);
    toast('启动失败: ' + e.message);
  });

  // 调试句柄（e2e 测试用）
  window.__App = App;
})();
