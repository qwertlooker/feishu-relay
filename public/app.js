const WEB_VERSION = document.querySelector('meta[name="app-version"]')?.content || 'unknown';
const BASE_DOCUMENT_TITLE = document.title;

const S = {
  url: localStorage.getItem('relayUrl') || location.origin,
  token: localStorage.getItem('relayToken') || '',
  theme: 'system',
  convs: [],
  msgs: {},
  msgEls: {},
  cur: null,
  es: null,
  connected: false,
  contextMenuTarget: null,
  newMsgCount: 0,
  isNearBottom: true,
  drafts: {},
  replyTarget: null,
  uploading: false,
  searchResults: [],
  searchTimer: null,
  searchRequestId: 0,
  serverVersion: null,
};

// 从服务端加载数据
async function loadFromServer() {
  console.log('[前端] loadFromServer() 被调用');
  if (!S.token) {
    console.warn('[前端] loadFromServer() 没有 token，跳过');
    return;
  }
  try {
    console.log('[前端] 从服务端加载数据...');
    const [convsRes, draftsRes, settingsRes] = await Promise.all([
      fetch(`${S.url}/api/convs?token=${encodeURIComponent(S.token)}`),
      fetch(`${S.url}/api/drafts?token=${encodeURIComponent(S.token)}`),
      fetch(`${S.url}/api/settings?token=${encodeURIComponent(S.token)}`),
    ]);
    const convsData = await convsRes.json();
    const draftsData = await draftsRes.json();
    const settingsData = await settingsRes.json();
    console.log('[前端] 会话列表:', convsData);
    console.log('[前端] 草稿:', draftsData);
    console.log('[前端] 设置:', settingsData);
    if (convsData.ok) S.convs = convsData.data;
    if (draftsData.ok) S.drafts = draftsData.data;
    if (settingsData.ok) S.theme = settingsData.data.theme || 'system';
    console.log('[前端] 数据加载完成，S.convs=', S.convs, 'S.drafts=', S.drafts, 'S.theme=', S.theme);
  } catch (err) {
    console.error('[前端] 加载服务端数据失败:', err);
  }
}

document.getElementById('cfgUrl').value = S.url;
document.getElementById('cfgToken').value = S.token;
document.getElementById('cfgChatId').value = localStorage.getItem('defaultChatId') || '';
document.getElementById('cfgTheme').value = S.theme;
document.getElementById('webVersion').textContent = `v${WEB_VERSION}`;

// 初始化：先加载服务端数据，再初始化界面
async function init() {
  await loadFromServer();
  document.getElementById('cfgTheme').value = S.theme;
  initTheme();
  initEmojiPicker();
  renderConvs();
  if (S.token) connect();
}
init();

// Close context menu on click elsewhere
document.addEventListener('click', () => {
  document.getElementById('contextMenu').style.display = 'none';
});

// Close emoji picker on click elsewhere
document.addEventListener('click', (e) => {
  if (!e.target.closest('.emoji-picker') && !e.target.closest('[onclick="toggleEmojiPicker()"]')) {
    document.getElementById('emojiPicker').classList.remove('visible');
  }
});

// Scroll detection for scroll-to-bottom button
const msgsContainer = document.getElementById('msgs');
if (msgsContainer) {
  msgsContainer.addEventListener('scroll', () => {
    const threshold = 100;
    const isBottom = msgsContainer.scrollHeight - msgsContainer.scrollTop - msgsContainer.clientHeight < threshold;
    S.isNearBottom = isBottom;
    if (isBottom) {
      document.getElementById('scrollToBottom').classList.remove('visible');
      S.newMsgCount = 0;
      document.getElementById('newMsgCount').style.display = 'none';
    }
  });
}

function initTheme() {
  const stored = S.theme;
  if (stored === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
  } else {
    document.documentElement.dataset.theme = stored;
  }
  updateThemeBtn();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (S.theme === 'system') {
      document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
      updateThemeBtn();
    }
  });
}

function updateThemeBtn() {
  const btn = document.getElementById('themeBtn');
  const theme = document.documentElement.dataset.theme;
  btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}

