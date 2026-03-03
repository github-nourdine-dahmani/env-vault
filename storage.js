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
 *       group.meta          ← encrypted: { name, desc, envOrder, envMeta }
 *       <env-id>.vault      ← encrypted content (Array<{k,v,c}> for env, string for txt)
 *
 * Binary file format (.meta and .vault):
 *   [ salt (16 bytes) | iv (12 bytes) | AES-GCM ciphertext ]
 */

// ── In-memory state ──────────────────────────────────────────────────────────

/**
 * In-memory vault state.
 * Shape: { groups: Array<{ id, name, desc, envs: Array<{ id, name, desc, type, vars }> }> }
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
 */
async function writeFile(dirHandle, filename, bytes) {
  const fh     = await dirHandle.getFileHandle(filename, { create: true });
  const writer = await fh.createWritable();
  await writer.write(bytes);
  await writer.close();
}

/**
 * Delete a file from a directory handle (silently ignores missing files).
 */
async function deleteFile(dirHandle, filename) {
  try { await dirHandle.removeEntry(filename); } catch { /* ignore */ }
}

/**
 * Get (or create) a sub-directory handle inside the vault root.
 */
async function getGroupDir(name) {
  return vaultDirHandle.getDirectoryHandle(name, { create: true });
}

// Convenience wrappers that operate on the vault root
const readVaultFile  = (f)    => readFile(vaultDirHandle, f);
const writeVaultFile = (f, b) => writeFile(vaultDirHandle, f, b);

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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and decrypt the entire vault from disk.
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

    const groups = await Promise.all(meta.map(async stub => {
      let groupDir;
      try {
        groupDir = await vaultDirHandle.getDirectoryHandle(stub.id);
      } catch {
        return { ...stub, envs: [] };
      }

      const gmBytes = await readFile(groupDir, 'group.meta');
      const gm      = gmBytes ? await unpackEncrypted(gmBytes, password) : { name: stub.name, desc: '', envOrder: [], envMeta: {} };

      const envs = await Promise.all((gm.envOrder ?? []).map(async envId => {
        const envBytes = await readFile(groupDir, `${envId}.vault`);
        const vars     = envBytes ? await unpackEncrypted(envBytes, password) : [];
        const envMeta  = (gm.envMeta ?? {})[envId] ?? { name: envId, desc: '', type: 'env' };
        return { id: envId, name: envMeta.name, desc: envMeta.desc, type: envMeta.type, vars };
      }));

      return { id: stub.id, name: gm.name, desc: gm.desc, envs };
    }));

    vaultData = { groups };
  } catch {
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

    const envMeta = {};
    await Promise.all(group.envs.map(async env => {
      envMeta[env.id] = { name: env.name, desc: env.desc, type: env.type };
      const bytes = await packEncrypted(env.vars, password);
      await writeFile(groupDir, `${env.id}.vault`, bytes);
    }));

    const gm = { name: group.name, desc: group.desc, envOrder: group.envs.map(e => e.id), envMeta };
    await writeFile(groupDir, 'group.meta', await packEncrypted(gm, password));
  }));

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
