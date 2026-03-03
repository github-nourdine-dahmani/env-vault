/**
 * auth.js
 * Two-step unlock flow:
 *   1. User picks the vault folder (File System Access API).
 *   2. User enters the master password -> vault files are decrypted.
 *
 * The master password is held in memory for the session so that
 * saveVault() can re-encrypt files on every save without asking again.
 *
 * Depends on: crypto.js, storage.js, projects.js, ui.js, editor.js
 */

// -- Session state ------------------------------------------------------------

let masterPassword = null;

function getMasterPassword() { return masterPassword; }

// -- Step 1: Folder picker ----------------------------------------------------

async function chooseFolder() {
  $('#folderError').text('');

  try {
    await pickVaultFolder();
    showPasswordStep(vaultDirHandle.name);
  } catch (e) {
    if (e.name === 'AbortError') return; // user cancelled
    const msg = e.name === 'SecurityError'
      ? 'Permission denied. Make sure the page is served over localhost or https://, not file://.'
      : `Could not open folder: ${e.message || e.name}`;
    $('#folderError').text(msg);
    console.error('[chooseFolder]', e);
  }
}

/** Transition from folder step to password step. */
function showPasswordStep(folderName) {
  $('#chosenFolder').text(folderName);
  $('#footerFolderName').text(folderName);
  $('#stepFolder').hide();
  $('#stepPassword').css('display', 'flex');
  setTimeout(() => $('#masterPwInput').trigger('focus'), 80);
}

/** Go back from password step to folder step. */
function resetToFolderStep() {
  $('#stepFolder').css('display', 'flex');
  $('#stepPassword').hide();
  $('#masterPwInput').val('');
  $('#passwordError').text('');
}

// -- Step 2: Password unlock --------------------------------------------------

async function unlock() {
  const pw = $('#masterPwInput').val();
  $('#passwordError').text('');

  if (!pw) { $('#passwordError').text('Please enter a password.'); return; }

  try {
    await loadVault(pw);
    masterPassword = pw;

    await restoreSidebarWidth();

    // Clean slate -- no leftover content from a previous session
    currentEnv = currentGroup = null;
    openGroups.clear();
    showEmptyState();

    $('#lockScreen').hide();
    $('#mainApp').css('display', 'flex');
    renderProjects();
  } catch {
    $('#passwordError').text('Wrong password or corrupted vault. Try again.');
    masterPassword = null;
  }
}

// -- Lock ---------------------------------------------------------------------

function lockVault() {
  masterPassword = null;
  currentEnv = currentGroup = null;
  openGroups.clear();

  showEmptyState();
  $('#projectList').empty();

  resetToFolderStep();
  $('#folderError').text('');

  $('#lockScreen').css('display', 'flex');
  $('#mainApp').hide();
}

// -- Bootstrap: keyboard shortcuts + session restore --------------------------

$(async () => {
  $('#masterPwInput').on('keydown', e => { if (e.key === 'Enter') unlock(); });

  // Try to restore the vault folder handle from the previous session.
  const restored = await restoreHandleFromIdb();
  if (restored) showPasswordStep(vaultDirHandle.name);
});
