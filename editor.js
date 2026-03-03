/**
 * editor.js
 * Key-value / raw editor logic for a selected project.
 * Depends on: storage.js, ui.js
 */

// ── App-level state ──────────────────────────────────────────────────────────

/** The project object currently open in the editor, or null. */
let currentProject = null;

/** Current view mode: 'kv' (key-value table) or 'raw' (textarea). */
let editMode = 'kv';

/** Set of row indices whose values are currently revealed (not masked). */
let revealedRows = new Set();

// ── Sensitive-key detection ──────────────────────────────────────────────────

const SENSITIVE_KEYWORDS = ['secret', 'key', 'token', 'pass', 'pwd', 'auth', 'private'];

/**
 * Return true if the variable key looks like it holds a sensitive value.
 * @param {string} key
 * @returns {boolean}
 */
function isSensitive(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYWORDS.some(word => lower.includes(word));
}

// ── Mode switching ───────────────────────────────────────────────────────────

/**
 * Switch between 'kv' and 'raw' editing modes.
 * Syncs the current DOM state before switching.
 * @param {'kv'|'raw'} mode
 */
function setMode(mode) {
  if (mode === 'raw') syncKvToRaw();
  else                syncRawToKv();

  editMode = mode;
  $('#tabKv').toggleClass('active', mode === 'kv');
  $('#tabRaw').toggleClass('active', mode === 'raw');
  renderEditor();
}

// ── Sync helpers ─────────────────────────────────────────────────────────────

/**
 * Read the KV table from the DOM and write the result into currentProject.vars.
 * Empty keys are discarded. The comment field (c) is preserved as-is.
 */
function syncKvToRaw() {
  if (!currentProject) return;
  currentProject.vars = [];
  $('.kv-row[data-idx]').each(function () {
    const k = $(this).find('.kv-key-inp').val().trim();
    const v = $(this).find('.kv-val-inp').val();
    const c = $(this).find('.kv-cmt-inp').val();
    if (k) currentProject.vars.push({ k, v, c });
  });
}

/**
 * Parse the raw textarea and write the result into currentProject.vars.
 * Comment lines and blank lines are ignored.
 */
function syncRawToKv() {
  if (!currentProject) return;
  const $textarea = $('#rawTextarea');
  if (!$textarea.length) return;

  // Snapshot old vars so we can preserve comments after re-parsing
  const oldVars = currentProject.vars;
  currentProject.vars = [];
  $textarea.val().split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;

    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) return;

    const k = line.slice(0, eqIdx).trim();
    const v = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    // Carry over the comment from the previous state (keyed by variable name)
    const existing = oldVars.find(e => e.k === k);
    if (k) currentProject.vars.push({ k, v, c: existing?.c ?? '' });
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Render the editor area for the currently selected project. */
function renderEditor() {
  const $area = $('#editorArea');
  if (!currentProject) {
    $area.empty();
    return;
  }

  if (editMode === 'kv') {
    $area.html(renderKvEditor());
  } else {
    $area.html(renderRawEditor());
  }
}

/** Build the HTML string for the key-value editor. */
function renderKvEditor() {
  const { name, desc, vars } = currentProject;
  const sensitiveCount = vars.filter(v => isSensitive(v.k)).length;

  return `
    <div class="env-header">
      <div class="env-title">
        ${escHtml(name)}
        <span class="tag">.env</span>
      </div>
    </div>
    <div class="env-stats">
      <div class="stat">
        <div class="stat-icon">📦</div>
        <div>
          <div class="stat-val">${vars.length}</div>
          <div class="stat-label">Variables</div>
        </div>
      </div>
      <div class="stat">
        <div class="stat-icon">🔑</div>
        <div>
          <div class="stat-val">${sensitiveCount}</div>
          <div class="stat-label">Sensitive</div>
        </div>
      </div>
      <div class="stat">
        <div class="stat-icon">📝</div>
        <div>
          <div class="stat-val">${desc ? escHtml(desc) : '—'}</div>
          <div class="stat-label">Description</div>
        </div>
      </div>
    </div>
    <div class="kv-table">
      <div class="kv-header">
        <div>KEY</div><div>VALUE</div><div>COMMENT</div><div>ACTIONS</div>
      </div>
      ${vars.map((v, i) => renderKvRow(v, i)).join('')}
      <button class="add-row-btn" onclick="addKvRow()">+ Add Variable</button>
    </div>
  `;
}

/** Build the HTML string for the raw textarea editor. */
function renderRawEditor() {
  const raw = currentProject.vars.map(v => `${v.k}=${v.v}`).join('\n');
  return `
    <div class="env-header">
      <div class="env-title">${escHtml(currentProject.name)} <span class="tag">raw</span></div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px">
      Edit your .env file directly. Click Save to apply changes.
    </p>
    <textarea class="raw-editor" id="rawTextarea" spellcheck="false"
      placeholder="KEY=value&#10;SECRET_KEY=abc123&#10;DATABASE_URL=postgres://...">${escHtml(raw)}</textarea>
  `;
}

/**
 * Build the HTML string for a single KV table row.
 * @param {{ k: string, v: string, c?: string }} v  The variable.
 * @param {number} i  Row index.
 * @returns {string}
 */
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
        <input class="kv-input kv-val kv-val-inp"
          type="${inputType}"
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

/**
 * Toggle the revealed state of a sensitive row.
 * @param {number} i  Row index.
 */
function toggleReveal(i) {
  if (revealedRows.has(i)) revealedRows.delete(i);
  else                     revealedRows.add(i);
  syncKvToRaw();
  renderEditor();
}

/** Append an empty row and focus its key input. */
function addKvRow() {
  syncKvToRaw();
  currentProject.vars.push({ k: '', v: '', c: '' });
  renderEditor();
  const $keyInputs = $('.kv-key-inp');
  if ($keyInputs.length) $keyInputs.last().trigger('focus');
}

/**
 * Remove a row by index.
 * @param {number} i
 */
function deleteKvRow(i) {
  syncKvToRaw();
  currentProject.vars.splice(i, 1);
  renderEditor();
}

/**
 * Copy a single variable's value to the clipboard.
 * @param {number} i  Row index.
 */
function copyVal(i) {
  syncKvToRaw();
  const variable = currentProject.vars[i];
  if (variable) {
    navigator.clipboard.writeText(variable.v);
    showToast(`Copied value of ${variable.k}`);
  }
}

// ── Toolbar actions ──────────────────────────────────────────────────────────

/** Save the current project (encrypts and persists to disk). */
async function saveProject() {
  if (!currentProject) return;
  if (editMode === 'kv') syncKvToRaw();
  else                   syncRawToKv();
  await saveVault(getMasterPassword());
  renderProjects();
  showToast('Project saved & encrypted ✓');
}

/** Copy all variables to the clipboard in KEY=value format. */
function copyAll() {
  if (!currentProject) return;
  if (editMode === 'kv') syncKvToRaw();
  const text = currentProject.vars.map(v => `${v.k}=${v.v}`).join('\n');
  navigator.clipboard.writeText(text);
  showToast('Copied all variables');
}

/** Download all variables as a .env file. */
function exportEnv() {
  if (!currentProject) return;
  if (editMode === 'kv') syncKvToRaw();
  const text = currentProject.vars.map(v => `${v.k}=${v.v}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `.env.${currentProject.name}`;
  a.click();
  showToast('Exported .env file');
}
