/**
 * projects.js
 * Group + Env CRUD, sidebar rendering, drag-to-reorder and drag-to-move.
 *
 * Terminology:
 *   Group  = a project (e.g. "toto.com") -- owns multiple env files
 *   Env    = an environment file (e.g. "prod", "staging", "dev")
 *
 * Depends on: storage.js, crypto.js, ui.js, editor.js, auth.js
 */

// -- Helpers ------------------------------------------------------------------

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Pluralise a label: "3 vars", "1 line". */
function plural(n, word) {
  return `${n} ${word}${n !== 1 ? 's' : ''}`;
}

/** Look up a group by id in the vault. */
function findGroup(groupId) {
  return getVaultData().groups.find(g => g.id === groupId);
}

/** Save vault and re-render the sidebar (common post-mutation step). */
async function persistAndRender() {
  await saveVault(getMasterPassword());
  renderProjects();
}

/** Show the empty-state panel (no env selected). */
function showEmptyState() {
  $('#topbar').hide();
  $('#editorArea').empty().hide();
  $('#emptyState').css('display', 'flex');
}

// -- Sidebar rendering --------------------------------------------------------

const openGroups = new Set();

function renderProjects() {
  const $list  = $('#projectList');
  const groups = getVaultData().groups;

  if (!groups.length) {
    $list.html('<div class="no-projects" style="padding:20px 0">No projects yet</div>');
    return;
  }

  $list.html(groups.map(renderGroupItem).join(''));
  initSortable();
}

function renderGroupItem(g) {
  const isOpen = openGroups.has(g.id);
  return `
    <div class="group-block" data-group-id="${g.id}">
      <div class="group-header" draggable="true" data-group-id="${g.id}" onclick="toggleGroup('${g.id}')">
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
        ${g.envs.map(e => renderEnvItem(g, e)).join('')}
        <div class="env-drop-zone" data-group-id="${g.id}" title="Drop here to move into ${escHtml(g.name)}"></div>
      </div>
    </div>`;
}

function renderEnvItem(g, e) {
  const isActive = currentEnv?.id === e.id;
  const isTxt    = e.type === 'txt';
  const count    = isTxt
    ? (typeof e.vars === 'string' ? e.vars.split('\n').filter(Boolean).length : 0)
    : (Array.isArray(e.vars) ? e.vars.length : 0);
  const meta = plural(count, isTxt ? 'line' : 'var');

  return `
    <div class="env-item ${isActive ? 'active' : ''}" draggable="true"
         data-env-id="${e.id}" data-group-id="${g.id}"
         onclick="selectEnv('${g.id}', '${e.id}')">
      <span class="drag-handle env-drag" title="Drag to move env">⠿</span>
      <div class="project-info">
        <div class="project-name">${escHtml(e.name)}<span class="${isTxt ? 'env-badge env-badge-txt' : 'env-badge'}">${isTxt ? '.txt' : '.env'}</span></div>
        <div class="project-meta">${meta}</div>
      </div>
      <div class="project-item-actions">
        <button class="project-item-btn edit" title="Rename"
                onclick="event.stopPropagation(); selectEnv('${g.id}','${e.id}'); showRenameEnv()">✏️</button>
        <button class="project-item-btn dup" title="Duplicate"
                onclick="event.stopPropagation(); selectEnv('${g.id}','${e.id}'); duplicateEnv()">⧉</button>
      </div>
    </div>`;
}

// -- Collapse / Selection -----------------------------------------------------

function toggleGroup(groupId) {
  openGroups.has(groupId) ? openGroups.delete(groupId) : openGroups.add(groupId);
  renderProjects();
}

function selectEnv(groupId, envId) {
  const group = findGroup(groupId);
  const env   = group?.envs.find(e => e.id === envId);
  if (!group || !env) return;

  syncCurrentEnv(); // flush any unsaved edits

  currentEnv   = env;
  currentGroup = group;
  revealedRows = new Set();
  editMode     = 'kv';

  openGroups.add(groupId);

  $('#editorArea').empty().css('display', 'block');
  $('#topbar').css('display', 'flex');
  $('#emptyState').hide();
  $('#topbarGroupName').text(group.name);
  $('#topbarTitle').text(env.name);

  // Adjust topbar visibility for file type
  const isTxt = env.type === 'txt';
  $('#tabKv, #tabRaw').toggle(!isTxt);
  $('#topbarCopyAll, #topbarExport').toggle(!isTxt);
  if (!isTxt) {
    $('#tabKv').addClass('active');
    $('#tabRaw').removeClass('active');
  }

  renderProjects();
  renderEditor();
}

// -- Drag-and-drop ------------------------------------------------------------

let dragEnvId      = null;
let dragGroupId    = null;
let dragGroupSrcId = null;

