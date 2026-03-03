/**
 * projects.js
 * CRUD operations and rendering for vault projects.
 * Depends on: storage.js, crypto.js, ui.js, editor.js, auth.js
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a collision-resistant unique id. */
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Re-render the sidebar project list. */
function renderProjects() {
  const $list    = $('#projectList');
  const projects = getVaultData().projects;

  if (projects.length === 0) {
    $list.html('<div class="no-projects" style="padding:20px 0">No projects yet</div>');
    return;
  }

  $list.html(projects.map(p => `
    <div class="project-item ${currentProject && currentProject.id === p.id ? 'active' : ''}"
         draggable="true"
         data-id="${p.id}"
         onclick="selectProject('${p.id}')">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="project-info">
        <div class="project-name">${escHtml(p.name)}</div>
        <div class="project-meta">${p.vars.length} variable${p.vars.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="project-item-actions">
        <button class="project-item-btn edit" title="Rename"    onclick="event.stopPropagation(); selectProject('${p.id}'); showRenameProject();">✏️</button>
        <button class="project-item-btn dup"  title="Duplicate" onclick="event.stopPropagation(); selectProject('${p.id}'); duplicateProject();">⧉</button>
      </div>
    </div>
  `).join(''));

  initSortable();
}

// ── Drag-to-reorder ───────────────────────────────────────────────────────────

/** The project id being dragged. */
let dragSrcId = null;