async function saveSettings() {
  console.log('[前端] saveSettings() 被调用，主题:', S.theme);
  if (!S.token) {
    console.warn('[前端] saveSettings() 没有 token，跳过');
    return;
  }
  try {
    const res = await fetch(`${S.url}/api/settings?token=${encodeURIComponent(S.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': S.token },
      body: JSON.stringify({ theme: S.theme }),
    });
    const data = await res.json();
    console.log('[前端] saveSettings() 返回:', data);
  } catch (err) {
    console.error('[前端] 保存设置失败:', err);
  }
}

async function cycleTheme() {
  const themes = ['system', 'light', 'dark'];
  const idx = themes.indexOf(S.theme);
  S.theme = themes[(idx + 1) % themes.length];
  await saveSettings();
  document.getElementById('cfgTheme').value = S.theme;
  initTheme();
  toast(`主题: ${S.theme === 'system' ? '跟随系统' : S.theme === 'light' ? '白天' : '黑夜'}`, 'info');
}

// ── SSE ───────────────────────────────────────────────────────
async function connect() {
  if (!S.token) {
    toast('请先配置 API Token', 'err');
    return;
  }
  
  // 连接前先从服务端加载数据
  await loadFromServer();
  document.getElementById('cfgTheme').value = S.theme;
  initTheme();
  renderConvs();
  
  if (S.es) { try { S.es.close(); } catch{} }
  const es = new EventSource(`${S.url}/api/events?token=${encodeURIComponent(S.token)}`);
  S.es = es;

  es.addEventListener('connected', event => {
    setStatus(true);
    try { updateVersionState(JSON.parse(event.data).version); } catch { checkServerVersion(); }
  });
  es.addEventListener('message', e => onMsg(JSON.parse(e.data)).catch(console.error));
  es.addEventListener('history', e => {
    const msgs = JSON.parse(e.data);
    (async () => {
      for (const m of msgs) {
        await onMsg(m, true);
      }
    })().catch(console.error);
  });
  es.addEventListener('read', e => onReadReceipt(JSON.parse(e.data)));
  es.addEventListener('message_deleted', e => onMessageDeleted(JSON.parse(e.data)));
  es.onerror = () => { setStatus(false); setTimeout(connect, 3000); };
}

function setStatus(ok) {
  S.connected = ok;
  document.getElementById('dot').className = 'dot' + (ok ? ' on' : '');
  document.getElementById('statusTx').textContent = ok ? '已连接' : '重连中…';
}

function updateVersionState(serverVersion) {
  if (serverVersion) S.serverVersion = String(serverVersion);
  document.getElementById('serverVersion').textContent = S.serverVersion ? `v${S.serverVersion}` : '未知';
  const mismatch = Boolean(S.serverVersion && S.serverVersion !== WEB_VERSION);
  document.getElementById('versionAlert').classList.toggle('visible', mismatch);
  document.title = mismatch ? `【有新版本，请刷新】${BASE_DOCUMENT_TITLE}` : BASE_DOCUMENT_TITLE;
}

async function checkServerVersion() {
  document.getElementById('serverVersion').textContent = '查询中…';
  try {
    const response = await fetch(`${S.url}/api/health?_=${Date.now()}`, { cache: 'no-store' });
    const data = await parseApiResponse(response);
    updateVersionState(data.version);
  } catch (error) {
    document.getElementById('serverVersion').textContent = '查询失败';
  }
}

function refreshForUpdate() {
  window.location.reload();
}

// ── 已读回执处理 ──────────────────────────────────────────────
function onReadReceipt(data) {
  (data.messageIds || []).forEach(msgId => {
    const el = S.msgEls[msgId];
    if (!el) return;
    const tick = el.querySelector('.read-tick');
    if (tick) {
      tick.textContent = '✓✓';
      tick.classList.remove('pending');
      tick.title = `已读 ${data.readerId || ''}`;
    }
  });
}

function onMessageDeleted(data) {
  const messageId = data.messageId;
  Object.values(S.msgs).forEach(messages => {
    const message = messages.find(item => item.id === messageId);
    if (message) {
      message.deleted = true;
      message.content = { text: '[消息已撤回]' };
    }
  });
  const el = S.msgEls[messageId];
  if (el) {
    el.classList.add('withdrawn');
    const bubble = el.querySelector('.bubble');
    if (bubble) bubble.innerHTML = esc('[消息已撤回]');
  }
  if (S.replyTarget?.id === messageId) cancelReply();
}

// ── 消息处理 ──────────────────────────────────────────────────
async function onMsg(msg, isHistory = false) {
  if (!msg.chatId) return;
  if (!S.msgs[msg.chatId]) S.msgs[msg.chatId] = [];
  if (msg.id && S.msgs[msg.chatId].find(m => m.id === msg.id)) return;
  S.msgs[msg.chatId].push(msg);

  let conv = S.convs.find(c => c.id === msg.chatId);
  if (!conv) {
    conv = {
      id: msg.chatId,
      name: msg.chatType === 'p2p' ? '用户 ' + (msg.senderId || '').slice(-6) : '群聊 ' + msg.chatId.slice(-6),
      type: msg.chatType || 'group',
      unread: 0,
    };
    S.convs.push(conv);
    await saveConvs();
  }
  if (!isHistory && msg.chatId !== S.cur) {
    conv.unread = (conv.unread || 0) + 1;
    await saveConvs();
  }
  renderConvs();
  if (msg.chatId === S.cur) {
    appendMsg(msg);
    if (isHistory) {
      scrollBottom();
    } else if (S.isNearBottom) {
      scrollBottom();
    } else {
      S.newMsgCount++;
      document.getElementById('newMsgCount').textContent = S.newMsgCount;
      document.getElementById('newMsgCount').style.display = 'block';
      document.getElementById('scrollToBottom').classList.add('visible');
    }
  }
}

// ── Conversations ─────────────────────────────────────────────
function renderConvs() {
  document.getElementById('convList').innerHTML = S.convs.map(c => `
    <div class="conv-item${c.id===S.cur?' active':''}" onclick="selectConv('${c.id}')" oncontextmenu="showConvContextMenu(event, '${c.id}')">
      <div class="avatar" style="background:${strColor(c.id)}">${c.name[0]}</div>
      <div class="conv-meta">
        <div class="conv-name">${esc(c.name)}</div>
        <div class="conv-sub">${c.type==='p2p'?'私聊':'群聊'}</div>
      </div>
      ${c.unread ? `<div class="badge">${c.unread}</div>` : ''}
    </div>`).join('');
  document.getElementById('convCount').textContent = `(${S.convs.length})`;
}

// ── 搜索功能 ──────────────────────────────────────────────────
function toggleSearch(force) {
  const box = document.getElementById('searchBox');
  const visible = typeof force === 'boolean' ? force : !box.classList.contains('visible');
  box.classList.toggle('visible', visible);
  if (visible) {
    document.getElementById('searchInput').focus();
  } else {
    closeSearch();
  }
}

function closeSearch() {
  const box = document.getElementById('searchBox');
  box.classList.remove('visible');
  clearTimeout(S.searchTimer);
  S.searchRequestId++;
  S.searchResults = [];
  document.getElementById('searchInput').value = '';
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('searchStatus').textContent = '输入关键词搜索最近保存的消息';
}

function searchMessages(query) {
  clearTimeout(S.searchTimer);
  const normalized = String(query || '').trim();
  const status = document.getElementById('searchStatus');
  const results = document.getElementById('searchResults');
  const requestId = ++S.searchRequestId;
  if (!normalized) {
    S.searchResults = [];
    status.textContent = '输入关键词搜索最近保存的消息';
    results.innerHTML = '';
    return;
  }
  status.textContent = '搜索中…';
  results.innerHTML = '';
  S.searchTimer = setTimeout(() => performMessageSearch(normalized, requestId), 250);
}

function localSearchMessages(query, chatId) {
  const normalized = query.toLocaleLowerCase();
  return Object.entries(S.msgs).flatMap(([id, messages]) =>
    (chatId && id !== chatId ? [] : messages)
      .filter(message => !message.deleted && extractText(message).toLocaleLowerCase().includes(normalized))
  ).sort((a, b) => Number(b.createTime || 0) - Number(a.createTime || 0)).slice(0, 50);
}

async function performMessageSearch(query, requestId) {
  const scope = document.getElementById('searchScope').value;
  const chatId = scope === 'current' ? S.cur : '';
  const params = new URLSearchParams({ q: query, limit: '50' });
  if (chatId) params.set('chatId', chatId);
  let source = '全部已保存消息';
  try {
    const response = await fetch(`${S.url}/api/messages/search?${params}`, {
      headers: { 'x-api-key': S.token },
    });
    const data = await parseApiResponse(response);
    if (requestId !== S.searchRequestId) return;
    S.searchResults = data.data?.items || [];
  } catch (error) {
    if (requestId !== S.searchRequestId) return;
    S.searchResults = localSearchMessages(query, chatId);
    source = `仅已加载消息（${error.message}）`;
  }
  renderSearchResults(query, source);
}

function renderSearchResults(query, source) {
  const results = document.getElementById('searchResults');
  const status = document.getElementById('searchStatus');
  status.textContent = `${S.searchResults.length} 条结果 · ${source}`;
  if (!S.searchResults.length) {
    results.innerHTML = '<div class="search-empty">没有找到匹配消息</div>';
    return;
  }
  results.innerHTML = S.searchResults.map((message, index) => {
    const conversation = S.convs.find(item => item.id === message.chatId);
    return `<button type="button" class="search-result" data-search-index="${index}">
      <span class="search-result-head">
        <span class="search-result-conv">${esc(conversation?.name || message.chatId || '未知会话')}</span>
        <span class="search-result-time">${esc(fmtTime(message.createTime))}</span>
      </span>
      <span class="search-result-snippet">${highlightSearchSnippet(extractText(message), query)}</span>
    </button>`;
  }).join('');
  results.querySelectorAll('[data-search-index]').forEach(button => {
    button.addEventListener('click', () => openSearchResult(Number(button.dataset.searchIndex)));
  });
}

function highlightSearchSnippet(text, query, maxLength = 120) {
  const value = String(text || '').replace(/\s+/g, ' ');
  const lower = value.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const matchIndex = lower.indexOf(normalizedQuery);
  const start = Math.max(0, matchIndex - 35);
  const end = Math.min(value.length, Math.max(start + maxLength, matchIndex + query.length + 35));
  const snippet = value.slice(start, end);
  const localIndex = snippet.toLocaleLowerCase().indexOf(normalizedQuery);
  if (localIndex < 0) return esc(snippet);
  return `${start ? '…' : ''}${esc(snippet.slice(0, localIndex))}`
    + `<mark class="search-highlight">${esc(snippet.slice(localIndex, localIndex + query.length))}</mark>`
    + `${esc(snippet.slice(localIndex + query.length))}${end < value.length ? '…' : ''}`;
}

async function openSearchResult(index) {
  const message = S.searchResults[index];
  if (!message?.chatId) return;
  if (!S.msgs[message.chatId]) S.msgs[message.chatId] = [];
  if (!S.msgs[message.chatId].some(item => item.id && item.id === message.id)) {
    S.msgs[message.chatId].push(message);
    S.msgs[message.chatId].sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0));
  }
  if (!S.convs.some(item => item.id === message.chatId)) {
    S.convs.push({
      id: message.chatId,
      name: `会话 ${message.chatId.slice(-6)}`,
      type: message.chatType || 'group',
      receiveIdType: message.receiveIdType,
      unread: 0,
    });
    await saveConvs();
  }
  const messageId = message.id;
  closeSearch();
  await selectConv(message.chatId);
  const target = messageId ? S.msgEls[messageId] : null;
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('search-target');
    setTimeout(() => target.classList.remove('search-target'), 1600);
  }
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 右键菜单 ──────────────────────────────────────────────────
function showContextMenu(event, msgId) {
  event.preventDefault();
  S.contextMenuTarget = msgId;
  const message = (S.msgs[S.cur] || []).find(item => item.id === msgId);
  document.getElementById('replyMenuItem').style.display = message?.deleted ? 'none' : 'block';
  document.getElementById('withdrawMenuItem').style.display =
    message?.direction === 'outgoing' && !message?.deleted ? 'block' : 'none';
  const menu = document.getElementById('contextMenu');
  menu.style.display = 'block';
  menu.style.left = Math.min(event.pageX, window.innerWidth - 150) + 'px';
  menu.style.top = Math.min(event.pageY, window.innerHeight - 100) + 'px';
}

function showConvContextMenu(event, convId) {
  event.preventDefault();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.cssText = `position:fixed;left:${event.pageX}px;top:${event.pageY}px;z-index:1000;display:block;`;
  menu.innerHTML = `
    <div class="context-menu-item" onclick="renameConv('${convId}')">重命名</div>
    <div class="context-menu-item danger" onclick="deleteConv('${convId}')">删除会话</div>
  `;
  document.body.appendChild(menu);
  const closeMenu = () => { menu.remove(); document.removeEventListener('click', closeMenu); };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function copyMessageText() {
  if (!S.contextMenuTarget || !S.cur) return;
  const msg = S.msgs[S.cur].find(m => m.id === S.contextMenuTarget);
  if (msg) {
    navigator.clipboard.writeText(extractText(msg)).then(() => toast('文本已复制', 'ok'));
  }
  document.getElementById('contextMenu').style.display = 'none';
}

function copyMessageId() {
  if (!S.contextMenuTarget) return;
  navigator.clipboard.writeText(S.contextMenuTarget).then(() => toast('消息ID已复制', 'ok'));
  document.getElementById('contextMenu').style.display = 'none';
}

function replyMessage() {
  if (!S.contextMenuTarget || !S.cur) return;
  const message = (S.msgs[S.cur] || []).find(item => item.id === S.contextMenuTarget);
  if (!message || message.deleted) return;
  S.replyTarget = {
    id: message.id,
    text: extractText(message).replace(/\s+/g, ' ').slice(0, 120) || '[消息]',
  };
  document.getElementById('replyText').textContent = S.replyTarget.text;
  document.getElementById('replyBar').style.display = 'flex';
  document.getElementById('contextMenu').style.display = 'none';
  document.getElementById('input').focus();
}

function cancelReply() {
  S.replyTarget = null;
  document.getElementById('replyText').textContent = '';
  document.getElementById('replyBar').style.display = 'none';
}

async function withdrawMessage() {
  if (!S.contextMenuTarget) return;
  const messageId = S.contextMenuTarget;
  if (!confirm('确定撤回这条飞书消息？')) return;
  document.getElementById('contextMenu').style.display = 'none';
  try {
    const response = await fetch(
      `${S.url}/api/messages/${encodeURIComponent(messageId)}`,
      { method: 'DELETE', headers: { 'x-api-key': S.token } },
    );
    const data = await parseApiResponse(response);
    onMessageDeleted(data.data || { messageId });
    toast('消息已撤回', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

function deleteMessage() {
  if (!S.contextMenuTarget || !S.cur) return;
  if (!confirm('确定删除这条消息？')) return;
  S.msgs[S.cur] = S.msgs[S.cur].filter(m => m.id !== S.contextMenuTarget);
  const el = S.msgEls[S.contextMenuTarget];
  if (el) el.remove();
  delete S.msgEls[S.contextMenuTarget];
  toast('消息已删除', 'ok');
  document.getElementById('contextMenu').style.display = 'none';
}

async function renameConv(convId) {
  const conv = S.convs.find(c => c.id === convId);
  if (!conv) return;
  const newName = prompt('新名称:', conv.name);
  if (newName && newName.trim()) {
    conv.name = newName.trim();
    await saveConvs();
    renderConvs();
    if (S.cur === convId) {
      document.getElementById('hdName').textContent = conv.name;
    }
  }
}

async function deleteConv(convId) {
  if (!confirm('确定删除这个会话？聊天记录将保留。')) return;
  S.convs = S.convs.filter(c => c.id !== convId);
  await saveConvs();
  renderConvs();
  if (S.cur === convId) {
    S.cur = null;
    document.getElementById('chatView').style.display = 'none';
    document.getElementById('empty').style.display = 'flex';
  }
}

// ── Emoji Picker ──────────────────────────────────────────────
function initEmojiPicker() {
  const emojis = ['😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥸','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','💩','👻','💀','☠️','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾'];
  const grid = document.getElementById('emojiGrid');
  grid.innerHTML = emojis.map(e => `<div class="emoji-item" onclick="insertEmoji('${e}')">${e}</div>`).join('');
}

function toggleEmojiPicker() {
  document.getElementById('emojiPicker').classList.toggle('visible');
}

function insertEmoji(emoji) {
  const input = document.getElementById('input');
  input.value += emoji;
  input.focus();
  adjustTA(input);
}

// ── Scroll to Bottom ─────────────────────────────────────────
function scrollToBottomAndClear() {
  scrollBottom();
  S.newMsgCount = 0;
  document.getElementById('newMsgCount').style.display = 'none';
  document.getElementById('scrollToBottom').classList.remove('visible');
}

// ── Image Preview ─────────────────────────────────────────────
function showImagePreview(src) {
  document.getElementById('previewImg').src = src;
  document.getElementById('imagePreview').classList.add('visible');
}

function closeImagePreview() {
  document.getElementById('imagePreview').classList.remove('visible');
}

// ── Draft Save ────────────────────────────────────────────────
async function saveDraft() {
  console.log('[前端] saveDraft() 被调用，数据:', S.drafts);
  if (S.cur) {
    S.drafts[S.cur] = document.getElementById('input').value;
    if (!S.token) {
      console.warn('[前端] saveDraft() 没有 token，跳过');
      return;
    }
    try {
      const res = await fetch(`${S.url}/api/drafts?token=${encodeURIComponent(S.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': S.token },
        body: JSON.stringify(S.drafts),
      });
      const data = await res.json();
      console.log('[前端] saveDraft() 返回:', data);
    } catch (err) {
      console.error('[前端] 保存草稿失败:', err);
    }
  }
}

