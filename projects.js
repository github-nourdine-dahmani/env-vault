/**
 * projects.js
 * Group + Env CRUD, sidebar rendering, drag-to-reorder and drag-to-move.
 *
 * Terminology:
 *   Group  = a project (e.g. "toto.com") — owns multiple env files
 *   Env    = an environment file (e.g. "prod", "staging", "dev")
 *
 * Depends on: storage.js, crypto.js, ui.js, editor.js, auth.js
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── Sidebar rendering ─────────────────────────────────────────────────────────

/**
 * Re-render the full sidebar: groups as collapsible sections,
 * envs as children underneath each group.
 */
function renderProjects() {
  const $list  = $('#projectList');
  const groups = getVaultData().groups;

  if (groups.length === 0) {
    $list.html('<div class="no-projects" style="padding:20px 0">No projects yet</div>');
    return;
  }

  $list.html(groups.map(g => renderGroupItem(g)).join(''));
  initSortable();
}

/** Build HTML for one group row + its env children. */
function renderGroupItem(g) {
  const isOpen   = openGroups.has(g.id);
  const envsHtml = g.envs.map(e => renderEnvItem(g, e)).join('');

  return `
    <div class="group-block" data-group-id="${g.id}">
      <div class="group-header"
           draggable="true"
           data-group-id="${g.id}"
           onclick="toggleGroup('${g.id}')">
        <span class="drag-handle" title="Drag to reorder group">⠿</span>
        <span class="group-chevron">${isOpen ? '▾' : '▸'}</span>
        <span class="group-name">${escHtml(g.name)}</span>
        <span class="group-count">${g.envs.length}</span>
        <div class="project-item-actions">
          <button class="project-item-btn edit" title="Rename group"
                  onclick="event.stopPropagation(); showRenameGroup('${g.id}')">✏️</button>
          <button class="project-item-btn add-env" title="Add env to this group"
                  onclick="event.stopPropagation(); showAddEnv('${g.id}')">＋</button>
          <button class="project-item-btn del" title="Delete group"
                  onclick="event.stopPropagation(); deleteGroup('${g.id}')">✕</button>
        </div>
      </div>
      <div class="env-list ${isOpen ? 'open' : ''}" data-group-id="${g.id}">
        ${envsHtml}
        <div class="env-drop-zone" data-group-id="${g.id}" title="Drop here to move into ${escHtml(g.name)}"></div>
      </div>
    </div>`;
}

/** Build HTML for one env row inside a group. */
function renderEnvItem(g, e) {
  const isActive = currentEnv && currentEnv.id === e.id;
  return `
    <div class="env-item ${isActive ? 'active' : ''}"
         draggable="true"
         data-env-id="${e.id}"
         data-group-id="${g.id}"
         onclick="selectEnv('${g.id}', '${e.id}')">
      <span class="drag-handle env-drag" title="Drag to move env">⠿</span>
      <div class="project-info">
        <div class="project-name">${escHtml(e.name)}<span class="env-badge">.vault</span></div>
        <div class="project-meta">${e.vars.length} var${e.vars.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="project-item-actions">
        <button class="project-item-btn edit" title="Rename"
                onclick="event.stopPropagation(); selectEnv('${g.id}','${e.id}'); showRenameEnv()">✏️</button>
        <button class="project-item-btn dup" title="Duplicate"
                onclick="event.stopPropagation(); selectEnv('${g.id}','${e.id}'); duplicateEnv()">⧉</button>
      </div>
    </div>`;
}

// ── Collapse state ────────────────────────────────────────────────────────────

/** Set of group ids that are currently expanded. */
const openGroups = new Set();

function toggleGroup(groupId) {
  if (openGroups.has(groupId)) openGroups.delete(groupId);
  else                         openGroups.add(groupId);
  renderProjects();
}

// ── Selection ─────────────────────────────────────────────────────────────────

/**
 * Select an env by group+env id and open it in the editor.
 * @param {string} groupId
 * @param {string} envId
 */
function selectEnv(groupId, envId) {
  const group = getVaultData().groups.find(g => g.id === groupId);
  if (!group) return;
  const env = group.envs.find(e => e.id === envId);
  if (!env) return;

  // Save unsaved edits of the previously open env
  if (currentEnv) {
    if (editMode === 'kv') syncKvToRaw();
    else                   syncRawToKv();
  }

  currentEnv   = env;
  currentGroup = group;
  revealedRows = new Set();
  editMode     = 'kv';

  openGroups.add(groupId); // ensure the group is open

  $('#editorArea').empty().css('display', 'block');
  $('#topbar').css('display', 'flex');
  $('#emptyState').hide();
  $('#topbarGroupName').text(group.name);
  $('#topbarTitle').text(env.name);
  $('#tabKv').addClass('active');
  $('#tabRaw').removeClass('active');

  renderProjects();
  renderEditor();
}