/** Wire up HTML5 drag-and-drop on the rendered project items. */
function initSortable() {
  const $list = $('#projectList');

  $list.find('.project-item').each(function () {
    const $item = $(this);

    $item.on('dragstart', function (e) {
      dragSrcId = $item.data('id');
      $item.addClass('dragging');
      e.originalEvent.dataTransfer.effectAllowed = 'move';
    });

    $item.on('dragend', function () {
      $item.removeClass('dragging');
      $list.find('.project-item').removeClass('drag-over');
    });

    $item.on('dragover', function (e) {
      e.preventDefault();
      e.originalEvent.dataTransfer.dropEffect = 'move';
      $list.find('.project-item').removeClass('drag-over');
      if ($item.data('id') !== dragSrcId) $item.addClass('drag-over');
    });

    $item.on('dragleave', function () {
      $item.removeClass('drag-over');
    });

    $item.on('drop', async function (e) {
      e.preventDefault();
      $item.removeClass('drag-over');

      const targetId = $item.data('id');
      if (!dragSrcId || dragSrcId === targetId) return;

      // Reorder the projects array
      const projects  = getVaultData().projects;
      const srcIdx    = projects.findIndex(p => p.id === dragSrcId);
      const targetIdx = projects.findIndex(p => p.id === targetId);
      if (srcIdx === -1 || targetIdx === -1) return;

      // Move srcIdx to just before targetIdx
      const [moved] = projects.splice(srcIdx, 1);
      const insertAt = projects.findIndex(p => p.id === targetId);
      projects.splice(insertAt, 0, moved);

      renderProjects();
      await saveVault(getMasterPassword());
    });

    // Prevent clicks on the handle from triggering selectProject
    $item.find('.drag-handle').on('click', e => e.stopPropagation());
  });
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * Select a project by id and render the editor.
 * @param {string} id
 */
function selectProject(id) {
  const project = getVaultData().projects.find(p => p.id === id);
  if (!project) return; // guard: id not found, do nothing

  // Sync DOM edits of the previously open project before switching
  if (currentProject) {
    if (editMode === 'kv') syncKvToRaw();
    else                   syncRawToKv();
  }

  currentProject = project;
  revealedRows   = new Set();
  editMode       = 'kv';

  // Always wipe the editor area first so stale content never lingers
  $('#editorArea').empty().css('display', 'block');

  $('#topbar').css('display', 'flex');
  $('#emptyState').hide();
  $('#topbarTitle').text(currentProject.name);
  $('#tabKv').addClass('active');
  $('#tabRaw').removeClass('active');

  renderProjects(); // update sidebar active state
  renderEditor();   // paint the new project content
}

// ── Add project ───────────────────────────────────────────────────────────────

/** Open the "New Project" modal and focus the name input. */
function showAddProject() {
  $('#newProjectName').val('');
  $('#newProjectDesc').val('');
  openModal('addModal');
  setTimeout(() => $('#newProjectName').trigger('focus'), 100);
}

/** Read the modal form, create a project, persist it, and select it. */
async function addProject() {
  const name = $('#newProjectName').val().trim();
  if (!name) return;

  // Sync any unsaved DOM edits back into the currently open project
  // before we switch away, so we don't lose the user's in-progress work.
  if (currentProject) {
    if (editMode === 'kv') syncKvToRaw();
    else                   syncRawToKv();
  }

  const project = {
    id:   genId(),
    name,
    desc: $('#newProjectDesc').val().trim(),
    vars: [],
  };

  getVaultData().projects.push(project);
  closeModal('addModal');
  await saveVault(getMasterPassword());
  selectProject(project.id);
}

// ── Import project from .vault file ──────────────────────────────────────────

/**
 * Open the import modal and reset its fields.
 * The actual file is chosen via a hidden <input type="file">.
 */
function showImportProject() {
  $('#importFileName').text('No file chosen');
  $('#importPwInput').val('');
  $('#importNameInput').val('');
  $('#importError').text('');
  // Reset the file input so the same file can be re-selected
  $('#importFileInput').val('');
  openModal('importModal');
}

/**
 * Called when the user picks a file via the hidden input.
 * Shows the chosen filename in the modal.
 */
function onImportFileChosen() {
  const file = $('#importFileInput')[0].files[0];
  if (!file) return;

  $('#importFileName').text(file.name);

  // Pre-fill the project name from the filename (strip extension)
  const suggested = file.name.replace(/\.vault$/i, '');
  if (!$('#importNameInput').val()) {
    $('#importNameInput').val(suggested);
  }
}

/**
 * Read the chosen .vault file, decrypt it with the provided password,
 * create a new project in the current vault, and persist everything.
 */
async function importProject() {
  const $errEl    = $('#importError');
  const fileInput = $('#importFileInput')[0];
  const pw        = $('#importPwInput').val();
  const name      = $('#importNameInput').val().trim();

  $errEl.text('');

  if (!fileInput.files[0]) { $errEl.text('Please choose a .vault file.'); return; }
  if (!pw)                  { $errEl.text('Please enter the decryption password.'); return; }
  if (!name)                { $errEl.text('Please enter a project name.'); return; }

  try {
    const bytes = new Uint8Array(await fileInput.files[0].arrayBuffer());
    const vars  = await unpackEncrypted(bytes, pw);

    if (!Array.isArray(vars)) throw new Error('Unexpected file format');

    const project = { id: genId(), name, desc: '', vars };
    getVaultData().projects.push(project);

    // Copy the raw .vault file into the current vault folder under the new id
    await writeVaultFile(`${project.id}.vault`, bytes);

    // Update the vault index
    await saveVault(getMasterPassword());

    closeModal('importModal');
    renderProjects();
    selectProject(project.id);
    showToast(`Imported "${name}" ✓`);
  } catch {
    $errEl.text('Wrong password or invalid .vault file.');
  }
}

// ── Duplicate project ─────────────────────────────────────────────────────────

/**
 * Deep-clone the currently selected project, append " (copy)" to its name,
 * insert it right after the original, persist, and select the new copy.
 */
async function duplicateProject() {
  if (!currentProject) return;

  // Make sure any unsaved edits are captured first
  if (editMode === 'kv') syncKvToRaw();
  else                   syncRawToKv();

  const copy = {
    id:   genId(),
    name: currentProject.name + ' (copy)',
    desc: currentProject.desc,
    // Deep-clone vars so the two projects are independent
    vars: currentProject.vars.map(v => ({ ...v })),
  };

  const projects = getVaultData().projects;
  const srcIdx   = projects.findIndex(p => p.id === currentProject.id);
  projects.splice(srcIdx + 1, 0, copy);

  await saveVault(getMasterPassword());
  renderProjects();
  selectProject(copy.id);
  showToast(`Duplicated as "${copy.name}" ✓`);
}

// ── Rename project ────────────────────────────────────────────────────────────

/** Open the rename modal pre-filled with the current project's name & desc. */
function showRenameProject() {
  if (!currentProject) return;
  $('#renameProjectName').val(currentProject.name);
  $('#renameProjectDesc').val(currentProject.desc ?? '');
  openModal('renameModal');
  setTimeout(() => $('#renameProjectName').trigger('focus'), 100);
}

/** Apply the rename form values to the current project and persist. */
async function confirmRenameProject() {
  const name = $('#renameProjectName').val().trim();
  if (!name) return;

  currentProject.name = name;
  currentProject.desc = $('#renameProjectDesc').val().trim();

  closeModal('renameModal');
  $('#topbarTitle').text(currentProject.name);
  renderProjects();
  await saveVault(getMasterPassword());
  showToast('Project renamed ✓');
}

// ── Delete project ────────────────────────────────────────────────────────────

/** Confirm and permanently delete the currently selected project. */
async function deleteProject() {
  if (!currentProject) return;
  if (!confirm(`Delete "${currentProject.name}"? This cannot be undone.`)) return;

  const id = currentProject.id;
  getVaultData().projects = getVaultData().projects.filter(p => p.id !== id);
  currentProject = null;

  // Remove the .vault file, then update the index
  await deleteProjectFile(id);
  await saveVault(getMasterPassword());
  renderProjects();

  $('#topbar').hide();
  $('#editorArea').hide();
  $('#emptyState').css('display', 'flex');
}
