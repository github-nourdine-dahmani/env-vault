/**
 * editor.js
 * Key-value / raw / txt editor logic for the currently selected env.
 * Depends on: storage.js, ui.js
 */

// -- State --------------------------------------------------------------------

let currentEnv   = null;   // The env object open in the editor
let currentGroup = null;   // The group that owns currentEnv
let editMode     = 'kv';   // 'kv' or 'raw'
let revealedRows = new Set();

// -- Sensitive-key detection --------------------------------------------------

const SENSITIVE_KEYWORDS = ['secret', 'key', 'token', 'pass', 'pwd', 'auth', 'private'];

function isSensitive(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYWORDS.some(w => lower.includes(w));
}

// -- Unified sync: flush current editor state back to currentEnv.vars ---------
//
// This is the SINGLE place that reads DOM inputs back into memory.
// Call it before saving, switching envs, duplicating, exporting, etc.

function syncCurrentEnv() {
  if (!currentEnv) return;

  if (currentEnv.type === 'txt') {
    const $ta = $('#txtTextarea');
    if ($ta.length) currentEnv.vars = $ta.val();
    return;
  }

  if (editMode === 'kv') {
    // Read KV table inputs into currentEnv.vars
    currentEnv.vars = [];
    $('.kv-row[data-idx]').each(function () {
      const k = $(this).find('.kv-key-inp').val().trim();
      const v = $(this).find('.kv-val-inp').val();
      const c = $(this).find('.kv-cmt-inp').val();
      if (k) currentEnv.vars.push({ k, v, c });
    });
  } else {
    // Parse raw textarea into currentEnv.vars
    const $ta = $('#rawTextarea');
    if (!$ta.length) return;
    const oldVars = currentEnv.vars;
    currentEnv.vars = [];
    for (const line of $ta.val().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (k) currentEnv.vars.push({ k, v, c: oldVars.find(e => e.k === k)?.c ?? '' });
    }
  }
}

// -- Mode switching -----------------------------------------------------------

function setMode(mode) {
  if (currentEnv?.type === 'txt') return;
  syncCurrentEnv();
  editMode = mode;
  $('#tabKv').toggleClass('active', mode === 'kv');
  $('#tabRaw').toggleClass('active', mode === 'raw');
  renderEditor();
}

// -- Rendering ----------------------------------------------------------------

function renderEditor() {
  const $area = $('#editorArea');
  if (!currentEnv) { $area.empty(); return; }

  const isTxt = currentEnv.type === 'txt';
  $('#tabKv, #tabRaw').toggle(!isTxt);
  $('#topbarCopyAll, #topbarExport').toggle(!isTxt);

  if (isTxt)             $area.html(renderTxtEditor());
  else if (editMode === 'kv') $area.html(renderKvEditor());
  else                        $area.html(renderRawEditor());
}

function renderKvEditor() {
  const { name, desc, vars } = currentEnv;
  const sensitiveCount = vars.filter(v => isSensitive(v.k)).length;
  const groupName = currentGroup ? escHtml(currentGroup.name) : '';

  return `
    <div class="env-header">
      <div class="env-title">
        ${groupName}<span class="env-title-sep">›</span>${escHtml(name)}
        <span class="tag">.env</span>
      </div>
    </div>
    <div class="env-stats">
      ${stat('📦', vars.length, 'Variables')}
      ${stat('🔑', sensitiveCount, 'Sensitive')}
      ${stat('📝', desc ? escHtml(desc) : '—', 'Description')}
    </div>
    <div class="kv-table">
      <div class="kv-header"><div>KEY</div><div>VALUE</div><div>COMMENT</div><div>ACTIONS</div></div>
      ${vars.map((v, i) => renderKvRow(v, i)).join('')}
      <button class="add-row-btn" onclick="addKvRow()">+ Add Variable</button>
    </div>`;
}

function renderRawEditor() {
  const raw = currentEnv.vars.map(v => `${v.k}="${v.v}"`).join('\n');
  const groupName = currentGroup ? escHtml(currentGroup.name) : '';

  return `
    <div class="env-header">
      <div class="env-title">
        ${groupName}<span class="env-title-sep">›</span>${escHtml(currentEnv.name)}
        <span class="tag">raw</span>
      </div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px">
      Edit your .env file directly. Click Save to apply changes.
    </p>
    <textarea class="raw-editor" id="rawTextarea" spellcheck="false"
      placeholder="KEY=value&#10;SECRET_KEY=abc123&#10;DATABASE_URL=postgres://...">${escHtml(raw)}</textarea>`;
}