function loadDraft() {
  if (S.cur && S.drafts[S.cur]) {
    document.getElementById('input').value = S.drafts[S.cur];
    adjustTA(document.getElementById('input'));
  }
}

async function selectConv(id) {
  // Save draft of previous conversation
  await saveDraft();
  cancelReply();
  
  S.cur = id;
  const c = S.convs.find(x=>x.id===id);
  if (c) c.unread = 0;
  await saveConvs(); renderConvs();

  document.getElementById('empty').style.display = 'none';
  const cv = document.getElementById('chatView');
  cv.style.display = 'flex';
  document.getElementById('hdAvatar').textContent = c?.name[0] || '?';
  document.getElementById('hdAvatar').style.background = strColor(id);
  document.getElementById('hdName').textContent = c?.name || id;
  document.getElementById('hdSub').textContent = (c?.type==='p2p'?'私聊':'群聊') + ' · ' + id;

  const el = document.getElementById('msgs');
  el.innerHTML = '';
  S.msgEls = {};
  (S.msgs[id]||[]).forEach(appendMsg);
  scrollBottom();
  
  // Load draft for new conversation
  document.getElementById('input').value = '';
  loadDraft();
  document.getElementById('input').focus();
}

async function addConv() {
  const input = prompt('输入飞书接收 ID\n（私聊用户 Open ID: ou_xxx，群聊 Chat ID: oc_xxx）');
  const id = input?.trim();
  if (!id) return;
  const name = prompt('会话名称:')?.trim() || id.slice(0,12);
  const receiveIdType = id.startsWith('ou_') ? 'open_id' : 'chat_id';
  const type = receiveIdType === 'chat_id' ? 'group' : 'p2p';
  if (!S.convs.find(c=>c.id===id)) {
    S.convs.push({ id, name, type, receiveIdType, unread:0 });
    await saveConvs(); renderConvs();
  }
  await selectConv(id);
}

