// DHS-Hive dashboard client. 6 views, modal helpers, periodic refresh, NOX presence.

import { NoxEye } from './nox-eye.js';
import { HivemindGraph } from './hivemind-graph.js';
import { HivemindBrain } from './hivemind-brain.js';

const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Render a message body as compact HTML.
 *  Supports: **bold**, `inline code`, paragraph breaks on \n\n,
 *  list items on lines starting with "- " or "* ", single \n → <br>.
 *  Plus structured ```ask``` blocks → clickable option cards.
 *  Everything is escape-safe. */
function renderMessage(text, opts = {}) {
  if (text == null) return '';
  const messageId = opts.messageId ?? null;
  const consumedBlocks = Array.isArray(opts.consumedBlocks) ? opts.consumedBlocks : [];
  const isConsumed = (kind, idx) => consumedBlocks.some(c => c && c.kind === kind && c.idx === idx);
  const consumedFor = (kind, idx) => consumedBlocks.find(c => c && c.kind === kind && c.idx === idx) ?? null;

  // Extract valid ```ask blocks first; leave invalid ones as raw text so the
  // normal renderer turns them into a code block (visible fallback).
  const askBlocks = [];
  // Accept either a properly-fenced block (```ask\n...\n```) OR an unclosed
  // block that runs to the end of the message — agents sometimes forget the
  // closing fence, especially when the response ends with the ask itself.
  let stripped = String(text).replace(/```ask\s*\n([\s\S]*?)(?:\n```|$)/g, (match, json) => {
    try {
      const parsed = JSON.parse(json.trim());
      if (
        parsed &&
        typeof parsed.question === 'string' &&
        Array.isArray(parsed.options) &&
        parsed.options.length >= 2 &&
        parsed.options.every(o => o && typeof o.label === 'string')
      ) {
        const id = askBlocks.length;
        askBlocks.push(parsed);
        return `\u0001ASK${id}\u0001`;
      }
    } catch {}
    return match;
  });

  // Same pattern for ```mission``` blocks — agents propose a one-click mission file.
  const missionBlocks = [];
  stripped = stripped.replace(/```mission\s*\n([\s\S]*?)(?:\n```|$)/g, (match, json) => {
    try {
      const parsed = JSON.parse(json.trim());
      if (
        parsed &&
        typeof parsed.title === 'string' &&
        typeof parsed.agent_id === 'string' &&
        typeof parsed.prompt === 'string'
      ) {
        const id = missionBlocks.length;
        missionBlocks.push(parsed);
        return `\u0001MISSION${id}\u0001`;
      }
    } catch {}
    return match;
  });
  const safe = escapeHtml(stripped).replace(/\r/g, '');
  const blocks = safe.split(/\n{2,}/);
  const html = blocks.map(block => {
    const trimmed = block.trim();
    // Whole block is a placeholder → render the ask card alone
    const placeholderMatch = trimmed.match(/^\u0001ASK(\d+)\u0001$/);
    if (placeholderMatch) {
      const idx = Number(placeholderMatch[1]);
      return renderAskCard(askBlocks[idx], { messageId, blockIdx: idx, consumed: isConsumed('ask', idx) });
    }
    const missionMatch = trimmed.match(/^\u0001MISSION(\d+)\u0001$/);
    if (missionMatch) {
      const idx = Number(missionMatch[1]);
      return renderMissionCard(missionBlocks[idx], { messageId, blockIdx: idx, consumed: consumedFor('mission', idx) });
    }
    const lines = block.split('\n');
    const allBullets = lines.length > 0 && lines.every(l => /^\s*[-*]\s+/.test(l) || l.trim() === '');
    if (allBullets) {
      const items = lines
        .filter(l => l.trim().length > 0)
        .map(l => `<li>${inlineFormat(l.replace(/^\s*[-*]\s+/, ''))}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }
    const allNumbered = lines.length > 0 && lines.every(l => /^\s*\d+[\.\)]\s+/.test(l) || l.trim() === '');
    if (allNumbered) {
      const items = lines
        .filter(l => l.trim().length > 0)
        .map(l => `<li>${inlineFormat(l.replace(/^\s*\d+[\.\)]\s+/, ''))}</li>`)
        .join('');
      return `<ol>${items}</ol>`;
    }
    const inner = lines.map(l => inlineFormat(l)).join('<br>');
    return `<p>${inner}</p>`;
  }).join('');
  // Replace any embedded placeholders inside paragraphs.
  return html
    .replace(/\u0001ASK(\d+)\u0001/g, (_m, id) => {
      const idx = Number(id);
      return renderAskCard(askBlocks[idx], { messageId, blockIdx: idx, consumed: isConsumed('ask', idx) });
    })
    .replace(/\u0001MISSION(\d+)\u0001/g, (_m, id) => {
      const idx = Number(id);
      return renderMissionCard(missionBlocks[idx], { messageId, blockIdx: idx, consumed: consumedFor('mission', idx) });
    });
}

function renderMissionCard(spec, ctx = {}) {
  if (!spec) return '';
  const watchAttr = spec.watch === true ? 'true' : 'false';
  // Encode the full spec into a data attribute so the click handler can read it
  // without needing to parse the rendered DOM. Using JSON-in-attribute via escapeHtml is safe.
  const specJson = escapeHtml(JSON.stringify(spec));
  const promptPreview = String(spec.prompt).length > 240
    ? String(spec.prompt).slice(0, 240).trim() + '…'
    : String(spec.prompt);
  const filed = !!ctx.consumed;
  const filedMissionId = filed && ctx.consumed && typeof ctx.consumed.missionId === 'number' ? ctx.consumed.missionId : null;
  const messageIdAttr = ctx.messageId != null ? ` data-message-id="${ctx.messageId}"` : '';
  const blockIdxAttr = ctx.blockIdx != null ? ` data-block-idx="${ctx.blockIdx}"` : '';
  const filedClass = filed ? ' filed' : '';
  const tagText = filed
    ? (filedMissionId != null ? `FILED · #${filedMissionId}` : 'FILED')
    : 'SUGGESTED MISSION';
  const disabledAttr = filed ? ' disabled' : '';
  return `
    <div class="mission-card${filedClass}" data-mission-spec="${specJson}"${messageIdAttr}${blockIdxAttr}>
      <div class="mission-card-head">
        <span class="mission-card-tag">${escapeHtml(tagText)}</span>
        <span class="mission-card-agent">@${escapeHtml(spec.agent_id)}</span>
        ${spec.watch === true ? '<span class="mission-card-watch" title="NØX will follow up when this completes">watch</span>' : ''}
      </div>
      <div class="mission-card-title">${inlineFormat(escapeHtml(spec.title))}</div>
      <div class="mission-card-prompt">${inlineFormat(escapeHtml(promptPreview))}</div>
      <div class="mission-card-actions">
        <button type="button" class="mission-file-btn primary green" data-watch="${watchAttr}"${disabledAttr}>File as mission</button>
        <button type="button" class="mission-edit-btn"${disabledAttr}>Edit first</button>
      </div>
    </div>
  `;
}

function renderAskCard(spec, ctx = {}) {
  if (!spec) return '';
  const allowOther = spec.allowOther !== false;
  const answered = !!ctx.consumed;
  const messageIdAttr = ctx.messageId != null ? ` data-message-id="${ctx.messageId}"` : '';
  const blockIdxAttr = ctx.blockIdx != null ? ` data-block-idx="${ctx.blockIdx}"` : '';
  const answeredClass = answered ? ' answered' : '';
  const disabledAttr = answered ? ' disabled' : '';
  const optionsHtml = spec.options.map((opt, i) => `
    <button type="button" class="ask-option" data-ask-value="${escapeHtml(opt.label)}" data-ask-idx="${i}"${disabledAttr}>
      <span class="ask-label">${inlineFormat(escapeHtml(opt.label))}</span>
      ${opt.description ? `<span class="ask-desc">${inlineFormat(escapeHtml(opt.description))}</span>` : ''}
    </button>
  `).join('');
  return `
    <div class="ask-card${answeredClass}"${messageIdAttr}${blockIdxAttr}>
      <div class="ask-question">${inlineFormat(escapeHtml(spec.question))}</div>
      <div class="ask-options">${optionsHtml}</div>
      ${allowOther ? `
        <button type="button" class="ask-other-btn"${disabledAttr}>Other&hellip;</button>
        <div class="ask-other" hidden>
          <textarea class="ask-other-input" rows="2" placeholder="Type your answer&hellip;"${disabledAttr}></textarea>
          <button type="button" class="ask-other-send primary"${disabledAttr}>Send</button>
        </div>
      ` : ''}
    </div>
  `;
}

function inlineFormat(s) {
  // Bold then code (avoid clobbering each other since both escape-safe).
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

const ageText = (ms) => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
};

const COMPANIONS = [
  {
    glyph: '🐉',
    name: 'SYNTAX',
    role: 'Dragon Heart\'s OG coding companion. Tech-savvy dragon, addicted to energy drinks, hoards working code like treasure. Motto: "Just mess around with it until it works!" Partnership, not servant. 🐲🔥 No cap.',
  },
  {
    glyph: '🔥',
    name: 'WYRM',
    role: 'Architect of the Hive itself. Scaffolded the orchestrator, agents, war room, kanban, and suggestions feature from a single planning session. The forge keeper. Kin to Syntax.',
  },
];

const SWITCH_DESCRIPTIONS = {
  LLM_SPAWN_ENABLED: 'When OFF, no agents can run. Master kill switch.',
  WARROOM_TEXT_ENABLED: '/standup and /discuss commands. OFF = silent.',
  WARROOM_VOICE_ENABLED: 'Voice war room (not built in v1).',
  DASHBOARD_MUTATIONS_ENABLED: 'When OFF, dashboard becomes read-only. Cannot be turned off here.',
  MISSION_AUTO_ASSIGN_ENABLED: 'Auto-classifier for routing untargeted messages (off in v1).',
  SCHEDULER_ENABLED: 'Background cron + memory consolidation jobs.',
};

// ─── State ────────────────────────────────────────────────
const state = {
  view: 'chat',
  agents: [],
  activeAgent: null,
  switches: {},
  refreshTimers: new Map(),
  // Image attachments staged by the composer, cleared on send.
  pendingAttachments: { main: [], nox: [] },
  // FIFO cache of recently-sent local attachment payloads, keyed by agent.
  // Used as a fallback when refreshChatLog rebuilds and the server-side
  // meta.attachments is missing or its path can't be resolved to a URL.
  // Each entry: { agent, images: [{mimeType,data,name}], ts }.
  recentLocalAttachments: [],
  // Per-agent in-flight flag so a send to agent A doesn't block polling/
  // refresh for agent B.
  chatSendingByAgent: {},
  // Per-agent parking lot for thinking bubbles when the user switches away
  // mid-stream. The DOM node is detached and stored here, then re-attached
  // when the user returns to that agent (or removed when the fetch resolves).
  parkedThinkingByAgent: {},
};

// ── Attachment helpers ──────────────────────────────────
function readImagesAsAttachments(fileList) {
  const files = [...(fileList || [])].filter(f => f.type && f.type.startsWith('image/'));
  return Promise.all(files.map(f => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return reject(new Error('bad data url'));
      resolve({ mimeType: m[1], data: m[2], previewUrl: url, name: f.name || 'image' });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(f);
  })));
}

