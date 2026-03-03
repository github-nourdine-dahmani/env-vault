/**
 * storage.js
 * File-system persistence layer using the File System Access API.
 *
 * Layout on disk (inside the user-chosen vault folder):
 *
 *   <vault-dir>/
 *     vault.meta          ← encrypted index: project list (id, name, desc)
 *     <project-id>.vault  ← encrypted vars for that project
 *
 * Binary file format (both .meta and .vault):
 *   [ salt (16 bytes) | iv (12 bytes) | ciphertext (rest) ]
 *
 * The salt is stored per-file so the vault folder is fully self-contained
 * and portable — no localStorage is used at all.
 */

// ── In-memory state ──────────────────────────────────────────────────────────

/**
 * In-memory vault state.
 * Shape: { projects: Array<{ id, name, desc, vars: Array<{k, v}> }> }
 */
let vaultData = { projects: [] };

/** The FileSystemDirectoryHandle for the open vault folder. */
let vaultDirHandle = null;

/** Return the live vault data object. */
function getVaultData() { return vaultData; }

/** Return true if a vault folder has been selected. */
function hasVaultDir() { return vaultDirHandle !== null; }

// ── Folder selection ─────────────────────────────────────────────────────────

/**
 * Ask the user to pick (or create) a vault folder.
 * Stores the handle in memory and persists it to IndexedDB for future sessions.
 * @returns {Promise<void>}
 */
async function pickVaultFolder() {
  vaultDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandleToIdb();
}

// ── Persisted folder handle (IndexedDB) ──────────────────────────────────────

const IDB_NAME  = 'envvault';
const IDB_STORE = 'handles';
const IDB_KEY   = 'vaultDir';

/** Open (or create) the envvault IndexedDB. */
function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Persist the current vaultDirHandle so it survives page reloads. */
async function saveHandleToIdb() {
  if (!vaultDirHandle) return;
  const db = await openIdb();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).put(vaultDirHandle, IDB_KEY);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  db.close();
}

/**
 * Try to restore a previously saved folder handle from IndexedDB.
 * Returns true if a handle was found AND the user grants permission.
 * Returns false if no handle is stored or permission is denied.
 * @returns {Promise<boolean>}
 */
async function restoreHandleFromIdb() {
  try {
    const db     = await openIdb();
    const tx     = db.transaction(IDB_STORE, 'readonly');
    const handle = await new Promise((res, rej) => {
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
    db.close();

    if (!handle) return false;

    // Ask for permission (small browser prompt, not the full OS picker)
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return false;

    vaultDirHandle = handle;
    return true;
  } catch {
    return false;
  }
}

// ── Low-level file I/O ───────────────────────────────────────────────────────

/**
 * Read a file from the vault folder and return its raw bytes.
 * Returns null if the file does not exist yet.
 *
 * @param {string} filename
 * @returns {Promise<Uint8Array|null>}
 */
async function readVaultFile(filename) {
  try {
    const fh   = await vaultDirHandle.getFileHandle(filename);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null; // file doesn't exist yet
  }
}

/**
 * Write raw bytes to a file in the vault folder (creates or overwrites).
 *
 * @param {string}     filename
 * @param {Uint8Array} bytes
 * @returns {Promise<void>}
 */
async function writeVaultFile(filename, bytes) {
  const fh     = await vaultDirHandle.getFileHandle(filename, { create: true });
  const writer = await fh.createWritable();
  await writer.write(bytes);
  await writer.close();
}

/**
 * Delete a file from the vault folder (silently ignores missing files).
 *
 * @param {string} filename
 * @returns {Promise<void>}
 */
async function deleteVaultFile(filename) {
  try {
    await vaultDirHandle.removeEntry(filename);
  } catch { /* ignore */ }
}

// ── Serialisation helpers ────────────────────────────────────────────────────

/**
 * Encrypt a JS value and pack it into the binary format:
 *   [ salt (16) | iv (12) | ciphertext ]
 *
 * A fresh salt is generated each time, so a new key is derived per write.
 * This means the password is re-derived on every save — acceptable for a
 * local tool (and keeps each file independently decryptable).
 *
 * @param {*}      data      Any JSON-serialisable value.
 * @param {string} password  The master password (plaintext).
 * @returns {Promise<Uint8Array>}
 */
async function packEncrypted(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveMasterKey(password, salt);
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const enc  = new TextEncoder();
  const ct   = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(data))
  );
  // Concatenate: salt | iv | ciphertext
  const buf = new Uint8Array(16 + 12 + ct.byteLength);
  buf.set(salt, 0);
  buf.set(iv,   16);
  buf.set(new Uint8Array(ct), 28);
  return buf;
}

/**
 * Unpack and decrypt a binary blob produced by {@link packEncrypted}.
 *
 * @param {Uint8Array} bytes
 * @param {string}     password
 * @returns {Promise<*>}
 */
async function unpackEncrypted(bytes, password) {
  const salt = bytes.slice(0,  16);
  const iv   = bytes.slice(16, 28);
  const ct   = bytes.slice(28);
  const key  = await deriveMasterKey(password, salt);
  const dec  = new TextDecoder();
  const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(pt));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and decrypt the vault from disk.
 * Reads vault.meta (project index) and all per-project .vault files.
 * Throws if the password is wrong or any file is corrupted.
 *
 * @param {string} password  Master password (plaintext).
 * @returns {Promise<void>}
 */
async function loadVault(password) {
  const metaBytes = await readVaultFile('vault.meta');

  if (!metaBytes) {
    // Brand-new vault — start empty
    vaultData = { projects: [] };
    return;
  }

  try {
    const meta = await unpackEncrypted(metaBytes, password);
    // meta = [ { id, name, desc }, … ]

    const projects = await Promise.all(meta.map(async entry => {
      const fileBytes = await readVaultFile(`${entry.id}.vault`);
      const vars = fileBytes ? await unpackEncrypted(fileBytes, password) : [];
      return { ...entry, vars };
    }));

    vaultData = { projects };
  } catch {
    throw new Error('Wrong password or corrupted vault');
  }
}

/**
 * Encrypt and persist the entire vault to disk.
 * Writes vault.meta + one .vault file per project.
 *
 * @param {string} password  Master password (plaintext).
 * @returns {Promise<void>}
 */
async function saveVault(password) {
  const { projects } = vaultData;

  // Write per-project files
  await Promise.all(projects.map(async p => {
    const bytes = await packEncrypted(p.vars, password);
    await writeVaultFile(`${p.id}.vault`, bytes);
  }));

  // Write index (project metadata without vars)
  const meta      = projects.map(({ id, name, desc }) => ({ id, name, desc }));
  const metaBytes = await packEncrypted(meta, password);
  await writeVaultFile('vault.meta', metaBytes);
}

/**
 * Delete a single project's .vault file from disk.
 * Call this when removing a project, then call saveVault() to update the index.
 *
 * @param {string} projectId
 * @returns {Promise<void>}
 */
async function deleteProjectFile(projectId) {
  await deleteVaultFile(`${projectId}.vault`);
}