async function saveConvs() {
  console.log('[前端] saveConvs() 被调用，数据:', S.convs);
  if (!S.token) {
    console.warn('[前端] saveConvs() 没有 token，跳过');
    return;
  }
  try {
    const res = await fetch(`${S.url}/api/convs?token=${encodeURIComponent(S.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': S.token },
      body: JSON.stringify(S.convs),
    });
    const data = await res.json();
    console.log('[前端] saveConvs() 返回:', data);
  } catch (err) {
    console.error('[前端] 保存会话列表失败:', err);
  }
}

function clearCurrentChat() {
  if (!S.cur) return;
  if (!confirm('确定清空当前聊天记录？')) return;
  S.msgs[S.cur] = [];
  document.getElementById('msgs').innerHTML = '';
  S.msgEls = {};
  toast('聊天记录已清空', 'ok');
}

function copyChatId() {
  if (!S.cur) return;
  navigator.clipboard.writeText(S.cur).then(() => toast('Chat ID 已复制', 'ok'));
}

// ── 渲染单条消息 ──────────────────────────────────────────────
function appendMsg(msg) {
  const el = document.getElementById('msgs');
  if (!el) return;
  const out = msg.direction === 'outgoing';
  const t = fmtTime(msg.createTime);

  const d = document.createElement('div');
  d.className = `msg ${out?'out':'in'}${msg.deleted?' withdrawn':''}`;
  if (msg.id) d.dataset.msgId = msg.id;
  
  // Add right-click context menu
  if (msg.id) {
    d.oncontextmenu = (e) => showContextMenu(e, msg.id);
  }

  const tickHtml = out ? `<span class="read-tick pending" title="已发送">✓</span>` : '';
  d.innerHTML = `
    <div class="avatar" style="background:${out?'#2d1b69':'#0f2a5c'}">${out?'我':'对'}</div>
    <div class="bw">
      <div class="bubble">${renderBubbleContent(msg)}</div>
      <div class="msg-time">${t}${tickHtml}</div>
    </div>`;

  el.appendChild(d);
  if (msg.id) S.msgEls[msg.id] = d;
}

function scrollBottom() {
  const el = document.getElementById('msgs');
  if (el) requestAnimationFrame(()=>el.scrollTop=el.scrollHeight);
}

// ── 发送消息 ──────────────────────────────────────────────────
function setSendingState(active) {
  const btn = document.getElementById('sendBtn');
  const attachBtn = document.getElementById('attachBtn');
  btn.disabled = active;
  attachBtn.disabled = active;
  btn.innerHTML = active
    ? '<div class="spinner"></div>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="white" id="sendIcon"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const parts = [data.error || `请求失败（HTTP ${response.status}）`];
    if (data.code) parts.unshift(`错误码 ${data.code}`);
    if (data.hint) parts.push(data.hint);
    if (data.requestId) parts.push(`请求 ID: ${data.requestId}`);
    throw new Error(parts.join('：'));
  }
  return data;
}

async function requestSend(message, msgType = 'text', metadata = {}) {
  const conv = S.convs.find(c => c.id === S.cur);
  const replyTarget = metadata.replyTarget === undefined ? S.replyTarget : metadata.replyTarget;
  const response = await fetch(`${S.url}/api/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': S.token,
    },
    body: JSON.stringify({
      chatId: S.cur,
      message,
      msgType,
      receiveIdType: conv?.receiveIdType,
      replyTo: replyTarget?.id,
      replyPreview: replyTarget?.text,
      fileName: metadata.fileName,
    }),
  });
  return parseApiResponse(response);
}

