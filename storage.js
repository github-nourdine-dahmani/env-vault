/**
 * storage.js
 * File-system persistence layer using the File System Access API.
 *
 * Layout on disk (inside the user-chosen vault folder):
 *
 *   <vault-dir>/
 *     vault.meta            ← encrypted index: [ { id, name, desc } ] (group list)
 *     vault.config          ← plain JSON: UI preferences
 *     <group-id>/
 *       group.meta          ← encrypted: { name, desc, envOrder: [id, …] }
 *       <env-id>.vault      ← encrypted vars: Array<{ k, v, c }>
 *
 * Binary file format (.meta and .vault):
 *   [ salt (16 bytes) | iv (12 bytes) | AES-GCM ciphertext ]
 *
 * Migration: if a legacy flat vault.meta (array of project objects) is found,
 * all projects are automatically moved into a single "Default" group.
 */

// ── In-memory state ──────────────────────────────────────────────────────────

/**
 * In-memory vault state.
 * Shape: { groups: Array<{ id, name, desc, envs: Array<{ id, name, desc, vars }> }> }
 */
let vaultData = { groups: [] };

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
 */
async function pickVaultFolder() {
  vaultDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandleToIdb();
}

// ── Persisted folder handle (IndexedDB) ──────────────────────────────────────

const IDB_NAME  = 'envvault';
const IDB_STORE = 'handles';
const IDB_KEY   = 'vaultDir';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function saveHandleToIdb() {
  if (!vaultDirHandle) return;
  const db = await openIdb();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).put(vaultDirHandle, IDB_KEY);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  db.close();
}

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
 * Read a file from a directory handle and return its raw bytes.
 * Returns null if the file does not exist.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 */
