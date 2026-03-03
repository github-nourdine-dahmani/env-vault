/**
 * editor.js
 * Key-value / raw editor logic for the currently selected env.
 * Depends on: storage.js, ui.js
 */

// ── App-level state ──────────────────────────────────────────────────────────

/** The env object currently open in the editor, or null. */
let currentEnv = null;

/** The group that owns currentEnv, or null. */
let currentGroup = null;

/** Current view mode: 'kv' or 'raw'. */
let editMode = 'kv';

/** Set of row indices whose values are currently revealed. */
let revealedRows = new Set();

// Keep legacy alias so any remaining references to currentProject still work
Object.defineProperty(window, 'currentProject', {
  get() { return currentEnv; },
  set(v) { currentEnv = v; },
});

// ── Sensitive-key detection ──────────────────────────────────────────────────

const SENSITIVE_KEYWORDS = ['secret', 'key', 'token', 'pass', 'pwd', 'auth', 'private'];

function isSensitive(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYWORDS.some(word => lower.includes(word));
}

// ── Mode switching ───────────────────────────────────────────────────────────

function setMode(mode) {
  if (currentEnv && currentEnv.type === 'txt') return; // txt files don't have kv/raw tabs
  if (mode === 'raw') syncKvToRaw();
  else                syncRawToKv();
  editMode = mode;
  $('#tabKv').toggleClass('active', mode === 'kv');
  $('#tabRaw').toggleClass('active', mode === 'raw');
  renderEditor();
}

// ── Sync helpers ─────────────────────────────────────────────────────────────

function syncKvToRaw() {
  if (!currentEnv) return;
  if (currentEnv.type === 'txt') return; // txt files sync separately
  currentEnv.vars = [];
  $('.kv-row[data-idx]').each(function () {
    const k = $(this).find('.kv-key-inp').val().trim();
    const v = $(this).find('.kv-val-inp').val();
    const c = $(this).find('.kv-cmt-inp').val();
    if (k) currentEnv.vars.push({ k, v, c });
  });
}

function syncRawToKv() {
  if (!currentEnv) return;
  if (currentEnv.type === 'txt') return; // txt files sync separately
  const $textarea = $('#rawTextarea');
  if (!$textarea.length) return;
  const oldVars = currentEnv.vars;
  currentEnv.vars = [];
  $textarea.val().split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) return;
    const k = line.slice(0, eqIdx).trim();
    const v = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    const existing = oldVars.find(e => e.k === k);
    if (k) currentEnv.vars.push({ k, v, c: existing?.c ?? '' });
  });
}