function initSortable() {
  initGroupDrag();
  initEnvDrag();
  initEnvDropZones();
}

function initGroupDrag() {
  $('.group-header[draggable]').each(function () {
    const $hdr = $(this);
    const gId  = $hdr.data('group-id');

    $hdr.on('dragstart', e => {
      dragGroupSrcId = gId;
      dragEnvId = null;
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

    $hdr.on('dragleave', () => $hdr.closest('.group-block').removeClass('drag-over-group'));

    $hdr.on('drop', async e => {
      e.preventDefault();
      $hdr.closest('.group-block').removeClass('drag-over-group');
      if (!dragGroupSrcId || dragGroupSrcId === gId) return;

      const groups = getVaultData().groups;
      const srcIdx = groups.findIndex(g => g.id === dragGroupSrcId);
      const tgtIdx = groups.findIndex(g => g.id === gId);
      if (srcIdx === -1 || tgtIdx === -1) return;

      const [moved] = groups.splice(srcIdx, 1);
      groups.splice(groups.findIndex(g => g.id === gId), 0, moved);

      renderProjects();
      await saveVault(getMasterPassword());
    });

    $hdr.find('.drag-handle').on('click', e => e.stopPropagation());
  });
}

function initEnvDrag() {
  $('.env-item[draggable]').each(function () {
    const $item = $(this);
    const eId   = $item.data('env-id');
    const gId   = $item.data('group-id');

    $item.on('dragstart', e => {
      dragEnvId = eId; dragGroupId = gId; dragGroupSrcId = null;
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
      e.preventDefault(); e.stopPropagation();
      $('.env-item').removeClass('drag-over');
      if ($item.data('env-id') !== dragEnvId) $item.addClass('drag-over');
    });

    $item.on('dragleave', () => $item.removeClass('drag-over'));

    $item.on('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      $item.removeClass('drag-over');
      if (!dragEnvId || dragEnvId === $item.data('env-id')) return;
      await moveEnv(dragGroupId, dragEnvId, $item.data('group-id'), $item.data('env-id'));
    });
  });
}

function initEnvDropZones() {
  $('.env-drop-zone').each(function () {
    const $zone = $(this);
    const tgtGId = $zone.data('group-id');

    $zone.on('dragover', e => {
      if (!dragEnvId) return;
      e.preventDefault(); e.stopPropagation();
      $zone.addClass('drag-over');
    });

    $zone.on('dragleave', () => $zone.removeClass('drag-over'));

    $zone.on('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      $zone.removeClass('drag-over');
      if (!dragEnvId || dragGroupId === tgtGId) return;
      await moveEnv(dragGroupId, dragEnvId, tgtGId, null);
    });
  });
}