async function readFile(dirHandle, filename) {
  try {
    const fh   = await dirHandle.getFileHandle(filename);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Write raw bytes to a file in a directory handle (creates or overwrites).
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string}     filename
 * @param {Uint8Array} bytes
 */
async function writeFile(dirHandle, filename, bytes) {
  const fh     = await dirHandle.getFileHandle(filename, { create: true });
  const writer = await fh.createWritable();
  await writer.write(bytes);
  await writer.close();
}

/**
 * Delete a file from a directory handle (silently ignores missing files).
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 */
async function deleteFile(dirHandle, filename) {
  try { await dirHandle.removeEntry(filename); } catch { /* ignore */ }
}

/**
 * Get (or create) a sub-directory handle inside the vault root.
 * @param {string} name
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function getGroupDir(name) {
  return vaultDirHandle.getDirectoryHandle(name, { create: true });
}

// Convenience wrappers that operate on the vault root
const readVaultFile  = (f)    => readFile(vaultDirHandle, f);
const writeVaultFile = (f, b) => writeFile(vaultDirHandle, f, b);
const deleteVaultFile = (f)   => deleteFile(vaultDirHandle, f);

// ── Serialisation helpers ────────────────────────────────────────────────────

async function packEncrypted(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveMasterKey(password, salt);
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const ct   = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(data))
  );
  const buf = new Uint8Array(16 + 12 + ct.byteLength);
  buf.set(salt, 0);
  buf.set(iv,   16);
  buf.set(new Uint8Array(ct), 28);
  return buf;
}

async function unpackEncrypted(bytes, password) {
  const salt = bytes.slice(0,  16);
  const iv   = bytes.slice(16, 28);
  const ct   = bytes.slice(28);
  const key  = await deriveMasterKey(password, salt);
  const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// ── Migration helper ─────────────────────────────────────────────────────────

/**
 * Detect and migrate a legacy flat vault (array of { id, name, desc }) into
 * a single "Default" group. Returns the migrated groups array, or null if
 * the meta is already in the new format (array of group stubs).
 *
 * Legacy format:  [ { id, name, desc }, … ]   (projects had .vault files at root)
 * New format:     [ { id, name, desc }, … ]   (groups have sub-directories)
 *
 * We distinguish them by checking whether the first entry has a sub-directory
 * with a group.meta file inside.
 */
async function migrateIfNeeded(meta, password) {
  if (!meta || meta.length === 0) return null; // nothing to migrate

  // Check if first entry looks like a legacy project (root-level .vault file)
  const firstId = meta[0].id;
  const legacyFile = await readVaultFile(`${firstId}.vault`);
  if (!legacyFile) return null; // no legacy file → already new format (or empty)

  // It's legacy — migrate all flat projects into a "Default" group
  const groupId  = genId();
  const groupDir = await getGroupDir(groupId);

  const envs = await Promise.all(meta.map(async entry => {
    const bytes = await readVaultFile(`${entry.id}.vault`);
    const vars  = bytes ? await unpackEncrypted(bytes, password) : [];

    // Write the env file into the new group sub-directory
    if (bytes) {
      await writeFile(groupDir, `${entry.id}.vault`, bytes);
      // Remove the old root-level file
      await deleteVaultFile(`${entry.id}.vault`);
    }

    return { id: entry.id, name: entry.name, desc: entry.desc ?? '', vars };
  }));

  // Write group.meta
  const groupMeta = { name: 'Default', desc: '', envOrder: envs.map(e => e.id) };
  await writeFile(groupDir, 'group.meta', await packEncrypted(groupMeta, password));

  return [{ id: groupId, name: 'Default', desc: '', envs }];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and decrypt the entire vault from disk.
 * Handles both the new group/env layout and the legacy flat layout.
 * @param {string} password
 */
async function loadVault(password) {
  const metaBytes = await readVaultFile('vault.meta');

  if (!metaBytes) {
    vaultData = { groups: [] };
    return;
  }

  try {
    const meta = await unpackEncrypted(metaBytes, password);
    // meta = [ { id, name, desc }, … ]  (group stubs)

    // Try migration first
    const migrated = await migrateIfNeeded(meta, password);
    if (migrated) {
      vaultData = { groups: migrated };
      // Rewrite vault.meta in new format
      await saveVault(password);
      return;
    }

    // Normal load: each entry is a group with its own sub-directory
    const groups = await Promise.all(meta.map(async stub => {
      let groupDir;
      try {
        groupDir = await vaultDirHandle.getDirectoryHandle(stub.id);
      } catch {
        return { ...stub, envs: [] };
      }

      const gmBytes = await readFile(groupDir, 'group.meta');
      const gm      = gmBytes ? await unpackEncrypted(gmBytes, password) : { name: stub.name, desc: '', envOrder: [] };

      const envs = await Promise.all((gm.envOrder ?? []).map(async envId => {
        const envBytes = await readFile(groupDir, `${envId}.vault`);
        const vars     = envBytes ? await unpackEncrypted(envBytes, password) : [];
        // env name/desc are stored in group.meta under envMeta map
        const envMeta  = (gm.envMeta ?? {})[envId] ?? { name: envId, desc: '' };
        return { id: envId, name: envMeta.name, desc: envMeta.desc ?? '', vars };
      }));

      return { id: stub.id, name: gm.name, desc: gm.desc ?? '', envs };
    }));

    vaultData = { groups };
  } catch (e) {
    throw new Error('Wrong password or corrupted vault');
  }
}

/**
 * Encrypt and persist the entire vault to disk.
 * Writes vault.meta (group index) + per-group directories with group.meta + env files.
 * @param {string} password
 */
async function saveVault(password) {
  const { groups } = vaultData;

  await Promise.all(groups.map(async group => {
    const groupDir = await getGroupDir(group.id);

    // Build envMeta map and write each env file
    const envMeta = {};
    await Promise.all(group.envs.map(async env => {
      envMeta[env.id] = { name: env.name, desc: env.desc ?? '' };
      const bytes = await packEncrypted(env.vars, password);
      await writeFile(groupDir, `${env.id}.vault`, bytes);
    }));

    // Write group.meta
    const gm = {
      name:     group.name,
      desc:     group.desc ?? '',
      envOrder: group.envs.map(e => e.id),
      envMeta,
    };
    await writeFile(groupDir, 'group.meta', await packEncrypted(gm, password));
  }));

  // Write root vault.meta (group stubs only)
  const meta      = groups.map(({ id, name, desc }) => ({ id, name, desc }));
  const metaBytes = await packEncrypted(meta, password);
  await writeVaultFile('vault.meta', metaBytes);
}

/**
 * Delete a group's entire sub-directory from disk.
 * @param {string} groupId
 */
async function deleteGroupDir(groupId) {
  try {
    await vaultDirHandle.removeEntry(groupId, { recursive: true });
  } catch { /* ignore */ }
}

/**
 * Delete a single env file from its group directory.
 * @param {string} groupId
 * @param {string} envId
 */
async function deleteEnvFile(groupId, envId) {
  try {
    const groupDir = await vaultDirHandle.getDirectoryHandle(groupId);
    await deleteFile(groupDir, `${envId}.vault`);
  } catch { /* ignore */ }
}

// Keep legacy name for sidebar.js compatibility
const deleteProjectFile = (id) => Promise.resolve();