/** Sync the txt textarea back into currentEnv.vars (a plain string for txt files). */
function syncTxtToMem() {
  if (!currentEnv || currentEnv.type !== 'txt') return;
  const $ta = $('#txtTextarea');
  if ($ta.length) currentEnv.vars = $ta.val();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderEditor() {
  const $area = $('#editorArea');
  if (!currentEnv) { $area.empty(); return; }

  if (currentEnv.type === 'txt') {
    // Show/hide topbar tabs — txt files only have a single textarea view
    $('#tabKv, #tabRaw').hide();
    $('#topbarCopyAll, #topbarExport').hide();
    $area.html(renderTxtEditor());
  } else {
    $('#tabKv, #tabRaw').show();
    $('#topbarCopyAll, #topbarExport').show();
    $area.html(editMode === 'kv' ? renderKvEditor() : renderRawEditor());
  }
}

function renderKvEditor() {
  const { name, desc, vars } = currentEnv;
  const sensitiveCount = vars.filter(v => isSensitive(v.k)).length;
  return `
    <div class="env-header">
      <div class="env-title">
        ${escHtml(currentGroup ? currentGroup.name : '')}
        <span class="env-title-sep">›</span>
        ${escHtml(name)}
        <span class="tag">.env</span>
      </div>
    </div>
    <div class="env-stats">
      <div class="stat">
        <div class="stat-icon">📦</div>
        <div><div class="stat-val">${vars.length}</div><div class="stat-label">Variables</div></div>
      </div>
      <div class="stat">
        <div class="stat-icon">🔑</div>
        <div><div class="stat-val">${sensitiveCount}</div><div class="stat-label">Sensitive</div></div>
      </div>
      <div class="stat">
        <div class="stat-icon">📝</div>
        <div><div class="stat-val">${desc ? escHtml(desc) : '—'}</div><div class="stat-label">Description</div></div>
      </div>
    </div>
    <div class="kv-table">
      <div class="kv-header">
        <div>KEY</div><div>VALUE</div><div>COMMENT</div><div>ACTIONS</div>
      </div>
      ${vars.map((v, i) => renderKvRow(v, i)).join('')}
      <button class="add-row-btn" onclick="addKvRow()">+ Add Variable</button>
    </div>`;
}

function renderRawEditor() {
  const raw = currentEnv.vars.map(v => `${v.k}=${v.v}`).join('\n');
  return `
    <div class="env-header">
      <div class="env-title">
        ${escHtml(currentGroup ? currentGroup.name : '')}
        <span class="env-title-sep">›</span>
        ${escHtml(currentEnv.name)}
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
  const content = typeof currentEnv.vars === 'string' ? currentEnv.vars : '';
  const lineCount = content ? content.split('\n').length : 0;
  return `
    <div class="env-header">
      <div class="env-title">
        ${escHtml(currentGroup ? currentGroup.name : '')}
        <span class="env-title-sep">›</span>
        ${escHtml(name)}
        <span class="tag txt-tag">.txt</span>
      </div>
    </div>
    <div class="env-stats">
      <div class="stat">
        <div class="stat-icon">📝</div>
        <div><div class="stat-val">${lineCount}</div><div class="stat-label">Lines</div></div>
      </div>
      <div class="stat">
        <div class="stat-icon">🔒</div>
        <div><div class="stat-val">Encrypted</div><div class="stat-label">Storage</div></div>
      </div>
      <div class="stat">
        <div class="stat-icon">💬</div>
        <div><div class="stat-val">${desc ? escHtml(desc) : '—'}</div><div class="stat-label">Description</div></div>
      </div>
    </div>
    <textarea class="txt-editor" id="txtTextarea" spellcheck="false"
      placeholder="Type anything here — FTP credentials, API notes, SSH keys…\nThis file is stored encrypted.">${escHtml(content)}</textarea>`;
}

function renderKvRow(v, i) {
  const isRevealed = revealedRows.has(i);
  const sensitive  = isSensitive(v.k);
  const inputType  = sensitive && !isRevealed ? 'password' : 'text';
  const revealBtn  = sensitive
    ? `<button class="icon-btn vis" onclick="toggleReveal(${i})" title="${isRevealed ? 'Hide' : 'Reveal'}">${isRevealed ? '🙈' : '👁'}</button>`
    : '';
  return `
    <div class="kv-row" data-idx="${i}">
      <div class="kv-cell">
        <input class="kv-input kv-key kv-key-inp" value="${escHtml(v.k)}" placeholder="KEY_NAME" spellcheck="false" />
      </div>
      <div class="kv-cell">
        <input class="kv-input kv-val kv-val-inp" type="${inputType}"
          value="${escHtml(v.v)}" placeholder="value" spellcheck="false" />
      </div>
      <div class="kv-cell">
        <input class="kv-input kv-cmt kv-cmt-inp" value="${escHtml(v.c ?? '')}"
          placeholder="optional note…" spellcheck="false" />
      </div>
      <div class="kv-cell kv-actions">
        ${revealBtn}
        <button class="icon-btn" onclick="copyVal(${i})" title="Copy value">⎘</button>
        <button class="icon-btn del" onclick="deleteKvRow(${i})" title="Delete">✕</button>
      </div>
    </div>`;
}

// ── Row actions ──────────────────────────────────────────────────────────────

function toggleReveal(i) {
  if (revealedRows.has(i)) revealedRows.delete(i);
  else                     revealedRows.add(i);
  syncKvToRaw();
  renderEditor();
}

function addKvRow() {
  syncKvToRaw();
  currentEnv.vars.push({ k: '', v: '', c: '' });
  renderEditor();
  $('.kv-key-inp').last().trigger('focus');
}

function deleteKvRow(i) {
  syncKvToRaw();
  currentEnv.vars.splice(i, 1);
  renderEditor();
}

function copyVal(i) {
  syncKvToRaw();
  const variable = currentEnv.vars[i];
  if (variable) {
    navigator.clipboard.writeText(variable.v);
    showToast(`Copied value of ${variable.k}`);
  }
}

// ── Toolbar actions ──────────────────────────────────────────────────────────

async function saveProject() {
  if (!currentEnv) return;
  if (currentEnv.type === 'txt') syncTxtToMem();
  else if (editMode === 'kv')    syncKvToRaw();
  else                           syncRawToKv();
  await saveVault(getMasterPassword());
  renderProjects();
  showToast('Saved & encrypted ✓');
}

function copyAll() {
  if (!currentEnv) return;
  let text;
  if (currentEnv.type === 'txt') {
    syncTxtToMem();
    text = typeof currentEnv.vars === 'string' ? currentEnv.vars : '';
  } else {
    if (editMode === 'kv') syncKvToRaw();
    text = currentEnv.vars.map(v => `${v.k}=${v.v}`).join('\n');
  }
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard');
}

function exportEnv() {
  if (!currentEnv) return;
  let text, filename;
  if (currentEnv.type === 'txt') {
    syncTxtToMem();
    text     = typeof currentEnv.vars === 'string' ? currentEnv.vars : '';
    filename = `${currentEnv.name}.txt`;
  } else {
    if (editMode === 'kv') syncKvToRaw();
    text     = currentEnv.vars.map(v => `${v.k}=${v.v}`).join('\n');
    filename = `.env.${currentEnv.name}`;
  }
  const blob = new Blob([text], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  showToast('Exported ✓');
}

// Alias used by topbar Rename button
function showRenameProject() { showRenameEnv(); }
function duplicateProject()  { duplicateEnv();  }
