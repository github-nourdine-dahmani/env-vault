/**
 * sidebar.js
 * Drag-to-resize sidebar + persist the chosen width in vault.config.
 *
 * The config is stored as plain JSON (not encrypted) in the vault folder:
 *   <vault-dir>/vault.config   →  { "sidebarWidth": 320 }
 *
 * Depends on: storage.js (vaultDirHandle, readVaultFile, writeVaultFile)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const CONFIG_FILE    = 'vault.config';
const SIDEBAR_MIN    = 160;   // px
const SIDEBAR_MAX    = 520;   // px
const SIDEBAR_DEFAULT = 280;  // px — matches the CSS default

// ── Config I/O ────────────────────────────────────────────────────────────────

/**
 * Read vault.config from disk and return the parsed object.
 * Returns {} if the file doesn't exist or can't be parsed.
 */
async function readConfig() {
  try {
    const bytes = await readVaultFile(CONFIG_FILE);
    if (!bytes) return {};
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the existing vault.config and write it back.
 * @param {object} patch
 */
async function writeConfig(patch) {
  try {
    const current = await readConfig();
    const updated  = { ...current, ...patch };
    const bytes    = new TextEncoder().encode(JSON.stringify(updated));
    await writeVaultFile(CONFIG_FILE, bytes);
  } catch {
    // Non-critical — silently ignore write failures
  }
}

// ── Apply width ───────────────────────────────────────────────────────────────

/** Set the sidebar element to `width` pixels. */
function applySidebarWidth(width) {
  const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width));
  $('.sidebar').css('width', clamped + 'px');
}

// ── Restore saved width ───────────────────────────────────────────────────────

/**
 * Load the saved sidebar width from vault.config and apply it.
 * Call this after the vault folder is known (i.e. after unlock).
 */
async function restoreSidebarWidth() {
  const cfg = await readConfig();
  applySidebarWidth(cfg.sidebarWidth ?? SIDEBAR_DEFAULT);
}

// ── Drag-to-resize ────────────────────────────────────────────────────────────

let saveWidthTimer = null;

$(document).on('mousedown', '#sidebarResizer', function (e) {
  e.preventDefault();

  const $resizer = $(this);
  const $sidebar = $('.sidebar');
  const startX   = e.clientX;
  const startW   = $sidebar.width();

  $resizer.addClass('dragging');
  $('body').css('cursor', 'col-resize').css('user-select', 'none');

  $(document).on('mousemove.resize', function (e) {
    const newWidth = startW + (e.clientX - startX);
    applySidebarWidth(newWidth);
  });

  $(document).on('mouseup.resize', function () {
    $resizer.removeClass('dragging');
    $('body').css('cursor', '').css('user-select', '');
    $(document).off('mousemove.resize mouseup.resize');

    // Debounce the disk write — only save after the user stops dragging
    clearTimeout(saveWidthTimer);
    saveWidthTimer = setTimeout(async () => {
      if (hasVaultDir()) {
        await writeConfig({ sidebarWidth: $('.sidebar').width() });
      }
    }, 400);
  });
});
