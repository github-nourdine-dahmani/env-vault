/**
 * sidebar.js
 * Drag-to-resize sidebar + persist the chosen width in vault.config.
 *
 * The config is stored as plain JSON (not encrypted) in the vault folder:
 *   <vault-dir>/vault.config  ->  { "sidebarWidth": 320 }
 *
 * Depends on: storage.js (vaultDirHandle, readVaultFile, writeVaultFile)
 */

// -- Constants ----------------------------------------------------------------

const CONFIG_FILE     = 'vault.config';
const SIDEBAR_MIN     = 160;
const SIDEBAR_MAX     = 520;
const SIDEBAR_DEFAULT = 280;

// -- Config I/O ---------------------------------------------------------------

async function readConfig() {
  try {
    const bytes = await readVaultFile(CONFIG_FILE);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch {
    return {};
  }
}

async function writeConfig(patch) {
  try {
    const updated = { ...(await readConfig()), ...patch };
    await writeVaultFile(CONFIG_FILE, new TextEncoder().encode(JSON.stringify(updated)));
  } catch { /* non-critical */ }
}

// -- Apply / Restore width ----------------------------------------------------

function applySidebarWidth(width) {
  $('.sidebar').css('width', Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)) + 'px');
}

async function restoreSidebarWidth() {
  const cfg = await readConfig();
  applySidebarWidth(cfg.sidebarWidth ?? SIDEBAR_DEFAULT);
}

// -- Drag-to-resize -----------------------------------------------------------

let saveWidthTimer = null;

$(document).on('mousedown', '#sidebarResizer', function (e) {
  e.preventDefault();

  const $resizer = $(this);
  const startX   = e.clientX;
  const startW   = $('.sidebar').width();

  $resizer.addClass('dragging');
  $('body').css({ cursor: 'col-resize', 'user-select': 'none' });

  $(document).on('mousemove.resize', e => applySidebarWidth(startW + (e.clientX - startX)));

  $(document).on('mouseup.resize', () => {
    $resizer.removeClass('dragging');
    $('body').css({ cursor: '', 'user-select': '' });
    $(document).off('mousemove.resize mouseup.resize');

    clearTimeout(saveWidthTimer);
    saveWidthTimer = setTimeout(async () => {
      if (hasVaultDir()) await writeConfig({ sidebarWidth: $('.sidebar').width() });
    }, 400);
  });
});