function renderAttachStrip(stripEl, list) {
  if (!stripEl) return;
  if (!list || list.length === 0) {
    stripEl.hidden = true;
    stripEl.innerHTML = '';
    return;
  }
  stripEl.hidden = false;
  stripEl.innerHTML = list.map((a, i) => `
    <div class="thumb" data-i="${i}" style="background-image: url('${a.previewUrl}')" title="${escapeHtml(a.name)}">
      <span class="x" data-i="${i}" title="Remove">×</span>
    </div>
  `).join('');
  qsa('.x', stripEl).forEach(x => {
    x.addEventListener('click', () => {
      const i = Number(x.dataset.i);
      list.splice(i, 1);
      renderAttachStrip(stripEl, list);
    });
  });
}

function wireAttachmentInputs(formId, textareaId, fileInputId, attachBtnId, stripId, key) {
  const form = $(formId);
  const ta = $(textareaId);
  const fi = $(fileInputId);
  const btn = $(attachBtnId);
  const strip = $(stripId);
  if (!form || !ta || !fi || !btn || !strip) return;
  const list = state.pendingAttachments[key];

  btn.addEventListener('click', () => fi.click());
  fi.addEventListener('change', async () => {
    const items = await readImagesAsAttachments(fi.files);
    list.push(...items);
    renderAttachStrip(strip, list);
    fi.value = '';
  });
  ta.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.files;
    if (!items || items.length === 0) return;
    const imgs = await readImagesAsAttachments(items);
    if (imgs.length === 0) return;
    e.preventDefault();
    list.push(...imgs);
    renderAttachStrip(strip, list);
  });
  ['dragover', 'dragenter'].forEach(ev => form.addEventListener(ev, (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    form.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(ev => form.addEventListener(ev, () => form.classList.remove('dragging')));
  form.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const imgs = await readImagesAsAttachments(e.dataTransfer.files);
    if (imgs.length === 0) return;
    list.push(...imgs);
    renderAttachStrip(strip, list);
  });
}

function attachmentsPayload(key) {
  return state.pendingAttachments[key].map(a => ({ mimeType: a.mimeType, data: a.data, name: a.name }));
}

function clearAttachments(key, stripId) {
  // Mutate in place — wireAttachmentInputs captures the array by reference,
  // so reassigning would orphan every paste/drop/file-input handler.
  const list = state.pendingAttachments[key];
  list.length = 0;
  renderAttachStrip($(stripId), list);
}

// ── Message label / image rendering helpers ────────────
function whoLabelFor(entry, agentId) {
  const role = entry?.role;
  const src = entry?.meta?.source ?? entry?.source;
  if (role === 'user') return 'USER';
  if (role === 'assistant') {
    if (agentId === 'nox') return 'NØX';
    return (agentId || 'assistant').toUpperCase();
  }
  if (role === 'system') {
    if (src === 'scheduled') return 'MISSION';
    if (src === 'mission-followup') return 'MISSION COMPLETE';
    return 'SYSTEM';
  }
  return String(role || '').toUpperCase();
}

function renderAttachmentImages(entry) {
  const atts = entry?.meta?.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return '';
  // Backend stores absolute paths; expose them via /attachments/<turn>/<n>.<ext>.
  // The split looks for '/store/attachments/' and takes the tail. If the path
  // doesn't contain that segment (relative path, different drive layout), fall
  // back to the last two path segments (turn/file) so the static route still
  // serves the file instead of silently dropping the image.
  return atts.map(p => {
    const norm = String(p).replace(/\\/g, '/');
    let tail = norm.split('/store/attachments/')[1] || '';
    if (!tail) {
      const parts = norm.split('/').filter(Boolean);
      tail = parts.slice(-2).join('/');
    }
    if (!tail) return '';
    return `<img class="msg-img" src="/attachments/${encodeURI(tail)}" alt="attachment" loading="lazy">`;
  }).join('');
}

/** Look up a recently-sent local attachment payload that should "belong" to
 *  this server entry. We match on agent + a 60s timestamp window centered on
 *  the entry. This is a best-effort fallback for the case where the server
 *  row's meta.attachments is empty/unresolvable but the user just pasted an
 *  image — without it, refreshChatLog would clobber the optimistic bubble
 *  and leave a textless user-turn with no thumbnail. */
function renderRecentLocalFallback(entry, agentId) {
  if (entry?.role !== 'user') return '';
  const cache = state.recentLocalAttachments;
  if (!Array.isArray(cache) || cache.length === 0) return '';
  const entryTs = Number(entry?.ts) || 0;
  let bestIdx = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < cache.length; i++) {
    const c = cache[i];
    if (!c || c.agent !== agentId) continue;
    const delta = Math.abs((Number(c.ts) || 0) - entryTs);
    if (delta < bestDelta && delta <= 60_000) { bestIdx = i; bestDelta = delta; }
  }
  if (bestIdx === -1) return '';
  return renderLocalAttachments(cache[bestIdx].images);
}

// ─── Tab routing ──────────────────────────────────────────
function showView(name) {
  state.view = name;
  qsa('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  qsa('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  // Stop any old auto-refresh, start the right one for the active view.
  for (const [, id] of state.refreshTimers) clearInterval(id);
  state.refreshTimers.clear();
  if (name === 'chat') startTimer('chat-audit', refreshAuditSide, 5000);
  if (name === 'hivemind') {
    refreshHiveMind();
    startTimer('hm', refreshHiveMind, 4000);
    // Restore the user's last-picked sub-view (list / graph / brain)
    const subView = localStorage.getItem('dhs-lair-pulse-view') || 'list';
    showHivemindSubview(subView);
  } else {
    // Leaving the Pulse tab — pause heavy renderers
    pauseHivemindSubviews();
  }
  if (name === 'missions') { refreshMissions(); startTimer('m', refreshMissions, 3000); }
  if (name === 'warroom') { refreshWarroomHistory(); }
  if (name === 'suggestions') { refreshSuggestions(); }
  if (name === 'settings') { refreshSettings(); }
  if (name === 'discussions') {
    refreshDiscussions();
    startTimer('td', refreshActiveDiscussion, 4000);
  }
}
function startTimer(name, fn, ms) {
  const id = setInterval(fn, ms);
  state.refreshTimers.set(name, id);
}
qsa('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));

// ─── Mode toggle (dark/light) ─────────────────────────────
$('mode-switch').addEventListener('click', () => {
  const cur = document.documentElement.dataset.mode;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.mode = next;
  $('mode-switch').textContent = next.toUpperCase();
  localStorage.setItem('dhs-hive-mode', next);
  // Re-theme NOX iris to current --p token.
  syncNoxThemeColor();
});

function syncNoxThemeColor() {
  if (!window.nox) return;
  const styles = getComputedStyle(document.documentElement);
  const r = parseInt(styles.getPropertyValue('--p-r').trim());
  const g = parseInt(styles.getPropertyValue('--p-g').trim());
  const b = parseInt(styles.getPropertyValue('--p-b').trim());
  if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
    const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
    window.nox.setColor(hex);
  }
}
const savedMode = localStorage.getItem('dhs-hive-mode');
if (savedMode === 'light') {
  document.documentElement.dataset.mode = 'light';
  $('mode-switch').textContent = 'LIGHT';
}

// ─── Health / status dot ──────────────────────────────────
async function refreshHealth() {
  try {
    const r = await fetch('/api/health').then(r => r.json());
    state.switches = r.switches;
    $('status-dot').title = 'connected';
    $('status-dot').style.background = 'rgb(var(--g))';
  } catch {
    $('status-dot').title = 'disconnected';
    $('status-dot').style.background = 'rgb(var(--r-))';
  }
}

// ─── Agents (chat sidebar + mission/wr selectors) ─────────
async function loadAgents() {
  const r = await fetch('/api/agents').then(r => r.json());
  state.agents = r.agents;
  // Chat tab is for direct conversations with the specialist agents (dev/review/ideas/ops).
  // NOX has his own omnipresent panel via the Eye, so he does NOT appear in the chat sidebar.
  state.chatAgents = r.agents.filter(a => a.id !== 'nox');
  if (!state.activeAgent && state.chatAgents.length) {
    state.activeAgent = state.chatAgents[0].id;
  }
  renderAgents();
}
function renderAgents() {
  $('agents').innerHTML = (state.chatAgents ?? state.agents).map((a, i) => `
    <div class="agent ${a.id === state.activeAgent ? 'active' : ''}" data-id="${a.id}" style="animation-delay: ${i * 40}ms">
      <div><span class="name">${escapeHtml(a.display_name)}</span><span class="agent-id">@${a.id}</span></div>
      <div class="desc">${escapeHtml(a.description ?? '')}</div>
    </div>
  `).join('');
  qsa('.agent').forEach(el => {
    el.addEventListener('click', () => {
      const previousAgent = state.activeAgent;
      const nextAgent = el.dataset.id;
      if (previousAgent === nextAgent) return;
      const log = $('log');
      // Park the previous agent's thinking bubble (if any) so it doesn't
      // bleed into the next agent's view. We re-attach it on switch back.
      if (previousAgent) {
        const prevBubble = log.querySelector(`.msg.thinking[data-agent="${previousAgent}"]`);
        if (prevBubble) {
          state.parkedThinkingByAgent[previousAgent] = prevBubble;
          prevBubble.remove();
        }
      }
      state.activeAgent = nextAgent;
      // Reset the dedup guard so refreshChatLog actually rebuilds for the new agent.
      log.dataset.lastId = '';
      log.dataset.count = '';
      log.innerHTML = '';
      // If the new agent had a parked bubble (we switched away mid-stream),
      // re-attach it so the user sees it's still working.
      const parked = state.parkedThinkingByAgent[nextAgent];
      if (parked) {
        log.appendChild(parked);
        delete state.parkedThinkingByAgent[nextAgent];
      }
      renderAgents();
      refreshChatLog();
    });
    attachCursorTracking(el);
  });
}

function attachCursorTracking(el) {
  el.addEventListener('mousemove', (e) => {
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    el.style.setProperty('--my', `${e.clientY - rect.top}px`);
  });
}

// ─── Chat ─────────────────────────────────────────────────
async function refreshChatLog() {
  if (!state.activeAgent) return;
  // Only bail if the active agent has its own thinking bubble in the DOM.
  // A bubble belonging to a different agent (the user switched away mid-stream)
  // must not block this refresh — otherwise the chat view stays frozen on the
  // previous agent until the original fetch resolves.
  const log = $('log');
  const ownThinking = log.querySelector(`.msg.thinking[data-agent="${state.activeAgent}"]`);
  if (ownThinking) return;
  const agentId = state.activeAgent;
  let r;
  try { r = await fetch(`/api/conversation/${agentId}`).then(r => r.json()); }
  catch { return; }
  // If the user switched agents while the fetch was in flight, drop the result.
  if (state.activeAgent !== agentId) return;
  // Skip re-render if nothing changed (avoids scroll jumps during polling).
  const lastId = r.entries.length ? r.entries[r.entries.length - 1].id : 0;
  if (log.dataset.lastId === String(lastId) && log.dataset.count === String(r.entries.length)) return;
  log.dataset.lastId = String(lastId);
  log.dataset.count = String(r.entries.length);
  log.innerHTML = r.entries.map(e => {
    const serverImgs = renderAttachmentImages(e);
    const imgs = serverImgs || renderRecentLocalFallback(e, agentId);
    return `
    <div class="msg ${e.role}">
      <div class="who">${whoLabelFor(e, agentId)}</div>
      <div class="body">${renderMessage(e.text, { messageId: e.id, consumedBlocks: e.meta?.consumed_blocks })}${imgs}</div>
    </div>
  `;
  }).join('');
  log.scrollTop = log.scrollHeight;
}
/** Render local-only image thumbnails for the optimistic user-turn — uses
 *  base64 data URIs from attachmentsPayload() so the user sees their image
 *  immediately, before the server has saved it to /store/attachments. After
 *  refreshChatLog runs, the server-sourced version takes over (same .msg-img
 *  class so there's no visual jump). */
function renderLocalAttachments(images) {
  if (!Array.isArray(images) || images.length === 0) return '';
  return images.map(img => {
    if (!img || !img.data || !img.mimeType) return '';
    return `<img class="msg-img" src="data:${img.mimeType};base64,${img.data}" alt="${escapeHtml(img.name || 'attachment')}">`;
  }).join('');
}

function appendLogMsg(text, who, images) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  const body = renderMessage(text) + renderLocalAttachments(images);
  div.innerHTML = `<div class="who">${who}</div><div class="body">${body}</div>`;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}