// ── Drag-to-reorder groups + drag-to-move envs ───────────────────────────────

let dragEnvId   = null;   // env being dragged
let dragGroupId = null;   // its source group
let dragGroupSrcId = null; // group header being dragged (for group reorder)

function initSortable() {
  // ── Group header drag (reorder groups) ──────────────────────────────────────
  $('.group-header[draggable]').each(function () {
    const $hdr = $(this);
    const gId  = $hdr.data('group-id');

    $hdr.on('dragstart', e => {
      dragGroupSrcId = gId;
      dragEnvId      = null;
      $hdr.closest('.group-block').addClass('dragging');
      e.originalEvent.dataTransfer.effectAllowed = 'move';
    });

    $hdr.on('dragend', () => {
      dragGroupSrcId = null;
      $('.group-block').removeClass('dragging drag-over-group');
    });

    $hdr.on('dragover', e => {
      if (!dragGroupSrcId || dragGroupSrcId === gId) return;
      e.preventDefault();
      $('.group-block').removeClass('drag-over-group');
      $hdr.closest('.group-block').addClass('drag-over-group');
    });

    $hdr.on('dragleave', () => {
      $hdr.closest('.group-block').removeClass('drag-over-group');
    });

    $hdr.on('drop', async e => {
      e.preventDefault();
      $hdr.closest('.group-block').removeClass('drag-over-group');
      if (!dragGroupSrcId || dragGroupSrcId === gId) return;

      const groups  = getVaultData().groups;
      const srcIdx  = groups.findIndex(g => g.id === dragGroupSrcId);
      const tgtIdx  = groups.findIndex(g => g.id === gId);
      if (srcIdx === -1 || tgtIdx === -1) return;

      const [moved] = groups.splice(srcIdx, 1);
      const insertAt = groups.findIndex(g => g.id === gId);
      groups.splice(insertAt, 0, moved);

      renderProjects();
      await saveVault(getMasterPassword());
    });

    // Don't let handle clicks trigger toggleGroup
    $hdr.find('.drag-handle').on('click', e => e.stopPropagation());
  });

  // ── Env item drag (move env between groups or reorder within group) ──────────
  $('.env-item[draggable]').each(function () {
    const $item = $(this);
    const eId   = $item.data('env-id');
    const gId   = $item.data('group-id');

    $item.on('dragstart', e => {
      dragEnvId      = eId;
      dragGroupId    = gId;
      dragGroupSrcId = null;
      $item.addClass('dragging');
      e.originalEvent.dataTransfer.effectAllowed = 'move';
    });

    $item.on('dragend', () => {
      dragEnvId = dragGroupId = null;
      $('.env-item').removeClass('dragging drag-over');
      $('.env-drop-zone').removeClass('drag-over');
    });

    $item.on('dragover', e => {
      if (!dragEnvId) return;
      e.preventDefault();
      e.stopPropagation();
      $('.env-item').removeClass('drag-over');
      if ($item.data('env-id') !== dragEnvId) $item.addClass('drag-over');
    });

    $item.on('dragleave', () => $item.removeClass('drag-over'));

    $item.on('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      $item.removeClass('drag-over');
      if (!dragEnvId) return;

      const targetEnvId   = $item.data('env-id');
      const targetGroupId = $item.data('group-id');
      if (dragEnvId === targetEnvId) return;

      await moveEnv(dragGroupId, dragEnvId, targetGroupId, targetEnvId);
    });
  });

  // ── Drop zone at the bottom of each env list (drop into an empty/end group) ──
  $('.env-drop-zone').each(function () {
    const $zone   = $(this);
    const tgtGId  = $zone.data('group-id');

    $zone.on('dragover', e => {
      if (!dragEnvId) return;
      e.preventDefault();
      e.stopPropagation();
      $zone.addClass('drag-over');
    });

    $zone.on('dragleave', () => $zone.removeClass('drag-over'));

    $zone.on('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      $zone.removeClass('drag-over');
      if (!dragEnvId || dragGroupId === tgtGId) return; // same group → ignore (use item drop for reorder)
      await moveEnv(dragGroupId, dragEnvId, tgtGId, null);
    });
  });
}

/**
 * Move an env from srcGroup to tgtGroup, inserting before targetEnvId
 * (or appending if targetEnvId is null).
 */