async function send() {
  const inp = document.getElementById('input');
  const txt = inp.value.trim();
  if (!txt || !S.cur || document.getElementById('sendBtn').disabled) return;

  const totalBytes = TextSplitter.serializedTextBytes(txt);
  const parts = TextSplitter.prepareTextParts(txt);
  if (parts.length > 1) {
    const confirmed = confirm(
      `文本序列化后约 ${(totalBytes / 1024).toFixed(1)} KB，超过单条安全上限 140 KB。\n` +
      `将自动拆分为 ${parts.length} 条消息依次发送，是否继续？`,
    );
    if (!confirmed) {
      inp.focus();
      return;
    }
  }

  setSendingState(true);
  const draft = txt;
  const replyTarget = S.replyTarget ? { ...S.replyTarget } : null;
  inp.value = ''; adjustTA(inp);

  if (S.drafts[S.cur]) {
    delete S.drafts[S.cur];
    await saveDraft();
  }

  let sentCount = 0;
  try {
    for (let index = 0; index < parts.length; index++) {
      await requestSend(parts[index], 'text', { replyTarget });
      sentCount = index + 1;
      if (index < parts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    cancelReply();
    if (parts.length > 1) toast(`已分段发送 ${parts.length} 条消息`, 'ok');
  } catch (error) {
    const rawParts = parts.length > 1
      ? TextSplitter.splitText(draft, TextSplitter.SAFE_TEXT_BYTES - TextSplitter.PART_LABEL_RESERVED_BYTES)
      : [draft];
    inp.value = rawParts.slice(sentCount).join('');
    adjustTA(inp);
    const progress = parts.length > 1 ? `（已发送 ${sentCount}/${parts.length} 条，剩余内容已恢复）` : '';
    toast(`${error.message}${progress}`, 'err');
  } finally {
    setSendingState(false);
    inp.focus();
  }
}

function chooseAttachment() {
  if (!S.cur || S.uploading) return;
  document.getElementById('fileInput').click();
}

async function handleAttachment(file) {
  const input = document.getElementById('fileInput');
  if (!file || !S.cur || S.uploading) return;
  const kind = file.type.startsWith('image/') ? 'image' : 'file';
  const maxBytes = kind === 'image' ? 10 * 1024 * 1024 : 30 * 1024 * 1024;
  if (file.size === 0 || file.size > maxBytes) {
    toast(`${kind === 'image' ? '图片' : '文件'}大小必须在 1 字节到 ${kind === 'image' ? 10 : 30} MB 之间`, 'err');
    input.value = '';
    return;
  }

  S.uploading = true;
  setSendingState(true);
  toast(`正在上传 ${file.name}…`, 'info');
  try {
    const response = await fetch(`${S.url}/api/upload?kind=${kind}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-api-key': S.token,
        'x-file-name': encodeURIComponent(file.name),
        'x-file-type': file.type,
      },
      body: file,
    });
    const uploaded = await parseApiResponse(response);
    await requestSend(uploaded.content, uploaded.msgType, { fileName: uploaded.fileName });
    cancelReply();
    toast(`${file.name} 已发送`, 'ok');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    S.uploading = false;
    setSendingState(false);
    input.value = '';
    document.getElementById('input').focus();
  }
}

// ── Config ────────────────────────────────────────────────────
function toggleConfig() {
  const el = document.getElementById('cfg');
  el.style.display = getComputedStyle(el).display === 'none' ? 'block' : 'none';
}
async function applyConfig() {
  S.url = document.getElementById('cfgUrl').value.replace(/\/$/,'');
  S.token = document.getElementById('cfgToken').value.trim();
  S.theme = document.getElementById('cfgTheme').value;
  localStorage.setItem('relayUrl', S.url);
  localStorage.setItem('relayToken', S.token);
  localStorage.setItem('defaultChatId', document.getElementById('cfgChatId').value);
  await saveSettings();
  initTheme();
  toggleConfig();
  if (S.token) {
    await connect();
  }
  toast('配置已保存', 'info');
}

// ── Utils ─────────────────────────────────────────────────────
function extractText(msg) {
  try {
    const c = msg.content;
    if (msg.deleted) return '[消息已撤回]';
    if (!c) return '[消息]';
    if (typeof c === 'string') return c;
    if (c.text) return c.text;
    if (c.image_key) return '[图片]';
    if (msg.msgType === 'audio') return c.file_name || '[音频]';
    if (msg.msgType === 'media') return c.file_name || '[视频]';
    if (c.file_key) return c.file_name || '[文件]';
    const post = getPostContent(c);
    if (post) {
      const body = (post.content || []).flat().map(item => item.text || item.name || '').join(' ');
      return [post.title, body].filter(Boolean).join(' ');
    }
    return JSON.stringify(c);
  } catch { return '[消息]'; }
}

function getReplyPreview(msg) {
  if (msg.replyPreview) return msg.replyPreview;
  if (!msg.parentId) return '';
  const original = (S.msgs[msg.chatId] || []).find(item => item.id === msg.parentId);
  return original ? extractText(original).replace(/\s+/g, ' ').slice(0, 120) : `回复消息 ${msg.parentId}`;
}

function getPostContent(content) {
  if (!content || typeof content !== 'object') return null;
  if (Array.isArray(content.content)) return content;
  const preferred = content.zh_cn || content.en_us || content.zh_hk || content.zh_tw;
  if (preferred && Array.isArray(preferred.content)) return preferred;
  return Object.values(content).find(value => value && Array.isArray(value.content)) || null;
}

function resourceUrl(msg, fileKey, type, fileName = '') {
  if (!msg.id || !fileKey) return '';
  const query = new URLSearchParams({ type, token: S.token });
  if (fileName) query.set('name', fileName);
  return `${S.url}/api/messages/${encodeURIComponent(msg.id)}/resources/${encodeURIComponent(fileKey)}?${query}`;
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function renderPostItem(item, msg) {
  if (!item || typeof item !== 'object') return '';
  if (item.tag === 'a') {
    const href = safeExternalUrl(item.href || item.url);
    return href
      ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${esc(item.text || href)}</a>`
      : esc(item.text || '');
  }
  if (item.tag === 'at') return esc(`@${item.user_name || item.name || item.user_id || '用户'}`);
  if (item.tag === 'img' && item.image_key) {
    const src = resourceUrl(msg, item.image_key, 'image');
    return src ? `<img class="message-image" src="${escAttr(src)}" alt="图片" loading="lazy" onclick="showImagePreview(this.src)">` : '[图片]';
  }
  return esc(item.text || item.name || '');
}

function renderMessageContent(msg, highlightQuery = '') {
  if (msg.deleted) return esc('[消息已撤回]');
  const content = msg.content || {};

  if (msg.msgType === 'image' || (content.image_key && !content.file_key)) {
    const src = resourceUrl(msg, content.image_key, 'image');
    return src
      ? `<img class="message-image" src="${escAttr(src)}" alt="图片" loading="lazy" onclick="showImagePreview(this.src)">`
      : esc('[图片不可预览]');
  }

  if (msg.msgType === 'file' || content.file_key) {
    if (msg.msgType === 'audio') {
      const src = resourceUrl(msg, content.file_key, 'audio');
      return src
        ? `<div class="media-card"><audio controls preload="metadata" src="${escAttr(src)}"></audio><a href="${escAttr(src)}" target="_blank" rel="noopener">下载音频</a></div>`
        : esc('[音频不可播放]');
    }
    if (msg.msgType === 'media') {
      const src = resourceUrl(msg, content.file_key, 'media');
      return src
        ? `<div class="media-card"><video class="message-video" controls preload="metadata" src="${escAttr(src)}"></video><a href="${escAttr(src)}" target="_blank" rel="noopener">下载视频</a></div>`
        : esc('[视频不可播放]');
    }
    const href = resourceUrl(msg, content.file_key, 'file', content.file_name || 'download');
    const name = content.file_name || '下载文件';
    return href
      ? `<a class="file-card" href="${escAttr(href)}" download="${escAttr(name)}"><span class="file-icon">📄</span><span class="file-name">${esc(name)}</span></a>`
      : esc(`[文件] ${name}`);
  }

  const post = msg.msgType === 'post' ? getPostContent(content) : null;
  if (post) {
    const title = post.title ? `<div class="rich-title">${esc(post.title)}</div>` : '';
    const lines = (post.content || []).map(line =>
      `<div class="rich-line">${(line || []).map(item => renderPostItem(item, msg)).join('')}</div>`
    ).join('');
    return `<div class="rich-post">${title}${lines}</div>`;
  }

  const text = extractText(msg);
  if (!highlightQuery) return esc(text);
  const regex = new RegExp(`(${escRegex(highlightQuery)})`, 'gi');
  return esc(text).replace(regex, '<span class="search-highlight">$1</span>');
}

function renderBubbleContent(msg, highlightQuery = '') {
  const replyText = getReplyPreview(msg);
  const reply = replyText ? `<div class="reply-quote">${esc(replyText)}</div>` : '';
  return reply + renderMessageContent(msg, highlightQuery);
}

function fmtTime(ts) {
  if (!ts) return '';
  const raw = typeof ts === 'number' ? ts : Number(ts);
  const d = new Date(raw > 1e12 ? raw : raw * 1000);
  if (Number.isNaN(d.getTime())) return '';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((startOfToday - startOfDate) / 86400000);
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

  if (diffDays === 0) return time;
  if (diffDays === 1) return `昨天 ${time}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function strColor(s) {
  let h=0; for(let c of s) h=c.charCodeAt(0)+((h<<5)-h);
  return ['#1a3a7a','#2d1b69','#0f3d30','#3d2200','#3d0a0a','#1a2d3d'][Math.abs(h)%6];
}

function toast(msg, type='info') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className=`toast ${type}`; t.textContent=msg;
  c.appendChild(t); setTimeout(()=>t.remove(),3000);
}

function adjustTA(el) {
  el.style.height='auto';
  el.style.height=Math.min(el.scrollHeight,120)+'px';
}

document.getElementById('input').addEventListener('keydown', e => {
  if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
document.getElementById('input').addEventListener('input', function(){ adjustTA(this); });

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
    event.preventDefault();
    toggleSearch(true);
  } else if (event.key === 'Escape' && document.getElementById('searchBox').classList.contains('visible')) {
    closeSearch();
  }
});

// Save draft on page unload (使用同步请求确保数据保存)
window.addEventListener('beforeunload', () => {
  if (S.cur && S.token) {
    S.drafts[S.cur] = document.getElementById('input').value;
    const data = JSON.stringify(S.drafts);
    const url = `${S.url}/api/drafts?token=${encodeURIComponent(S.token)}`;
    // 使用同步 XMLHttpRequest 确保在页面关闭前完成保存
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('x-api-key', S.token);
      xhr.send(data);
    } catch (e) {
      console.error('页面卸载时保存草稿失败:', e);
    }
  }
});