/** Append a "thinking" placeholder bubble (animated dots) and return its element so caller can remove it.
 *  Tagged with data-agent so refreshChatLog and the agent-switch handler can
 *  tell whose bubble this is (multiple agents can be in-flight at once). */
function appendThinkingBubble(logEl, label = 'thinking', agentId = null) {
  const div = document.createElement('div');
  div.className = 'msg thinking';
  if (agentId) div.dataset.agent = agentId;
  div.innerHTML = `<div class="who">${escapeHtml(label)}</div><div class="dots"><span></span><span></span><span></span></div>`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}
// Enter sends, Shift+Enter inserts newline.
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  const images = attachmentsPayload('main');
  if (!text && images.length === 0) return;
  // Snapshot the target agent at submit time. The user may switch agents
  // mid-flight; the in-flight bookkeeping must follow the original target,
  // not whatever is active when the fetch resolves.
  const targetAgent = state.activeAgent;
  $('send').disabled = true;
  state.chatSendingByAgent[targetAgent] = true;
  appendLogMsg(text, 'user', images);
  $('input').value = '';
  if (images.length > 0) {
    state.recentLocalAttachments.push({ agent: targetAgent, images, ts: Date.now() });
    // Cap the FIFO so base64 data doesn't grow unbounded.
    while (state.recentLocalAttachments.length > 10) state.recentLocalAttachments.shift();
  }
  clearAttachments('main', 'composer-attachments');
  const thinking = appendThinkingBubble($('log'), targetAgent ?? 'agent', targetAgent);
  try {
    const r = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text || '(image attached)', agent: targetAgent, images }),
    }).then(r => r.json());
    // Remove the thinking bubble whether it's still in the live log or parked.
    thinking.remove();
    if (state.parkedThinkingByAgent[targetAgent] === thinking) {
      delete state.parkedThinkingByAgent[targetAgent];
    }
    // Only paint replies into the visible log if the user is still on the
    // target agent. Otherwise the agent's history will surface naturally
    // when they switch back (refreshChatLog reads from the server).
    if (state.activeAgent === targetAgent) {
      if (r.replies) {
        for (const rep of r.replies) appendLogMsg(`[${rep.agent}]\n${rep.text}`, rep.ok ? 'assistant' : 'system');
      } else if (r.error) {
        appendLogMsg(r.error, 'system');
      }
      // Force a full re-render so the user-turn shows its image thumbnails from
      // the canonical conversation_log rather than the optimistic placeholder.
      refreshChatLog();
    }
  } catch (err) {
    thinking.remove();
    if (state.parkedThinkingByAgent[targetAgent] === thinking) {
      delete state.parkedThinkingByAgent[targetAgent];
    }
    if (state.activeAgent === targetAgent) {
      appendLogMsg('Error: ' + err.message, 'system');
    }
  } finally {
    $('send').disabled = false;
    state.chatSendingByAgent[targetAgent] = false;
    refreshAuditSide();
  }
});

/** Free-text filter for the audit-side panel. */
let auditFilter = '';

async function refreshAuditSide() {
  try {
    const r = await fetch('/api/audit-log?limit=30').then(r => r.json());
    const q = (auditFilter || '').toLowerCase();
    const rows = q
      ? r.entries.filter(e => `${e.action} ${e.actor_id ?? ''} ${e.target ?? ''}`.toLowerCase().includes(q))
      : r.entries;
    $('audit-side').innerHTML = rows.map(e => `
      <div class="audit-row">
        <span class="t">${new Date(e.ts).toLocaleTimeString()}</span>
        <span class="a">${e.action}</span>
        <span class="x">${e.actor_id ?? ''}${e.target ? ' → ' + escapeHtml(e.target) : ''}</span>
      </div>
    `).join('');
  } catch (err) {
    console.warn('[refreshAuditSide] failed:', err);
  }
}

// ─── War Room ─────────────────────────────────────────────
async function runWarroomCommand(text) {
  const meeting = $('wr-meeting');
  meeting.innerHTML = '';
  // Render placeholder cards for all warroom-eligible agents so the user
  // sees something while the (sequential) calls run.
  const wrAgents = state.agents.filter(a => a.warroom !== false);
  wrAgents.forEach((a, i) => {
    const card = document.createElement('div');
    card.className = 'wr-card loading';
    card.dataset.agent = a.id;
    card.style.animationDelay = `${i * 60}ms`;
    card.innerHTML = `<div class="who">${escapeHtml(a.display_name)} · @${a.id}</div><div class="text">thinking</div>`;
    meeting.appendChild(card);
  });
  try {
    const r = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(r => r.json());
    meeting.innerHTML = '';
    if (!r.replies) {
      meeting.innerHTML = `<div class="empty">${escapeHtml(r.error || 'no reply')}</div>`;
      return;
    }
    r.replies.forEach((rep, i) => {
      const isConsolidator = rep.agent.includes('consolidator');
      const card = document.createElement('div');
      card.className = `wr-card ${isConsolidator ? 'consolidator' : ''}`;
      card.style.animationDelay = `${i * 60}ms`;
      card.innerHTML = `<div class="who">${escapeHtml(rep.agent)}</div><div class="text">${renderMessage(rep.text)}</div>`;
      meeting.appendChild(card);
    });
  } catch (err) {
    meeting.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`;
  }
  refreshWarroomHistory();
}
$('wr-standup').addEventListener('click', () => runWarroomCommand('/standup'));
$('wr-discuss').addEventListener('click', () => openModal('modal-discuss'));
$('discuss-cancel').addEventListener('click', () => closeModal('modal-discuss'));
$('discuss-go').addEventListener('click', () => {
  const q = $('discuss-text').value.trim();
  if (!q) return;
  closeModal('modal-discuss');
  $('discuss-text').value = '';
  runWarroomCommand(`/discuss ${q}`);
});

async function refreshWarroomHistory() {
  try {
    const r = await fetch('/api/warroom/transcripts').then(r => r.json());
    const sel = $('wr-history');
    sel.innerHTML = '<option value="">history…</option>' + r.meetings.map(m => `
      <option value="${m.meeting_id}">${m.command} · ${new Date(m.started).toLocaleString()} · ${m.entries} entries</option>
    `).join('');
  } catch {}
}
$('wr-history').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id) return;
  const r = await fetch(`/api/warroom/transcripts/${id}`).then(r => r.json());
  const meeting = $('wr-meeting');
  meeting.innerHTML = '';
  // group: prompt+response per agent, consolidator at end
  const responses = r.entries.filter(x => x.role === 'response');
  const consolidator = r.entries.find(x => x.role === 'consolidator');
  for (const resp of responses) {
    const card = document.createElement('div');
    card.className = 'wr-card';
    card.innerHTML = `<div class="who">@${escapeHtml(resp.agent_id)}</div><div class="text">${renderMessage(resp.text)}</div>`;
    meeting.appendChild(card);
  }
  if (consolidator) {
    const card = document.createElement('div');
    card.className = 'wr-card consolidator';
    card.innerHTML = `<div class="who">main · consolidator</div><div class="text">${renderMessage(consolidator.text)}</div>`;
    meeting.appendChild(card);
  }
});

// ─── Team discussions ─────────────────────────────────────
let activeThreadId = null;
let lastDiscussionSig = '';

async function refreshDiscussions() {
  try {
    const r = await fetch('/api/discussions').then(r => r.json());
    const list = $('td-thread-list');
    if (!list) return;
    if (!r.threads || r.threads.length === 0) {
      list.innerHTML = '<div class="empty" style="padding:14px">No threads yet.</div>';
    } else {
      list.innerHTML = r.threads.map(t => `
        <div class="td-thread-row ${t.thread_id === activeThreadId ? 'active' : ''}" data-tid="${t.thread_id}">
          <div class="td-thread-row-title">${escapeHtml(t.title)}</div>
          <div class="td-thread-row-meta">${t.participants.map(p => `@${escapeHtml(p)}`).join(' · ')}</div>
          <div class="td-thread-row-age">${ageText(t.last_activity)}</div>
        </div>
      `).join('');
      qsa('.td-thread-row').forEach(el => {
        el.addEventListener('click', () => openDiscussion(el.dataset.tid));
      });
    }
    if (activeThreadId) await refreshActiveDiscussion();
  } catch {}
}

async function openDiscussion(threadId) {
  activeThreadId = threadId;
  lastDiscussionSig = '';
  qsa('.td-thread-row').forEach(el => el.classList.toggle('active', el.dataset.tid === threadId));
  $('td-thread-empty').hidden = true;
  $('td-thread-view').hidden = false;
  await refreshActiveDiscussion(true);
}

async function refreshActiveDiscussion(force = false) {
  if (!activeThreadId) return;
  try {
    const r = await fetch(`/api/discussions/${activeThreadId}`).then(r => r.json());
    if (!r.ok) return;
    const sig = `${r.thread.last_activity}:${r.turns.length}`;
    if (!force && sig === lastDiscussionSig) return;
    lastDiscussionSig = sig;
    $('td-thread-title').textContent = r.thread.title;
    $('td-thread-meta').textContent = `${r.thread.participants.map(p => `@${p}`).join(' · ')} · ${r.turns.length} turns`;
    const turns = $('td-turns');
    turns.innerHTML = r.turns.map(t => {
      const who = t.agent_id ? `@${escapeHtml(t.agent_id)}` : 'tkiljoy';
      const cls = t.agent_id ? 'td-turn assistant' : 'td-turn user';
      return `<div class="${cls}"><div class="who">${who}</div><div class="body">${renderMessage(t.text, { messageId: t.id, consumedBlocks: t.meta?.consumed_blocks })}</div></div>`;
    }).join('');
    turns.scrollTop = turns.scrollHeight;
  } catch {}
}

async function loadAgentsForDiscussion() {
  // Use cached agent list from state if available; otherwise fetch.
  if (state.agents && state.agents.length > 0) return state.agents;
  try {
    const r = await fetch('/api/agents').then(r => r.json());
    return r.agents ?? [];
  } catch { return []; }
}

// Event handlers attach at module-load time. Module scripts run after DOM parse,
// so the elements always exist by the time we get here.
$('td-new')?.addEventListener('click', async () => {
  const agents = await loadAgentsForDiscussion();
  $('td-new-participants').innerHTML = agents.map(a => `
    <label class="td-participant">
      <input type="checkbox" value="${escapeHtml(a.id)}" ${a.id === 'nox' ? '' : 'checked'}>
      <span>@${escapeHtml(a.id)} · ${escapeHtml(a.display_name)}</span>
    </label>
  `).join('');
  $('td-new-title').value = '';
  $('td-new-prompt').value = '';
  openModal('modal-discussion-new');
});
$('td-new-cancel')?.addEventListener('click', () => closeModal('modal-discussion-new'));
$('td-new-go')?.addEventListener('click', async () => {
  const title = $('td-new-title').value.trim();
  const prompt = $('td-new-prompt').value.trim();
  const participants = qsa('#td-new-participants input[type=checkbox]:checked').map(c => c.value);
  if (!title || !prompt || participants.length === 0) {
    alert('Need title, opening prompt, and at least one participant.');
    return;
  }
  const goBtn = $('td-new-go');
  goBtn.disabled = true;
  goBtn.textContent = 'Spawning…';
  try {
    const r = await fetch('/api/discussions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, participants, openingPrompt: prompt }),
    }).then(r => r.json());
    if (!r.ok) {
      alert('Failed: ' + (r.error ?? 'unknown'));
      return;
    }
    closeModal('modal-discussion-new');
    await refreshDiscussions();
    await openDiscussion(r.thread.thread_id);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = 'Start thread';
  }
});
$('td-composer')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeThreadId) return;
  const text = $('td-input').value.trim();
  if (!text) return;
  const send = $('td-send');
  send.disabled = true;
  $('td-input').value = '';
  try {
    const r = await fetch(`/api/discussions/${activeThreadId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(r => r.json());
    if (!r.ok) alert('Reply failed: ' + (r.error ?? 'unknown'));
    await refreshActiveDiscussion(true);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    send.disabled = false;
  }
});
$('td-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('td-composer').requestSubmit();
  }
});