async function moveEnv(srcGroupId, envId, tgtGroupId, beforeEnvId) {
  const groups   = getVaultData().groups;
  const srcGroup = groups.find(g => g.id === srcGroupId);
  const tgtGroup = groups.find(g => g.id === tgtGroupId);
  if (!srcGroup || !tgtGroup) return;

  const envIdx = srcGroup.envs.findIndex(e => e.id === envId);
  if (envIdx === -1) return;

  const [env] = srcGroup.envs.splice(envIdx, 1);

  if (srcGroupId !== tgtGroupId) {
    // Cross-group move: physically move the .vault file on disk
    try {
      const srcDir = await vaultDirHandle.getDirectoryHandle(srcGroupId);
      const tgtDir = await vaultDirHandle.getDirectoryHandle(tgtGroupId, { create: true });
      const bytes  = await readFile(srcDir, `${envId}.vault`);
      if (bytes) {
        await writeFile(tgtDir, `${envId}.vault`, bytes);
        await deleteFile(srcDir, `${envId}.vault`);
      }
    } catch { /* ignore */ }
  }

  if (beforeEnvId) {
    const insertAt = tgtGroup.envs.findIndex(e => e.id === beforeEnvId);
    tgtGroup.envs.splice(insertAt === -1 ? tgtGroup.envs.length : insertAt, 0, env);
  } else {
    tgtGroup.envs.push(env);
  }

  // If the moved env was selected, update currentGroup
  if (currentEnv && currentEnv.id === envId) {
    currentGroup = tgtGroup;
    openGroups.add(tgtGroupId);
    $('#topbarGroupName').text(tgtGroup.name);
  }

  renderProjects();
  await saveVault(getMasterPassword());
  showToast(`Moved "${env.name}" to "${tgtGroup.name}" ✓`);
}

// ── Group CRUD ────────────────────────────────────────────────────────────────

function showAddProject() {
  $('#newProjectName').val('');
  $('#newProjectDesc').val('');
  openModal('addModal');
  setTimeout(() => $('#newProjectName').trigger('focus'), 100);
}

async function addProject() {
  const name = $('#newProjectName').val().trim();
  if (!name) return;

  const group = { id: genId(), name, desc: $('#newProjectDesc').val().trim(), envs: [] };
  getVaultData().groups.push(group);
  openGroups.add(group.id);
  closeModal('addModal');
  await saveVault(getMasterPassword());
  renderProjects();
  showToast(`Group "${name}" created`);
}

function showRenameGroup(groupId) {
  const group = getVaultData().groups.find(g => g.id === groupId);
  if (!group) return;
  $('#renameProjectName').val(group.name);
  $('#renameProjectDesc').val(group.desc ?? '');
  $('#renameModal').data('target-group', groupId).data('target-env', null);
  openModal('renameModal');
  setTimeout(() => $('#renameProjectName').trigger('focus'), 100);
}

async function deleteGroup(groupId) {
  const group = getVaultData().groups.find(g => g.id === groupId);
  if (!group) return;
  if (!confirm(`Delete group "${group.name}" and all its env files? This cannot be undone.`)) return;

  getVaultData().groups = getVaultData().groups.filter(g => g.id !== groupId);
  openGroups.delete(groupId);

  if (currentEnv && currentGroup && currentGroup.id === groupId) {
    currentEnv = null; currentGroup = null;
    $('#topbar').hide();
    $('#editorArea').empty().hide();
    $('#emptyState').css('display', 'flex');
  }

  await deleteGroupDir(groupId);
  await saveVault(getMasterPassword());
  renderProjects();
}

// ── Env CRUD ──────────────────────────────────────────────────────────────────

function showAddEnv(groupId) {
  $('#newEnvName').val('');
  $('#newEnvDesc').val('');
  $('#addEnvModal').data('target-group', groupId);
  openModal('addEnvModal');
  setTimeout(() => $('#newEnvName').trigger('focus'), 100);
}

async function addEnv() {
  const $modal  = $('#addEnvModal');
  const groupId = $modal.data('target-group');
  const name    = $('#newEnvName').val().trim();
  if (!name) return;

  const group = getVaultData().groups.find(g => g.id === groupId);
  if (!group) return;

  // Save unsaved edits first
  if (currentEnv) {
    if (editMode === 'kv') syncKvToRaw();
    else                   syncRawToKv();
  }

  const env = { id: genId(), name, desc: $('#newEnvDesc').val().trim(), vars: [] };
  group.envs.push(env);
  openGroups.add(groupId);
  closeModal('addEnvModal');
  await saveVault(getMasterPassword());
  selectEnv(groupId, env.id);
}

function showRenameEnv() {
  if (!currentEnv) return;
  $('#renameProjectName').val(currentEnv.name);
  $('#renameProjectDesc').val(currentEnv.desc ?? '');
  $('#renameModal').data('target-group', currentGroup.id).data('target-env', currentEnv.id);
  openModal('renameModal');
  setTimeout(() => $('#renameProjectName').trigger('focus'), 100);
}