async function moveEnv(srcGroupId, envId, tgtGroupId, beforeEnvId) {
  const srcGroup = findGroup(srcGroupId);
  const tgtGroup = findGroup(tgtGroupId);
  if (!srcGroup || !tgtGroup) return;

  const envIdx = srcGroup.envs.findIndex(e => e.id === envId);
  if (envIdx === -1) return;
  const [env] = srcGroup.envs.splice(envIdx, 1);

  // Cross-group move: physically relocate the .vault file
  if (srcGroupId !== tgtGroupId) {
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

  // Insert at target position
  const insertAt = beforeEnvId ? tgtGroup.envs.findIndex(e => e.id === beforeEnvId) : -1;
  if (insertAt >= 0) tgtGroup.envs.splice(insertAt, 0, env);
  else               tgtGroup.envs.push(env);

  // Update selection if the moved env was active
  if (currentEnv?.id === envId) {
    currentGroup = tgtGroup;
    openGroups.add(tgtGroupId);
    $('#topbarGroupName').text(tgtGroup.name);
  }

  renderProjects();
  await saveVault(getMasterPassword());
  showToast(`Moved "${env.name}" to "${tgtGroup.name}" ✓`);
}

// -- Group CRUD ---------------------------------------------------------------

function showAddProject() {
  $('#newProjectName, #newProjectDesc').val('');
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
  await persistAndRender();
  showToast(`Group "${name}" created`);
}

function showRenameGroup(groupId) {
  const group = findGroup(groupId);
  if (!group) return;
  $('#renameProjectName').val(group.name);
  $('#renameProjectDesc').val(group.desc ?? '');
  $('#renameModal').data('target-group', groupId).data('target-env', null);
  openModal('renameModal');
  setTimeout(() => $('#renameProjectName').trigger('focus'), 100);
}

async function deleteGroup(groupId) {
  const group = findGroup(groupId);
  if (!group) return;
  if (!confirm(`Delete group "${group.name}" and all its env files? This cannot be undone.`)) return;

  getVaultData().groups = getVaultData().groups.filter(g => g.id !== groupId);
  openGroups.delete(groupId);

  if (currentGroup?.id === groupId) {
    currentEnv = currentGroup = null;
    showEmptyState();
  }

  await deleteGroupDir(groupId);
  await persistAndRender();
}

// -- Env CRUD -----------------------------------------------------------------

function showAddEnv(groupId) {
  $('#newEnvName, #newEnvDesc').val('');
  $('#fileTypePicker .file-type-option').removeClass('active');
  $('#fileTypePicker .file-type-option[data-value="env"]').addClass('active');
  $('input[name="newEnvType"][value="env"]').prop('checked', true);
  $('#addEnvModal').data('target-group', groupId);
  openModal('addEnvModal');
  setTimeout(() => $('#newEnvName').trigger('focus'), 100);
}

async function addEnv() {
  const groupId = $('#addEnvModal').data('target-group');
  const name    = $('#newEnvName').val().trim();
  const type    = $('input[name="newEnvType"]:checked').val() || 'env';
  if (!name) return;

  const group = findGroup(groupId);
  if (!group) return;

  syncCurrentEnv();

  const env = { id: genId(), name, desc: $('#newEnvDesc').val().trim(), type, vars: type === 'txt' ? '' : [] };
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
  const name = $('#renameProjectName').val().trim();
  if (!name) return;

  const desc    = $('#renameProjectDesc').val().trim();
  const $modal  = $('#renameModal');
  const groupId = $modal.data('target-group');
  const envId   = $modal.data('target-env');

  if (envId) {
    const env = findGroup(groupId)?.envs.find(e => e.id === envId);
    if (env) { env.name = name; env.desc = desc; }
    if (currentEnv?.id === envId) $('#topbarTitle').text(name);
  } else {
    const group = findGroup(groupId);
    if (group) { group.name = name; group.desc = desc; }
    if (currentGroup?.id === groupId) $('#topbarGroupName').text(name);
  }

  closeModal('renameModal');
  await persistAndRender();
  showToast('Renamed ✓');
}

async function duplicateEnv() {
  if (!currentEnv || !currentGroup) return;
  syncCurrentEnv();

  const isTxt = currentEnv.type === 'txt';
  const copy  = {
    id:   genId(),
    name: currentEnv.name + ' (copy)',
    desc: currentEnv.desc,
    type: currentEnv.type ?? 'env',
    vars: isTxt
      ? (typeof currentEnv.vars === 'string' ? currentEnv.vars : '')
      : currentEnv.vars.map(v => ({ ...v })),
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

  const { id: envId }   = currentEnv;
  const { id: groupId } = currentGroup;

  currentGroup.envs = currentGroup.envs.filter(e => e.id !== envId);
  currentEnv = null;

  await deleteEnvFile(groupId, envId);
  await persistAndRender();
  showEmptyState();
}

// -- Import -------------------------------------------------------------------

function showImportProject() {
  $('#importFileName').text('No file chosen');
  $('#importPwInput, #importNameInput, #importFileInput').val('');
  $('#importError').text('');

  const $sel = $('#importGroupSelect').empty();
  getVaultData().groups.forEach(g => $sel.append(`<option value="${g.id}">${escHtml(g.name)}</option>`));
  if (currentGroup) $sel.val(currentGroup.id);
  openModal('importModal');
}

function onImportFileChosen() {
  const file = $('#importFileInput')[0].files[0];
  if (!file) return;
  $('#importFileName').text(file.name);
  if (!$('#importNameInput').val()) {
    $('#importNameInput').val(file.name.replace(/\.vault$/i, ''));
  }
}

async function importProject() {
  const $err    = $('#importError');
  const file    = $('#importFileInput')[0].files[0];
  const pw      = $('#importPwInput').val();
  const name    = $('#importNameInput').val().trim();
  const groupId = $('#importGroupSelect').val();

  $err.text('');
  if (!file)    { $err.text('Please choose a .vault file.'); return; }
  if (!pw)      { $err.text('Please enter the decryption password.'); return; }
  if (!name)    { $err.text('Please enter an env name.'); return; }
  if (!groupId) { $err.text('Please select a group.'); return; }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const vars  = await unpackEncrypted(bytes, pw);
    if (!Array.isArray(vars)) throw new Error('Unexpected format');

    const group = findGroup(groupId);
    if (!group) throw new Error('Group not found');

    const env = { id: genId(), name, desc: '', vars };
    group.envs.push(env);

    const groupDir = await vaultDirHandle.getDirectoryHandle(groupId, { create: true });
    await writeFile(groupDir, `${env.id}.vault`, bytes);

    await saveVault(getMasterPassword());
    closeModal('importModal');
    openGroups.add(groupId);
    renderProjects();
    selectEnv(groupId, env.id);
    showToast(`Imported "${name}" ✓`);
  } catch {
    $err.text('Wrong password or invalid .vault file.');
  }
}
