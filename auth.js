/**
 * auth.js
 * Two-step unlock flow:
 *   1. User picks the vault folder (File System Access API).
 *   2. User enters the master password → vault files are decrypted.
 *
 * The master password is held in memory for the session so that
 * saveVault() can re-encrypt files on every save without asking again.
 *
 * Depends on: crypto.js, storage.js, projects.js, ui.js
 */

// ── Session state ─────────────────────────────────────────────────────────────

/** Master password string, kept in memory while the vault is unlocked. */
let masterPassword = null;

/** Return the current master password (null when locked). */
function getMasterPassword() { return masterPassword; }

// ── Step 1 – Folder picker ────────────────────────────────────────────────────

/**
 * Called by the "Choose Vault Folder" button on the lock screen.
 * Asks the user to pick a directory, then reveals the password field.
 */
async function chooseFolder() {
  $('#folderError').text('');

  try {
    await pickVaultFolder();

    // Show the chosen folder name
    $('#chosenFolder').text(vaultDirHandle.name);
    $('#footerFolderName').text(vaultDirHandle.name);

    // Advance to the password step
    $('#stepFolder').hide();
    $('#stepPassword').css('display', 'flex');
    setTimeout(() => $('#masterPwInput').trigger('focus'), 80);
  } catch (e) {
    if (e.name !== 'AbortError') {
      const msg = e.name === 'SecurityError'
        ? 'Permission denied. Make sure the page is served over localhost or https://, not file://.'
        : `Could not open folder: ${e.message || e.name}`;
      $('#folderError').text(msg);
      console.error('[chooseFolder]', e);
    }
  }
}

// ── Step 2 – Password unlock ──────────────────────────────────────────────────

/**
 * Attempt to decrypt the vault with the entered password.
 * On success, shows the main app.
 */
async function unlock() {
  const pw = $('#masterPwInput').val();
  $('#passwordError').text('');

  if (!pw) {
    $('#passwordError').text('Please enter a password.');
    return;
  }

  try {
    await loadVault(pw);
    masterPassword = pw;

    // Restore the saved sidebar width for this vault folder
    await restoreSidebarWidth();

    // Always start with a clean slate — no leftover content from a previous session
    currentEnv   = null;
    currentGroup = null;
    openGroups.clear();
    $('#editorArea').empty().hide();
    $('#topbar').hide();
    $('#emptyState').css('display', 'flex');

    $('#lockScreen').hide();
    $('#mainApp').css('display', 'flex');
    renderProjects();
  } catch {
    $('#passwordError').text('Wrong password or corrupted vault. Try again.');
    masterPassword = null;
  }
}

// ── Lock ──────────────────────────────────────────────────────────────────────

/**
 * Lock the vault: wipe the password from memory and return to the lock screen.
 * Also fully resets the main panel so no data leaks across sessions.
 */
function lockVault() {
  masterPassword = null;
  currentEnv     = null;
  currentGroup   = null;
  openGroups.clear();

  // Reset the editor / main panel
  $('#editorArea').empty().hide();
  $('#topbar').hide();
  $('#emptyState').css('display', 'flex');
  $('#projectList').empty();

  // Reset lock screen to step 1
  $('#stepFolder').css('display', 'flex');
  $('#stepPassword').hide();
  $('#masterPwInput').val('');
  $('#folderError').text('');
  $('#passwordError').text('');

  $('#lockScreen').css('display', 'flex');
  $('#mainApp').hide();
}

// ── Keyboard shortcuts + session restore ─────────────────────────────────────

$(async () => {
  $('#masterPwInput').on('keydown', e => {
    if (e.key === 'Enter') unlock();
  });

  // Try to restore the vault folder from the previous session.
  // If the handle is still valid and the user grants permission,
  // skip the folder-picker step and go straight to the password field.
  const restored = await restoreHandleFromIdb();
  if (restored) {
    $('#chosenFolder').text(vaultDirHandle.name);
    $('#footerFolderName').text(vaultDirHandle.name);
    $('#stepFolder').hide();
    $('#stepPassword').css('display', 'flex');
    setTimeout(() => $('#masterPwInput').trigger('focus'), 80);
  }
});