async function confirmRenameProject() {
  const name    = $('#renameProjectName').val().trim();
  if (!name) return;
  const desc    = $('#renameProjectDesc').val().trim();
  const $modal  = $('#renameModal');
  const groupId = $modal.data('target-group');
  const envId   = $modal.data('target-env');

  if (envId) {
    // Rename env
    const group = getVaultData().groups.find(g => g.id === groupId);
    const env   = group?.envs.find(e => e.id === envId);
    if (env) { env.name = name; env.desc = desc; }
    if (currentEnv && currentEnv.id === envId) {
      $('#topbarTitle').text(name);
    }
  } else {
    // Rename group
    const group = getVaultData().groups.find(g => g.id === groupId);
    if (group) { group.name = name; group.desc = desc; }
    if (currentGroup && currentGroup.id === groupId) {
      $('#topbarGroupName').text(name);
    }
  }

  closeModal('renameModal');
  renderProjects();
  await saveVault(getMasterPassword());
  showToast('Renamed ✓');
}

async function duplicateEnv() {
  if (!currentEnv || !currentGroup) return;
  if (editMode === 'kv') syncKvToRaw();
  else                   syncRawToKv();

  const copy = {
    id:   genId(),
    name: currentEnv.name + ' (copy)',
    desc: currentEnv.desc,
    vars: currentEnv.vars.map(v => ({ ...v })),
  };

  const envs   = currentGroup.envs;
  const srcIdx = envs.findIndex(e => e.id === currentEnv.id);
  envs.splice(srcIdx + 1, 0, copy);

  await saveVault(getMasterPassword());
  renderProjects();
  selectEnv(currentGroup.id, copy.id);
  showToast(`Duplicated as "${copy.name}" ✓`);
}

async function deleteProject() {
  if (!currentEnv || !currentGroup) return;
  if (!confirm(`Delete "${currentEnv.name}"? This cannot be undone.`)) return;

  const envId   = currentEnv.id;
  const groupId = currentGroup.id;

  currentGroup.envs = currentGroup.envs.filter(e => e.id !== envId);
  currentEnv  = null;

  await deleteEnvFile(groupId, envId);
  await saveVault(getMasterPassword());
  renderProjects();

  $('#topbar').hide();
  $('#editorArea').empty().hide();
  $('#emptyState').css('display', 'flex');
}

// ── Import ────────────────────────────────────────────────────────────────────

function showImportProject() {
  $('#importFileName').text('No file chosen');
  $('#importPwInput').val('');
  $('#importNameInput').val('');
  $('#importError').text('');
  $('#importFileInput').val('');
  // Pre-select current group if one is open
  const groups = getVaultData().groups;
  const $sel   = $('#importGroupSelect').empty();
  groups.forEach(g => $sel.append(`<option value="${g.id}">${escHtml(g.name)}</option>`));
  if (currentGroup) $sel.val(currentGroup.id);
  openModal('importModal');
}

function onImportFileChosen() {
  const file = $('#importFileInput')[0].files[0];
  if (!file) return;
  $('#importFileName').text(file.name);
  const suggested = file.name.replace(/\.vault$/i, '');
  if (!$('#importNameInput').val()) $('#importNameInput').val(suggested);
}

async function importProject() {
  const $errEl    = $('#importError');
  const fileInput = $('#importFileInput')[0];
  const pw        = $('#importPwInput').val();
  const name      = $('#importNameInput').val().trim();
  const groupId   = $('#importGroupSelect').val();

  $errEl.text('');
  if (!fileInput.files[0]) { $errEl.text('Please choose a .vault file.'); return; }
  if (!pw)                  { $errEl.text('Please enter the decryption password.'); return; }
  if (!name)                { $errEl.text('Please enter an env name.'); return; }
  if (!groupId)             { $errEl.text('Please select a group.'); return; }

  try {
    const bytes = new Uint8Array(await fileInput.files[0].arrayBuffer());
    const vars  = await unpackEncrypted(bytes, pw);
    if (!Array.isArray(vars)) throw new Error('Unexpected format');

    const group = getVaultData().groups.find(g => g.id === groupId);
    if (!group) throw new Error('Group not found');

    const env = { id: genId(), name, desc: '', vars };
    group.envs.push(env);

    // Write the raw bytes into the group directory under the new env id
    const groupDir = await vaultDirHandle.getDirectoryHandle(groupId, { create: true });
    await writeFile(groupDir, `${env.id}.vault`, bytes);

    await saveVault(getMasterPassword());
    closeModal('importModal');
    openGroups.add(groupId);
    renderProjects();
    selectEnv(groupId, env.id);
    showToast(`Imported "${name}" ✓`);
  } catch {
    $errEl.text('Wrong password or invalid .vault file.');
  }
}

// Legacy shim so auth.js can call renderProjects without changes
const renderProjectsLegacy = renderProjects;