function renderTxtEditor() {
  const { name, desc } = currentEnv;
  const content   = typeof currentEnv.vars === 'string' ? currentEnv.vars : '';
  const lineCount = content ? content.split('\n').length : 0;
  const groupName = currentGroup ? escHtml(currentGroup.name) : '';

  return `
    <div class="env-header">
      <div class="env-title">
        ${groupName}<span class="env-title-sep">›</span>${escHtml(name)}
        <span class="tag txt-tag">.txt</span>
      </div>
    </div>
    <div class="env-stats">
      ${stat('📝', lineCount, 'Lines')}
      ${stat('🔒', 'Encrypted', 'Storage')}
      ${stat('💬', desc ? escHtml(desc) : '—', 'Description')}
    </div>
    <textarea class="txt-editor" id="txtTextarea" spellcheck="false"
      placeholder="Type anything here — FTP credentials, API notes, SSH keys…\nThis file is stored encrypted.">${escHtml(content)}</textarea>`;
}

/** Render a single stat block (used in KV and TXT headers). */
function stat(icon, value, label) {
  return `<div class="stat"><div class="stat-icon">${icon}</div><div><div class="stat-val">${value}</div><div class="stat-label">${label}</div></div></div>`;
}

function renderKvRow(v, i) {
  const revealed  = revealedRows.has(i);
  const sensitive = isSensitive(v.k);
  const inputType = sensitive && !revealed ? 'password' : 'text';
  const revealBtn = sensitive
    ? `<button class="icon-btn vis" onclick="toggleReveal(${i})" title="${revealed ? 'Hide' : 'Reveal'}">${revealed ? '🙈' : '👁'}</button>`
    : '';

  return `
    <div class="kv-row" data-idx="${i}">
      <div class="kv-cell"><input class="kv-input kv-key kv-key-inp" value="${escHtml(v.k)}" placeholder="KEY_NAME" spellcheck="false" /></div>
      <div class="kv-cell"><input class="kv-input kv-val kv-val-inp" type="${inputType}" value="${escHtml(v.v)}" placeholder="value" spellcheck="false" /></div>
      <div class="kv-cell"><input class="kv-input kv-cmt kv-cmt-inp" value="${escHtml(v.c ?? '')}" placeholder="optional note…" spellcheck="false" /></div>
      <div class="kv-cell kv-actions">
        ${revealBtn}
        <button class="icon-btn" onclick="copyVal(${i})" title="Copy value">⎘</button>
        <button class="icon-btn del" onclick="deleteKvRow(${i})" title="Delete">✕</button>
      </div>
    </div>`;
}

// -- Row actions --------------------------------------------------------------

function toggleReveal(i) {
  revealedRows.has(i) ? revealedRows.delete(i) : revealedRows.add(i);
  syncCurrentEnv();
  renderEditor();
}

function addKvRow() {
  syncCurrentEnv();
  currentEnv.vars.push({ k: '', v: '', c: '' });
  renderEditor();
  $('.kv-key-inp').last().trigger('focus');
}

function deleteKvRow(i) {
  syncCurrentEnv();
  currentEnv.vars.splice(i, 1);
  renderEditor();
}

function copyVal(i) {
  syncCurrentEnv();
  const variable = currentEnv.vars[i];
  if (variable) {
    navigator.clipboard.writeText(variable.v);
    showToast(`Copied value of ${variable.k}`);
  }
}

// -- Toolbar actions ----------------------------------------------------------

async function saveProject() {
  if (!currentEnv) return;
  syncCurrentEnv();
  await saveVault(getMasterPassword());
  renderProjects();
  showToast('Saved & encrypted ✓');
}

function copyAll() {
  if (!currentEnv) return;
  syncCurrentEnv();
  const text = currentEnv.type === 'txt'
    ? (typeof currentEnv.vars === 'string' ? currentEnv.vars : '')
    : currentEnv.vars.map(v => `${v.k}="${v.v}"`).join('\n');
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard');
}

function exportEnv() {
  if (!currentEnv) return;
  syncCurrentEnv();

  const isTxt    = currentEnv.type === 'txt';
  const text     = isTxt ? (typeof currentEnv.vars === 'string' ? currentEnv.vars : '') : currentEnv.vars.map(v => `${v.k}="${v.v}"`).join('\n');
  const filename = isTxt ? `${currentEnv.name}.txt` : `.env.${currentEnv.name}`;

  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  showToast('Exported ✓');
}

// Aliases used by topbar buttons
function showRenameProject() { showRenameEnv(); }
function duplicateProject()  { duplicateEnv(); }