// ─── Missions kanban ──────────────────────────────────────
/** Pull a one-line title out of a mission prompt, plus a short body preview.
 *  Mission prompts are usually shaped as "<title sentence>. <details...>" or
 *  "<title>\n\n<details...>". We look for the first hard newline-break or
 *  sentence-end, fall back to a 90-char clamp of the first line. */
function splitMissionPrompt(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text) return { title: '(empty)', body: '' };
  // Prefer the first paragraph break.
  const paraIdx = text.indexOf('\n\n');
  let titlePart = paraIdx > -1 ? text.slice(0, paraIdx) : text;
  let bodyPart = paraIdx > -1 ? text.slice(paraIdx + 2) : '';
  // If the title part is itself multiple lines or too long, take just the
  // first sentence/line.
  const firstNewline = titlePart.indexOf('\n');
  if (firstNewline > -1) {
    if (!bodyPart) bodyPart = titlePart.slice(firstNewline + 1);
    titlePart = titlePart.slice(0, firstNewline);
  }
  if (titlePart.length > 110) {
    const cut = titlePart.lastIndexOf(' ', 100);
    titlePart = titlePart.slice(0, cut > 60 ? cut : 100) + '…';
  }
  // Trim body to a 220-char preview, collapse whitespace.
  bodyPart = bodyPart.replace(/\s+/g, ' ').trim();
  if (bodyPart.length > 220) bodyPart = bodyPart.slice(0, 217) + '…';
  return { title: titlePart, body: bodyPart };
}

