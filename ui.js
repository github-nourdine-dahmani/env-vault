/**
 * ui.js
 * Generic UI helpers: modals, toast notifications, and HTML escaping.
 */

// ── HTML escaping ────────────────────────────────────────────────────────────

/**
 * Escape a string so it is safe to inject into HTML.
 * @param {*} s
 * @returns {string}
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Modals ───────────────────────────────────────────────────────────────────

/** Open a modal overlay by its element id. */
function openModal(id) {
  $('#' + id).addClass('open');
}

/** Close a modal overlay by its element id. */
function closeModal(id) {
  $('#' + id).removeClass('open');
}

// ── Toast notifications ──────────────────────────────────────────────────────

let toastTimer = null;

/**
 * Show a brief toast message at the bottom-right of the screen.
 * @param {string} msg
 */
function showToast(msg) {
  $('#toastMsg').text(msg);
  $('#toast').addClass('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').removeClass('show'), 2200);
}