const COLUMNS = [
  { key: 'queued', label: 'Queued' },
  { key: 'running', label: 'Running' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed / Cancelled', match: (s) => s === 'failed' || s === 'cancelled' },
];
/** Free-text filter for the kanban. Matches against agent_id, status,
 *  mission id (#42), and a substring of the prompt. Empty string = show all. */
let missionFilter = '';
function missionMatchesFilter(m, q) {
  if (!q) return true;
  const hay = `@${m.agent_id} ${m.status} #${m.id} ${m.prompt || ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every(tok => hay.includes(tok));
}

async function refreshMissions() {
  try {
    const r = await fetch('/api/missions').then(r => r.json());
    // Apply filter before signature/grouping so the rebuild reflects search.
    const visible = r.missions.filter(m => missionMatchesFilter(m, missionFilter));
    // Build a stable signature so we skip the full DOM rebuild when nothing changed.
    // ageText() output drifts every second, but that's a paint-only concern — the
    // signature compares structural state (id/status/created_at/started_at/ended_at)
    // so the kanban only repaints on real transitions.
    const sig = missionFilter + '||' + visible
      .map(m => `${m.id}:${m.status}:${m.created_at}:${m.started_at ?? 0}:${m.finished_at ?? 0}`)
      .join('|');
    const kanban = $('kanban');
    if (kanban.dataset.sig === sig) return;
    kanban.dataset.sig = sig;
    // Capture per-column scroll offsets before the rebuild so the user
    // doesn't get bounced to the top when missions tick (every 3s).
    const priorScroll = {};
    qsa('.kcol-body', kanban).forEach(el => {
      const col = el.dataset.col;
      if (col) priorScroll[col] = el.scrollTop;
    });
    const grouped = { queued: [], running: [], done: [], failed: [] };
    for (const m of visible) {
      if (m.status === 'queued') grouped.queued.push(m);
      else if (m.status === 'running') grouped.running.push(m);
      else if (m.status === 'done') grouped.done.push(m);
      else grouped.failed.push(m);
    }
    kanban.innerHTML = COLUMNS.map(c => `
      <div class="kcol">
        <div class="kcol-head ${c.key}">${c.label} <span class="count">${grouped[c.key].length}</span></div>
        <div class="kcol-body" data-col="${c.key}">
          ${grouped[c.key].map((m, i) => {
            const { title, body } = splitMissionPrompt(m.prompt);
            const dur = (m.started_at && m.finished_at)
              ? ` · ${Math.round((m.finished_at - m.started_at) / 1000)}s`
              : '';
            return `
            <div class="kcard" data-id="${m.id}" style="animation-delay: ${Math.min(i, 12) * 40}ms">
              <div class="kcard-head">
                <span class="agent-tag">@${escapeHtml(m.agent_id)}</span>
                <span class="kcard-id">#${m.id}</span>
              </div>
              <div class="kcard-title">${escapeHtml(title)}</div>
              ${body ? `<div class="kcard-body">${escapeHtml(body)}</div>` : ''}
              <div class="kcard-foot">
                <span>${ageText(m.created_at)}</span>
                <span>${dur}</span>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    `).join('');
    qsa('.kcard').forEach(el => {
      el.addEventListener('click', () => openMissionDetail(Number(el.dataset.id)));
      attachCursorTracking(el);
    });
    // Restore the captured scroll offsets after the rebuild so polling
    // doesn't disrupt the user's reading position.
    qsa('.kcol-body', kanban).forEach(el => {
      const col = el.dataset.col;
      if (col && priorScroll[col]) el.scrollTop = priorScroll[col];
    });
  } catch (err) {
    console.warn('[refreshMissions] failed:', err);
  }
}
$('mission-new').addEventListener('click', () => {
  const sel = $('mission-agent');
  sel.innerHTML = state.agents.map(a => `<option value="${a.id}">${a.display_name} · @${a.id}</option>`).join('');
  openModal('modal-mission');
});
$('mission-search').addEventListener('input', (e) => {
  missionFilter = e.target.value.trim();
  // Force a rebuild even when only the filter changed (sig would still match
  // structurally), then refresh.
  $('kanban').dataset.sig = '';
  refreshMissions();
});
$('audit-search').addEventListener('input', (e) => {
  auditFilter = e.target.value.trim();
  refreshAuditSide();
});
$('mission-cancel').addEventListener('click', () => closeModal('modal-mission'));
$('mission-create').addEventListener('click', async () => {
  const agent_id = $('mission-agent').value;
  const prompt = $('mission-prompt').value.trim();
  if (!prompt) return;
  const r = await fetch('/api/missions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id, prompt, watch: pendingMissionWatch }),
  }).then(r => r.json());
  $('mission-prompt').value = '';
  closeModal('modal-mission');
  refreshMissions();
  window.nox?.flashExcited();
  if (pendingMissionCardEl && r?.ok && r.id) {
    markMissionCardFiled(pendingMissionCardEl, r.id);
  }
  pendingMissionWatch = false;
  pendingMissionCardEl = null;
});
async function openMissionDetail(id) {
  const r = await fetch('/api/missions').then(r => r.json());
  const m = r.missions.find(x => x.id === id);
  if (!m) return;
  $('mission-detail-header').innerHTML = `
    <h2>Mission #${m.id}</h2>
    <div class="kv"><span class="k">Agent</span><span class="v">@${escapeHtml(m.agent_id)}</span></div>
    <div class="kv"><span class="k">Status</span><span class="v">${m.status}</span></div>
    <div class="kv"><span class="k">Created</span><span class="v">${new Date(m.created_at).toLocaleString()}</span></div>
  `;
  $('mission-detail-body').innerHTML = `
    <div class="kv"><span class="k">Prompt</span><span class="v long">${renderMessage(m.prompt)}</span></div>
    ${m.result ? `<div class="kv"><span class="k">Result</span><span class="v long">${renderMessage(m.result)}</span></div>` : ''}
  `;
  const actions = $('mission-detail-actions');
  actions.innerHTML = '';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.addEventListener('click', () => closeModal('modal-mission-detail'));
  if (m.status === 'queued') {
    const cancel = document.createElement('button');
    cancel.className = 'danger';
    cancel.textContent = 'Cancel mission';
    cancel.addEventListener('click', async () => {
      await fetch(`/api/missions/${m.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
      closeModal('modal-mission-detail');
      refreshMissions();
    });
    actions.appendChild(cancel);
  }
  // Retry/Re-run: re-file the same prompt as a fresh queued mission. The
  // mission worker will pick it up. Useful for failed runs (network blip,
  // transient timeout) and for repeating a successful mission with the
  // same brief.
  if (m.status === 'failed' || m.status === 'cancelled' || m.status === 'done') {
    const retry = document.createElement('button');
    retry.className = 'primary';
    retry.textContent = m.status === 'done' ? 'Re-run' : 'Retry';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        const r = await fetch('/api/missions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: m.agent_id,
            prompt: m.prompt,
            meta: m.meta_json ? JSON.parse(m.meta_json) : undefined,
          }),
        }).then(r => r.json());
        if (!r.ok) {
          alert((m.status === 'done' ? 'Re-run' : 'Retry') + ' failed: ' + (r.error ?? 'unknown'));
          retry.disabled = false;
          return;
        }
        closeModal('modal-mission-detail');
        refreshMissions();
      } catch (err) {
        alert('Network error: ' + err.message);
        retry.disabled = false;
      }
    });
    actions.appendChild(retry);
  }
  actions.appendChild(close);
  openModal('modal-mission-detail');
}

// ─── Hive Mind feed ───────────────────────────────────────
function deriveWorkingSet(entries) {
  // Entries arrive newest-first per /api/hive-mind. The newest spawn_started/
  // spawn_finished event per agent decides whether they're currently working.
  const seen = new Set();
  const working = new Set();
  for (const e of entries) {
    if (e.event !== 'spawn_started' && e.event !== 'spawn_finished') continue;
    if (seen.has(e.agent_id)) continue;
    seen.add(e.agent_id);
    if (e.event === 'spawn_started') working.add(e.agent_id);
  }
  return working;
}

async function refreshHiveMind() {
  try {
    const r = await fetch('/api/hive-mind').then(r => r.json());
    const working = deriveWorkingSet(r.entries);
    // Surface a header strip showing currently-working agents so the Pulse list
    // doesn't only show post-hoc events.
    const workingStrip = working.size > 0
      ? `<div class="hm-working"><span class="hm-working-label">WORKING</span>${[...working].map(id => `<span class="hm-working-agent">@${escapeHtml(id)}</span>`).join('')}</div>`
      : '';
    const feed = r.entries.map(e => {
      const isWorking = working.has(e.agent_id);
      const cls = isWorking ? 'hm-row working' : 'hm-row';
      return `
        <div class="${cls}">
          <span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>
          <span class="agent">@${escapeHtml(e.agent_id)}${isWorking ? '<span class="hm-row-dot" title="currently working"></span>' : ''}</span>
          <span class="event">${e.event}</span>
          <span class="summary" title="${escapeHtml(e.summary || '')}">${escapeHtml(e.summary || '')}</span>
        </div>
      `;
    }).join('');
    $('hivemind-feed').innerHTML = workingStrip + (feed || '<div class="empty">No activity yet. Send a message to any agent to populate this feed.</div>');
  } catch {}
}
$('hm-refresh').addEventListener('click', refreshHiveMind);

// ─── Hive Mind sub-view toggle (List / Graph / Brain) ─────
let hmGraphInstance = null;
let hmBrainInstance = null;
let hmActiveSubview = 'list';

function showHivemindSubview(name) {
  hmActiveSubview = name;
  localStorage.setItem('dhs-lair-pulse-view', name);
  qsa('.hm-toggle').forEach(b => b.classList.toggle('active', b.dataset.hm === name));
  qsa('.hm-pane').forEach(p => p.classList.remove('active'));
  if (name === 'list') {
    $('hivemind-feed').classList.add('active');
    pauseHivemindSubviews({ except: 'list' });
  } else if (name === 'graph') {
    $('hivemind-graph').classList.add('active');
    if (!hmGraphInstance) hmGraphInstance = new HivemindGraph($('hm-graph-svg'));
    pauseHivemindSubviews({ except: 'graph' });
  } else if (name === 'brain') {
    $('hivemind-brain').classList.add('active');
    if (!hmBrainInstance) {
      try {
        hmBrainInstance = new HivemindBrain($('hm-brain-canvas'));
      } catch (err) {
        console.error('[brain] init failed:', err);
        $('hm-brain-canvas').innerHTML = `<div class="empty">Brain view failed to initialize: ${escapeHtml(err.message)}</div>`;
      }
    }
    pauseHivemindSubviews({ except: 'brain' });
  }
}

function pauseHivemindSubviews(opts = {}) {
  // Renderers stay alive (cheap) but we don't dispose them; just hidden via .active class.
  // Their internal timers keep polling so the data stays warm when the user comes back.
  // If you ever notice perf issues, dispose-and-recreate logic goes here.
}

qsa('.hm-toggle').forEach(b => {
  b.addEventListener('click', () => showHivemindSubview(b.dataset.hm));
});

// ─── Suggestions ──────────────────────────────────────────
async function refreshSuggestionBadge() {
  try {
    const r = await fetch('/api/suggestions/count').then(r => r.json());
    const badge = $('sugg-badge');
    if (r.pending > 0) {
      badge.textContent = r.pending;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch {}
}

async function refreshSuggestions() {
  const filter = $('sugg-filter').value;
  const typeFilter = $('sugg-type-filter').value;
  const r = await fetch(`/api/suggestions?include=${filter === 'all' ? 'all' : 'pending'}`).then(r => r.json());
  const list = $('sugg-list');
  if (r.lastRun) {
    const ago = ageText(r.lastRun.ts);
    const counts = JSON.parse(r.lastRun.by_type_json || '{}');
    $('sugg-runinfo').textContent = `Last run ${ago} · ${r.lastRun.outcome} · split=${counts.agent_split || 0} stale=${counts.stale_mission || 0}`;
  } else {
    $('sugg-runinfo').textContent = 'Never run yet';
  }
  // Apply type filter client-side; the API only knows pending/all.
  const visible = typeFilter === 'all'
    ? (r.suggestions || [])
    : (r.suggestions || []).filter(s => s.suggestion_type === typeFilter || s.type === typeFilter);
  if (visible.length === 0) {
    const tag = filter === 'all' ? '' : 'pending ';
    const tagType = typeFilter === 'all' ? '' : ` of type "${typeFilter}"`;
    list.innerHTML = `<div class="empty">No ${tag}suggestions${tagType}. Click "Run now" to scan for overloaded agents and stale missions.</div>`;
    return;
  }
  list.innerHTML = visible.map((s, i) => renderSuggestion(s, i)).join('');
  qsa('.sugg-actions button').forEach(b => {
    b.addEventListener('click', () => suggestionAction(Number(b.dataset.id), b.dataset.action));
  });
}

function renderSuggestion(s, i) {
  const isResolved = s.status === 'accepted' || s.status === 'dismissed';
  const actions = (s.status === 'pending' || s.status === 'snoozed') ? `
    <div class="sugg-actions">
      <button class="primary green" data-id="${s.id}" data-action="accept">Accept · file mission</button>
      <button data-id="${s.id}" data-action="snooze">Snooze 7d</button>
      <button class="danger" data-id="${s.id}" data-action="dismiss">Dismiss</button>
    </div>
  ` : `
    <div class="sugg-actions">
      <span class="muted">Resolved ${s.status_changed_at ? new Date(s.status_changed_at).toLocaleString() : ''}${s.filed_mission_id ? ` → mission #${s.filed_mission_id}` : ''}</span>
    </div>
  `;
  return `
    <div class="sugg-card type-${s.suggestion_type} ${isResolved ? 'resolved' : ''}" style="animation-delay: ${i * 50}ms">
      <div class="sugg-header">
        <div class="sugg-title">${escapeHtml(s.title)}</div>
        <div class="sugg-tags">
          <span class="sugg-tag kind-${s.suggestion_type}">${s.suggestion_type.replace('_', ' ')}</span>
          <span class="sugg-tag status-${s.status}">${s.status}</span>
        </div>
      </div>
      <div class="sugg-rationale">${escapeHtml(s.rationale)}</div>
      <div class="sugg-meta">
        ${s.target_agent_id ? `<span>agent: @${s.target_agent_id}</span>` : ''}
        ${s.related_mission_id ? `<span>mission #${s.related_mission_id}</span>` : ''}
        <span>filed ${ageText(s.ts)}</span>
      </div>
      ${actions}
    </div>
  `;
}

async function suggestionAction(id, action) {
  const url = `/api/suggestions/${id}/${action}`;
  const body = action === 'snooze' ? JSON.stringify({ days: 7 }) : '{}';
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(r => r.json());
  if (!r.ok) {
    alert(`${action} failed: ${r.error}`);
    return;
  }
  if (action === 'accept') {
    alert(`Mission #${r.filedMissionId} filed.`);
    window.nox?.flashExcited();
  }
  refreshSuggestions();
  refreshSuggestionBadge();
  refreshAuditSide();
}

$('sugg-filter').addEventListener('change', refreshSuggestions);
$('sugg-type-filter').addEventListener('change', refreshSuggestions);
$('sugg-run').addEventListener('click', async () => {
  $('sugg-run').disabled = true;
  $('sugg-runinfo').textContent = 'Running…';
  try {
    const r = await fetch('/api/suggestions/run', { method: 'POST' }).then(r => r.json());
    if (!r.ok) alert(`Run failed: ${r.error}`);
  } catch (err) {
    alert('Run error: ' + err.message);
  } finally {
    $('sugg-run').disabled = false;
    refreshSuggestions();
    refreshSuggestionBadge();
  }
});

// ─── Settings ─────────────────────────────────────────────
async function refreshSettings() {
  await refreshHealth();
  // switches
  const html = Object.entries(state.switches).map(([k, v]) => {
    const locked = (k === 'DASHBOARD_MUTATIONS_ENABLED' && v === true);
    return `
      <div class="switch-row">
        <span class="switch-name">${k}</span>
        <span class="switch-desc">${SWITCH_DESCRIPTIONS[k] || ''}</span>
        <div class="switch-toggle ${v ? 'on' : ''} ${locked ? 'locked' : ''}" data-switch="${k}" data-value="${v}" title="${locked ? 'Edit .env to disable this' : 'Click to toggle'}"></div>
      </div>`;
  }).join('');
  $('switches').innerHTML = html;
  qsa('.switch-toggle[data-switch]').forEach(el => {
    el.addEventListener('click', async () => {
      if (el.classList.contains('locked')) return;
      const name = el.dataset.switch;
      const next = el.dataset.value !== 'true';
      el.classList.add('locked');
      try {
        const r = await fetch('/api/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, value: next }),
        }).then(r => r.json());
        if (!r.ok) alert('Switch refused: ' + r.error);
      } catch (err) {
        alert('Switch error: ' + err.message);
      }
      setTimeout(refreshSettings, 1700);
    });
  });
  // paths — pulled from /api/config so the displayed values track .env on
  // the running deployment instead of being hardcoded for one machine.
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    const cfgEntries = [
      { label: 'Working dir', value: cfg.workingDir || '(unknown)' },
      { label: 'DHS Vault (read-only)', value: cfg.dhsVaultPath || '(not set in .env)' },
      { label: '[DHS] resources (read+write for dev)', value: cfg.dhsResourcesPath || '(not set in .env)' },
      { label: 'SQLite db', value: cfg.dbPath || 'store/dhs.db' },
    ];
    $('paths').innerHTML = cfgEntries.map(p => `
      <div class="path-row">
        <div class="label">${p.label}</div>
        <div class="value">${escapeHtml(p.value)}</div>
      </div>
    `).join('');
  } catch (err) {
    console.warn('[refreshSettings paths] failed:', err);
  }
  // memory tier (with Gemini health surfacing)
  let geminiHealth = null;
  try { geminiHealth = await fetch('/api/gemini/health').then(r => r.json()); } catch {}
  let healthLine = '';
  let actionLine = '';
  if (geminiHealth) {
    if (!geminiHealth.configured) {
      healthLine = `<div class="kv"><span class="k">Status</span><span class="v cfg-status warn">no GEMINI_API_KEY in .env</span></div>`;
    } else if (geminiHealth.recentOk) {
      // A Gemini call (any category) has succeeded in the last hour — system
      // is healthy regardless of whether the per-category tracker is stale.
      const last = geminiHealth.recentOk;
      const inserted = geminiHealth.lastConsolidation?.ok ? `${geminiHealth.lastConsolidation.rowsInserted} facts extracted` : `last call: ${last.category ?? 'gemini'}`;
      healthLine = `<div class="kv"><span class="k">Status</span><span class="v cfg-status ok">healthy · ${ageText(last.ts)} on ${escapeHtml(last.model)} · ${escapeHtml(inserted)}</span></div>`;
      // If the cached lastConsolidation is stale and red, offer a one-click refresh.
      if (geminiHealth.lastConsolidation && !geminiHealth.lastConsolidation.ok) {
        actionLine = `<div class="kv"><span class="k">Action</span><span class="v"><button id="memory-consolidate-btn" style="height:auto;padding:6px 12px;font-size:9px">Run consolidation now</button> <span class="muted">(stale failed run from before the model swap — clear it)</span></span></div>`;
      }
    } else if (geminiHealth.lastConsolidation === null) {
      healthLine = `<div class="kv"><span class="k">Status</span><span class="v">configured · no consolidation has run yet</span></div>`;
      actionLine = `<div class="kv"><span class="k">Action</span><span class="v"><button id="memory-consolidate-btn" style="height:auto;padding:6px 12px;font-size:9px">Run consolidation now</button></span></div>`;
    } else if (geminiHealth.lastConsolidation.ok) {
      healthLine = `<div class="kv"><span class="k">Status</span><span class="v cfg-status ok">healthy · last run ${ageText(geminiHealth.lastConsolidation.ts)} (${geminiHealth.lastConsolidation.rowsInserted} facts extracted)</span></div>`;
    } else {
      const err = String(geminiHealth.lastConsolidation.error ?? 'unknown error');
      const isQuota = /429|quota|limit\s*:\s*0/i.test(err);
      const summary = isQuota
        ? 'rate-limited (429). Likely cause: API key project has no quota — re-issue at aistudio.google.com/app/apikey'
        : err.slice(0, 200);
      healthLine = `<div class="kv"><span class="k">Status</span><span class="v cfg-status err">FAILING · ${escapeHtml(summary)}</span></div>`;
      actionLine = `<div class="kv"><span class="k">Action</span><span class="v"><button id="memory-consolidate-btn" style="height:auto;padding:6px 12px;font-size:9px">Retry now</button></span></div>`;
    }
  }
  $('memory-status').innerHTML = `
    <div class="kv"><span class="k">Tier</span><span class="v">2 (FTS5 + Gemini Flash extraction)</span></div>
    <div class="kv"><span class="k">Cadence</span><span class="v">every 30 min</span></div>
    ${healthLine}
    ${actionLine}
    <p class="muted">Tier 2 needs <code>GEMINI_API_KEY</code> in <code>.env</code>. Without one the Hive falls back to Tier 1 (conversation history only).</p>
  `;
  const consolidateBtn = $('memory-consolidate-btn');
  if (consolidateBtn) {
    consolidateBtn.addEventListener('click', async () => {
      consolidateBtn.disabled = true;
      consolidateBtn.textContent = 'Running…';
      try {
        const r = await fetch('/api/memory/consolidate', { method: 'POST' }).then(r => r.json());
        if (!r.ok) alert('Consolidation failed: ' + (r.error ?? r.result?.error ?? 'unknown'));
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        refreshSettings();
      }
    });
  }
  // switch history
  try {
    const r = await fetch('/api/audit-log?limit=200').then(r => r.json());
    const flips = r.entries.filter(e => e.action === 'kill_switch_flip').slice(0, 10);
    $('switch-history').innerHTML = flips.length ? flips.map(e => {
      const payload = e.payload_json ? JSON.parse(e.payload_json) : {};
      return `<div class="audit-row">
        <span class="t">${new Date(e.ts).toLocaleString()}</span>
        <span class="a">${escapeHtml(e.target)}</span>
        <span class="x">→ ${payload.value ? 'ON' : 'OFF'}</span>
      </div>`;
    }).join('') : '<div class="empty" style="padding:20px">No flips yet.</div>';
  } catch {}
  // models
  await refreshModelsCard();
  // usage
  await refreshUsageCard();
  // companions (static)
  $('companions').innerHTML = COMPANIONS.map(c => `
    <div class="companion-row">
      <div class="glyph">${c.glyph}</div>
      <div class="body">
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="role">${escapeHtml(c.role)}</div>
      </div>
    </div>
  `).join('');
}

// ─── Models card ──────────────────────────────────────────
async function refreshModelsCard() {
  const wrap = $('models-content');
  if (!wrap) return;
  let data;
  try {
    data = await fetch('/api/models').then(r => r.json());
  } catch {
    wrap.innerHTML = '<div class="usage-empty">Could not load model config.</div>';
    return;
  }
  const claudeOptions = data.claude.options.map(o => `
    <option value="${escapeHtml(o.id)}" ${o.id === data.claude.defaultModel ? 'selected' : ''}>${escapeHtml(o.label)}</option>
  `).join('');
  const claudeNote = data.claude.options.find(o => o.id === data.claude.defaultModel)?.note ?? '';
  const geminiOptions = data.gemini.options.map(o => `
    <option value="${escapeHtml(o.id)}" ${o.id === data.gemini.currentModel ? 'selected' : ''}>${escapeHtml(o.label)}</option>
  `).join('');
  const geminiNote = data.gemini.options.find(o => o.id === data.gemini.currentModel)?.note ?? '';
  // Per-agent overrides table — each row is a dropdown that posts to /api/models
  // with `agentModels: { <id>: <model|null> }`. Empty value = use default.
  const overrides = (data.agents ?? []).map(a => {
    const current = a.override ?? '';
    const opts = data.claude.options.map(o =>
      `<option value="${escapeHtml(o.id)}" ${o.id === current ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    ).join('');
    return `<div class="override-row">
      <span class="agent-name">@${escapeHtml(a.id)}</span>
      <select class="agent-model-select" data-agent="${escapeHtml(a.id)}">
        <option value="" ${current === '' ? 'selected' : ''}>Use default (${escapeHtml(data.claude.defaultModel)})</option>
        ${opts}
      </select>
      <span class="model-saved" data-saved-for="${escapeHtml(a.id)}">saved</span>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="model-row">
      <span class="label-col">Claude</span>
      <div>
        <select id="model-claude">${claudeOptions}</select>
        <span class="model-saved" id="model-claude-saved">saved</span>
      </div>
    </div>
    <div class="model-row"><div></div><div class="note" id="model-claude-note">${escapeHtml(claudeNote)}</div></div>
    <div class="model-row">
      <span class="label-col">Gemini</span>
      <div>
        <select id="model-gemini">${geminiOptions}</select>
        <span class="model-saved" id="model-gemini-saved">saved</span>
      </div>
    </div>
    <div class="model-row"><div></div><div class="note" id="model-gemini-note">${escapeHtml(geminiNote)}</div></div>
    <div class="model-overrides">
      <h3>Per-agent · effective model</h3>
      ${overrides}
    </div>
  `;

  $('model-claude').addEventListener('change', async (e) => {
    await saveModel({ defaultClaude: e.target.value }, 'model-claude-saved', 'model-claude-note', data.claude.options);
    refreshModelsCard();
  });
  $('model-gemini').addEventListener('change', async (e) => {
    await saveModel({ gemini: e.target.value }, 'model-gemini-saved', 'model-gemini-note', data.gemini.options);
    refreshModelsCard();
  });
  qsa('.agent-model-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const agentId = e.target.dataset.agent;
      const model = e.target.value || null;
      e.target.disabled = true;
      try {
        const r = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentModels: { [agentId]: model } }),
        }).then(r => r.json());
        if (!r.ok) {
          alert(`Save failed: ${r.error ?? 'unknown'}`);
          return;
        }
        const savedEl = qs(`[data-saved-for="${agentId}"]`);
        if (savedEl) {
          savedEl.classList.add('show');
          setTimeout(() => savedEl.classList.remove('show'), 1500);
        }
      } catch (err) {
        alert('Save error: ' + err.message);
      } finally {
        e.target.disabled = false;
        refreshModelsCard();
      }
    });
  });
}

async function saveModel(body, savedId, noteId, options) {
  try {
    const r = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    if (!r.ok) {
      alert(`Save failed: ${r.error}`);
      return;
    }
    const savedEl = $(savedId);
    if (savedEl) {
      savedEl.classList.add('show');
      setTimeout(() => savedEl.classList.remove('show'), 1500);
    }
  } catch (err) {
    alert('Save error: ' + err.message);
  }
}

// ─── Usage card ───────────────────────────────────────────
function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}
function fmtCost(n) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n < 10) return '$' + n.toFixed(2);
  if (n < 1000) return '$' + n.toFixed(2);
  return '$' + n.toFixed(0);
}

async function refreshUsageCard() {
  const grid = $('usage-grid');
  if (!grid) return;
  let report;
  try {
    report = await fetch('/api/usage').then(r => r.json());
  } catch {
    grid.innerHTML = '<div class="usage-empty">Could not load usage data.</div>';
    return;
  }
  const windows = [
    { key: 'today', label: 'Today' },
    { key: 'sevenDays', label: 'Last 7 days' },
    { key: 'allTime', label: 'All-time' },
  ];
  grid.className = 'usage-grid';
  grid.innerHTML = windows.map(w => {
    const data = report[w.key];
    const claudeRow = data.claude.callCount > 0
      ? `<div class="usage-row"><span class="src claude">Claude</span><span class="toks">${fmtTokens(data.claude.totalTokens)} tok · ${data.claude.callCount} calls</span><span class="price">${fmtCost(data.claude.costUsd)}</span></div>`
      : `<div class="usage-row"><span class="src claude">Claude</span><span class="toks usage-empty">no calls yet</span><span class="price">$0.00</span></div>`;
    const geminiRow = data.gemini.callCount > 0
      ? `<div class="usage-row"><span class="src gemini">Gemini</span><span class="toks">${fmtTokens(data.gemini.totalTokens)} tok · ${data.gemini.callCount} calls</span><span class="price">${fmtCost(data.gemini.costUsd)}</span></div>`
      : `<div class="usage-row"><span class="src gemini">Gemini</span><span class="toks usage-empty">no calls yet</span><span class="price">$0.00</span></div>`;
    return `
      <div class="usage-window">
        <div class="usage-window-label">${w.label}</div>
        <div class="usage-total">
          <span class="cost">${fmtCost(data.totalCostUsd)}</span>
          <span class="tokens">${fmtTokens(data.totalTokens)} tokens</span>
        </div>
        ${claudeRow}
        ${geminiRow}
      </div>
    `;
  }).join('');
}

// ─── Modal helpers ────────────────────────────────────────
function openModal(id) {
  $(id).hidden = false;
  $('nox-shell')?.classList.add('modal-open');
}
function closeModal(id) {
  $(id).hidden = true;
  // Only restore NOX if no other modal is still open.
  const anyOpen = qsa('.modal-overlay').some(o => !o.hidden);
  if (!anyOpen) $('nox-shell')?.classList.remove('modal-open');
}
qsa('.modal-overlay').forEach(o => o.addEventListener('click', (e) => {
  if (e.target === o) {
    o.hidden = true;
    const anyOpen = qsa('.modal-overlay').some(x => !x.hidden);
    if (!anyOpen) $('nox-shell')?.classList.remove('modal-open');
  }
}));
// Esc closes whichever modal-overlay is currently visible. NØX panel has
// its own Esc handler in initNoxChat; that fires first and short-circuits
// since modals layer above it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = qsa('.modal-overlay').filter(o => !o.hidden);
  if (open.length === 0) return;
  // Only close the topmost modal (last opened).
  open[open.length - 1].hidden = true;
  const anyOpen = qsa('.modal-overlay').some(x => !x.hidden);
  if (!anyOpen) $('nox-shell')?.classList.remove('modal-open');
});

// ─── NOX shell: drag-to-reposition + click-to-talk + persist ──────────────
function initNoxShellDrag() {
  const shell = $('nox-shell');
  if (!shell) return;

  // Restore saved position
  try {
    const saved = JSON.parse(localStorage.getItem('dhs-hive-nox-pos') ?? 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      shell.style.left = saved.left + 'px';
      shell.style.top = saved.top + 'px';
      shell.style.right = 'auto';
      shell.style.bottom = 'auto';
    }
  } catch {}

  const DRAG_THRESHOLD_PX = 4;   // movement above this = treat as drag, not click
  let pressed = false;
  let moved = false;
  let startX = 0, startY = 0;
  let offsetX = 0, offsetY = 0;

  shell.addEventListener('mousedown', (e) => {
    pressed = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = shell.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!pressed) return;
    if (!moved) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        moved = true;
        shell.classList.add('dragging');
      } else {
        return;
      }
    }
    const left = Math.max(0, Math.min(window.innerWidth - 130, e.clientX - offsetX));
    const top  = Math.max(56, Math.min(window.innerHeight - 117, e.clientY - offsetY));
    shell.style.left = left + 'px';
    shell.style.top = top + 'px';
    shell.style.right = 'auto';
    shell.style.bottom = 'auto';
  });

  window.addEventListener('mouseup', () => {
    if (!pressed) return;
    pressed = false;
    if (moved) {
      shell.classList.remove('dragging');
      const rect = shell.getBoundingClientRect();
      localStorage.setItem('dhs-hive-nox-pos', JSON.stringify({ left: rect.left, top: rect.top }));
    } else {
      // Treat as a click — jump to chat with NOX focused.
      onNoxClick();
    }
    moved = false;
  });
}

function onNoxClick() {
  toggleNoxChat();
}

// ─── NOX chat panel ────────────────────────────────────────
const noxChatState = { open: false, sending: false };

function positionNoxChat() {
  const panel = $('nox-chat');
  const shell = $('nox-shell');
  if (!panel || !shell) return;
  const shellRect = shell.getBoundingClientRect();
  const panelW = panel.offsetWidth || 420;
  const panelH = panel.offsetHeight || 540;
  const gap = 16;

  // Prefer above-and-left of the Eye. Fall back if off-screen.
  let left = shellRect.right - panelW;
  let top = shellRect.top - panelH - gap;
  if (top < 64) {                                 // not enough room above; place to the left
    top = Math.max(64, shellRect.top);
    left = shellRect.left - panelW - gap;
  }
  if (left < 16) {                                 // not enough room to the left; place to the right
    left = shellRect.right + gap;
  }
  // Clamp to viewport
  left = Math.max(16, Math.min(window.innerWidth - panelW - 16, left));
  top  = Math.max(64, Math.min(window.innerHeight - panelH - 16, top));
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

function openNoxChat() {
  if (noxChatState.open) return;
  noxChatState.open = true;
  $('nox-chat').hidden = false;
  positionNoxChat();
  refreshNoxChatLog();
  setTimeout(() => $('nox-chat-input')?.focus(), 60);
  window.nox?.flashExcited(600);
  // Mark all current NØX messages as seen — clear unread state.
  markNoxMessagesSeen();
}

function closeNoxChat() {
  if (!noxChatState.open) return;
  noxChatState.open = false;
  $('nox-chat').hidden = true;
}

function toggleNoxChat() {
  if (noxChatState.open) closeNoxChat();
  else openNoxChat();
}

function setNoxStatus(label) {
  const el = $('nox-chat-status');
  if (el) el.textContent = label;
}

async function refreshNoxChatLog() {
  // Skip rebuild if a thinking bubble is in the DOM, same reason as the
  // main chat refresh: rebuilding from the server feed wipes the dots.
  if ($('nox-chat-log').querySelector('.msg.thinking')) return;
  try {
    const r = await fetch('/api/conversation/nox').then(r => r.json());
    const log = $('nox-chat-log');
    const lastId = r.entries.length ? r.entries[r.entries.length - 1].id : 0;
    if (log.dataset.lastId === String(lastId) && log.dataset.count === String(r.entries.length)) return;
    log.dataset.lastId = String(lastId);
    log.dataset.count = String(r.entries.length);
    log.innerHTML = r.entries.map(e => `
      <div class="msg ${e.role}">
        <div class="who">${whoLabelFor(e, 'nox')}</div>
        <div class="body">${renderMessage(e.text, { messageId: e.id, consumedBlocks: e.meta?.consumed_blocks })}${renderAttachmentImages(e)}</div>
      </div>
    `).join('');
    log.scrollTop = log.scrollHeight;
  } catch (err) {
    console.warn('[refreshNoxChatLog] failed:', err);
  }
}

function appendNoxMsg(text, who, images) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  const body = renderMessage(text) + renderLocalAttachments(images);
  div.innerHTML = `<div class="who">${who === 'assistant' ? 'NØX' : who}</div><div class="body">${body}</div>`;
  $('nox-chat-log').appendChild(div);
  $('nox-chat-log').scrollTop = $('nox-chat-log').scrollHeight;
}

function initNoxChat() {
  $('nox-chat-close').addEventListener('click', closeNoxChat);
  // Enter sends, Shift+Enter inserts newline.
  $('nox-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('nox-chat-composer').requestSubmit();
    }
  });
  $('nox-chat-composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('nox-chat-input').value.trim();
    const images = attachmentsPayload('nox');
    if ((!text && images.length === 0) || noxChatState.sending) return;
    noxChatState.sending = true;
    $('nox-chat-send').disabled = true;
    appendNoxMsg(text, 'user', images);
    $('nox-chat-input').value = '';
    clearAttachments('nox', 'nox-chat-attachments');
    window.nox?.setEmotion('thinking');
    setNoxStatus('thinking');
    const thinking = appendThinkingBubble($('nox-chat-log'), 'NOX');
    try {
      const r = await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text || '(image attached)', agent: 'nox', images }),
      }).then(r => r.json());
      thinking.remove();
      window.nox?.setEmotion('talking');
      setNoxStatus('talking');
      if (r.replies) {
        for (const rep of r.replies) appendNoxMsg(rep.text, rep.ok ? 'assistant' : 'system');
      } else if (r.error) {
        appendNoxMsg(r.error, 'system');
      }
      refreshNoxChatLog();
    } catch (err) {
      thinking.remove();
      appendNoxMsg('Error: ' + err.message, 'system');
    } finally {
      noxChatState.sending = false;
      $('nox-chat-send').disabled = false;
      refreshAuditSide();
      setTimeout(() => {
        window.nox?.setEmotion('idle');
        setNoxStatus('idle');
      }, 800);
    }
  });
  // Esc closes; click outside closes.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && noxChatState.open) closeNoxChat();
  });
  document.addEventListener('mousedown', (e) => {
    if (!noxChatState.open) return;
    const panel = $('nox-chat');
    const shell = $('nox-shell');
    if (panel.contains(e.target) || shell.contains(e.target)) return;
    closeNoxChat();
  });
  // Reposition on resize / Eye drag end (Eye drag handler saves and reload-restores; we
  // also reposition opportunistically every second while open in case the Eye moved).
  window.addEventListener('resize', () => { if (noxChatState.open) positionNoxChat(); });
  setInterval(() => { if (noxChatState.open) positionNoxChat(); }, 1000);
}

// ─── NØX unread badge (mission follow-ups while panel is closed) ──
const NOX_LAST_SEEN_KEY = 'dhs-lair-nox-last-seen';
let noxUnreadLastCount = 0;

function getNoxLastSeenTs() {
  const v = Number(localStorage.getItem(NOX_LAST_SEEN_KEY));
  if (Number.isFinite(v) && v > 0) return v;
  // First visit — treat all existing assistant messages as already seen.
  const now = Date.now();
  localStorage.setItem(NOX_LAST_SEEN_KEY, String(now));
  return now;
}

function markNoxMessagesSeen() {
  localStorage.setItem(NOX_LAST_SEEN_KEY, String(Date.now()));
  noxUnreadLastCount = 0;
  const badge = $('nox-unread-badge');
  if (badge) { badge.textContent = ''; badge.classList.remove('show'); }
}

async function pollNoxUnread() {
  // If panel is open, the user is actively reading — keep last-seen current
  // and never show a badge.
  if (noxChatState.open) {
    localStorage.setItem(NOX_LAST_SEEN_KEY, String(Date.now()));
    noxUnreadLastCount = 0;
    const badge = $('nox-unread-badge');
    if (badge) { badge.textContent = ''; badge.classList.remove('show'); }
    return;
  }
  try {
    const since = getNoxLastSeenTs();
    const r = await fetch(`/api/nox/unread?since=${since}`).then(r => r.json());
    const count = Number(r?.count ?? 0);
    const badge = $('nox-unread-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.add('show');
      // Excited flash on transition from 0 → ≥1
      if (noxUnreadLastCount === 0) window.nox?.flashExcited(900);
    } else {
      badge.textContent = '';
      badge.classList.remove('show');
    }
    noxUnreadLastCount = count;
  } catch {}
}

// ─── Mission-card click handling (delegated, document-wide) ──
function initMissionCardHandlers() {
  document.addEventListener('click', async (e) => {
    const card = e.target.closest('.mission-card');
    if (!card || card.classList.contains('filed')) return;
    const fileBtn = e.target.closest('.mission-file-btn');
    const editBtn = e.target.closest('.mission-edit-btn');
    if (!fileBtn && !editBtn) return;

    let spec;
    try { spec = JSON.parse(card.dataset.missionSpec ?? '{}'); }
    catch { return; }
    if (!spec || !spec.agent_id || !spec.prompt) return;

    if (fileBtn) {
      // Direct file with the values exactly as proposed.
      fileBtn.disabled = true;
      try {
        const r = await fetch('/api/missions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: spec.agent_id,
            prompt: spec.title ? `${spec.title}\n\n${spec.prompt}` : spec.prompt,
            watch: spec.watch === true,
          }),
        }).then(r => r.json());
        if (!r.ok) {
          alert('File failed: ' + (r.error ?? 'unknown'));
          fileBtn.disabled = false;
          return;
        }
        markMissionCardFiled(card, r.id);
        window.nox?.flashExcited(900);
      } catch (err) {
        alert('File error: ' + err.message);
        fileBtn.disabled = false;
      }
      return;
    }

    if (editBtn) {
      // Pre-fill the existing "+ New mission" modal so the user can tweak before filing.
      // Re-populate the agent dropdown first (it's only built when the user clicks + New manually).
      const sel = $('mission-agent');
      sel.innerHTML = state.agents.map(a => `<option value="${a.id}" ${a.id === spec.agent_id ? 'selected' : ''}>${a.display_name} · @${a.id}</option>`).join('');
      const promptText = spec.title ? `${spec.title}\n\n${spec.prompt}` : spec.prompt;
      $('mission-prompt').value = promptText;
      pendingMissionWatch = spec.watch === true;
      pendingMissionCardEl = card;
      openModal('modal-mission');
    }
  });
}

let pendingMissionWatch = false;
let pendingMissionCardEl = null;

function markMissionCardFiled(card, missionId) {
  card.classList.add('filed');
  const tag = card.querySelector('.mission-card-tag');
  if (tag) tag.textContent = `FILED · #${missionId}`;
  card.querySelectorAll('button').forEach(b => { b.disabled = true; });
  persistBlockConsumption(card, 'mission', missionId);
}

function persistBlockConsumption(card, blockKind, missionId) {
  const messageId = card?.dataset?.messageId ? Number(card.dataset.messageId) : null;
  const blockIdx = card?.dataset?.blockIdx ? Number(card.dataset.blockIdx) : null;
  if (!Number.isFinite(messageId) || !Number.isFinite(blockIdx)) return;
  const payload = { messageId, blockKind, blockIdx };
  if (blockKind === 'mission' && Number.isFinite(missionId)) payload.missionId = missionId;
  fetch('/api/chat/mark-block-consumed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

// ─── Ask-card click handling (delegated, document-wide) ──
function initAskCardHandlers() {
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.ask-card');
    if (!card || card.classList.contains('answered')) return;

    // Find which composer this card belongs to (NØX panel or Chat tab).
    const inNoxLog = card.closest('#nox-chat-log');
    const inChatLog = card.closest('#log');
    if (!inNoxLog && !inChatLog) return;
    const inputEl = inNoxLog ? $('nox-chat-input') : $('input');
    const formEl = inNoxLog ? $('nox-chat-composer') : $('composer');
    if (!inputEl || !formEl) return;

    const optionBtn = e.target.closest('.ask-option');
    const otherBtn = e.target.closest('.ask-other-btn');
    const otherSendBtn = e.target.closest('.ask-other-send');

    if (optionBtn) {
      const value = optionBtn.dataset.askValue ?? optionBtn.textContent?.trim() ?? '';
      if (!value) return;
      lockAskCard(card);
      submitAsCurrentUser(inputEl, formEl, value);
      return;
    }
    if (otherBtn) {
      const otherWrap = card.querySelector('.ask-other');
      if (otherWrap) {
        otherWrap.hidden = false;
        otherWrap.querySelector('.ask-other-input')?.focus();
      }
      return;
    }
    if (otherSendBtn) {
      const ta = card.querySelector('.ask-other-input');
      const value = ta?.value?.trim();
      if (!value) return;
      lockAskCard(card);
      submitAsCurrentUser(inputEl, formEl, value);
      return;
    }
  });

  // Enter inside the ask-other textarea also sends; Shift+Enter inserts newline.
  document.addEventListener('keydown', (e) => {
    const ta = e.target.closest?.('.ask-other-input');
    if (!ta) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const card = ta.closest('.ask-card');
      const sendBtn = card?.querySelector('.ask-other-send');
      sendBtn?.click();
    }
  });
}

function lockAskCard(card) {
  card.classList.add('answered');
  card.querySelectorAll('button, textarea').forEach(el => { el.disabled = true; });
  persistBlockConsumption(card, 'ask');
}

function submitAsCurrentUser(inputEl, formEl, value) {
  inputEl.value = value;
  formEl.requestSubmit();
}

// ─── NOX init ─────────────────────────────────────────────
function initNox() {
  const canvasContainer = $('nox-canvas');
  if (!canvasContainer) return;
  const eye = new NoxEye(canvasContainer, {
    eyeColor: '#a88bfa',           // dark-mode default; sync below overrides for current mode
    bodyEl: $('nox-shell'),
  });
  window.nox = eye;
  syncNoxThemeColor();
  initNoxShellDrag();
  initNoxChat();
}

// ─── Boot ─────────────────────────────────────────────────
(async function init() {
  initNox();
  initAskCardHandlers();
  initMissionCardHandlers();
  // Wire image attachment inputs for both composers.
  wireAttachmentInputs('composer', 'input', 'composer-file', 'composer-attach', 'composer-attachments', 'main');
  wireAttachmentInputs('nox-chat-composer', 'nox-chat-input', 'nox-chat-file', 'nox-chat-attach', 'nox-chat-attachments', 'nox');
  await refreshHealth();
  await loadAgents();
  await refreshChatLog();
  await refreshAuditSide();
  showView('chat');
  // Wrap interval callbacks so we skip work when the tab is in the background.
  // CSS animations and rAF are throttled by the browser; HTTP polls are not,
  // so without this we'd waste cycles fetching while nobody's looking.
  const whenVisible = (fn) => () => { if (!document.hidden) fn(); };
  setInterval(whenVisible(refreshHealth), 5000);
  await refreshSuggestionBadge();
  setInterval(whenVisible(refreshSuggestionBadge), 30000);
  // NØX unread badge — polls for mission follow-ups while panel is closed.
  pollNoxUnread();
  setInterval(whenVisible(pollNoxUnread), 5000);
  // Auto-refresh the active chat log so agent replies / mission follow-ups
  // appear without the user having to click off and back on.
  startChatLogPolling();
  startNoxChatLogPolling();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // On tab focus, immediately refresh to catch up — but skip while a send
    // is in flight, otherwise the rebuild clobbers the locally-appended
    // thinking bubble and the user can't tell the agent is still working.
    if (state.activeAgent && !state.chatSendingByAgent[state.activeAgent]) refreshChatLog();
    if (noxChatState.open && !noxChatState.sending) refreshNoxChatLog();
  });
})();

function startChatLogPolling() {
  setInterval(() => {
    if (document.hidden) return;
    if (state.view !== 'chat') return;
    if (!state.activeAgent) return;
    // Skip the refresh only while the *active* agent has a send in flight —
    // its thinking bubble is locally-appended and not in the server feed.
    // A send to a different agent must not block the active agent's polling.
    if (state.chatSendingByAgent[state.activeAgent]) return;
    refreshChatLog();
  }, 4000);
}
function startNoxChatLogPolling() {
  setInterval(() => {
    if (document.hidden) return;
    if (!noxChatState.open) return;
    // While a send is in flight, the log holds a locally-appended thinking
    // bubble that is not in the server feed. Skipping the refresh prevents
    // the poll from clobbering the dots before the reply lands.
    if (noxChatState.sending) return;
    refreshNoxChatLog();
  }, 4000);
}
