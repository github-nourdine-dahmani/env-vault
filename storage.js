/**
 * storage.js
 * File-system persistence layer using the File System Access API.
 *
 * Layout on disk (inside the user-chosen vault folder):
 *
 *   <vault-dir>/
 *     vault.meta            <- encrypted index: [ { id, name, desc } ] (group list)
 *     vault.config          <- plain JSON: UI preferences
 *     <group-id>/
 *       group.meta          <- encrypted: { name, desc, envOrder, envMeta }
 *       <env-id>.vault      <- encrypted content (Array<{k,v,c}> for env, string for txt)
 *
 * Binary file format (.meta and .vault):
 *   [ salt (16 bytes) | iv (12 bytes) | AES-GCM ciphertext ]
 */

// -- In-memory state ----------------------------------------------------------

let vaultData     = { groups: [] };
let vaultDirHandle = null;

function getVaultData() { return vaultData; }
function hasVaultDir()   { return vaultDirHandle !== null; }

// -- Folder selection ---------------------------------------------------------

async function pickVaultFolder() {
  vaultDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandleToIdb();
}

// -- IndexedDB (persisted folder handle) --------------------------------------

const IDB_NAME  = 'envvault';
const IDB_STORE = 'handles';
const IDB_KEY   = 'vaultDir';

/** Open the IndexedDB database. */
function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Run a single IDB transaction and return the request result. */
async function withIdb(mode, fn) {
  const db  = await openIdb();
  const tx  = db.transaction(IDB_STORE, mode);
  const val = await new Promise((res, rej) => {
    const req = fn(tx.objectStore(IDB_STORE));
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
  db.close();
  return val;
}

async function saveHandleToIdb() {
  if (!vaultDirHandle) return;
  await withIdb('readwrite', store => store.put(vaultDirHandle, IDB_KEY));
}

async function restoreHandleFromIdb() {
  try {
    const handle = await withIdb('readonly', store => store.get(IDB_KEY));
    if (!handle) return false;
    if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return false;
    vaultDirHandle = handle;
    return true;
  } catch {
    return false;
  }
}

// -- Low-level file I/O -------------------------------------------------------

async function readFile(dirHandle, filename) {
  try {
    const file = await (await dirHandle.getFileHandle(filename)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function writeFile(dirHandle, filename, bytes) {
  const writer = await (await dirHandle.getFileHandle(filename, { create: true })).createWritable();
  await writer.write(bytes);
  await writer.close();
}

async function deleteFile(dirHandle, filename) {
  try { await dirHandle.removeEntry(filename); } catch { /* ignore */ }
}

async function getGroupDir(name) {
  return vaultDirHandle.getDirectoryHandle(name, { create: true });
}

const readVaultFile  = (f)    => readFile(vaultDirHandle, f);
const writeVaultFile = (f, b) => writeFile(vaultDirHandle, f, b);

// -- Encryption helpers -------------------------------------------------------

const SALT_LEN = 16;
const IV_LEN   = 12;

async function packEncrypted(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv   = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key  = await deriveMasterKey(password, salt);
  const ct   = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(data))
  );
  const buf = new Uint8Array(SALT_LEN + IV_LEN + ct.byteLength);
  buf.set(salt, 0);
  buf.set(iv, SALT_LEN);
  buf.set(new Uint8Array(ct), SALT_LEN + IV_LEN);
  return buf;
}

async function unpackEncrypted(bytes, password) {
  const salt = bytes.slice(0, SALT_LEN);
  const iv   = bytes.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ct   = bytes.slice(SALT_LEN + IV_LEN);
  const key  = await deriveMasterKey(password, salt);
  const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// -- Load vault ---------------------------------------------------------------

async function loadVault(password) {
  const metaBytes = await readVaultFile('vault.meta');
  if (!metaBytes) { vaultData = { groups: [] }; return; }

  try {
    const meta   = await unpackEncrypted(metaBytes, password);
    const groups = await Promise.all(meta.map(stub => loadGroup(stub, password)));
    vaultData = { groups };
  } catch {
    throw new Error('Wrong password or corrupted vault');
  }
}

/** Load a single group's metadata and all its env files. */
async function loadGroup(stub, password) {
  let groupDir;
  try { groupDir = await vaultDirHandle.getDirectoryHandle(stub.id); }
  catch { return { ...stub, envs: [] }; }

  const gmBytes = await readFile(groupDir, 'group.meta');
  const gm = gmBytes
    ? await unpackEncrypted(gmBytes, password)
    : { name: stub.name, desc: '', envOrder: [], envMeta: {} };

  const envs = await Promise.all(
    (gm.envOrder ?? []).map(envId => loadEnv(groupDir, envId, gm.envMeta, password))
  );

  return { id: stub.id, name: gm.name, desc: gm.desc, envs };
}

/** Load a single env file from its group directory. */
async function loadEnv(groupDir, envId, envMetaMap, password) {
  const bytes = await readFile(groupDir, `${envId}.vault`);
  const vars  = bytes ? await unpackEncrypted(bytes, password) : [];
  const meta  = (envMetaMap ?? {})[envId] ?? { name: envId, desc: '', type: 'env' };
  return { id: envId, name: meta.name, desc: meta.desc, type: meta.type, vars };
}

// -- Save vault ---------------------------------------------------------------

async function saveVault(password) {
  const { groups } = vaultData;

  await Promise.all(groups.map(group => saveGroup(group, password)));

  const meta = groups.map(({ id, name, desc }) => ({ id, name, desc }));
  await writeVaultFile('vault.meta', await packEncrypted(meta, password));
}

/** Save a single group: its env files + group.meta. */
async function saveGroup(group, password) {
  const groupDir = await getGroupDir(group.id);
  const envMeta  = {};

  await Promise.all(group.envs.map(async env => {
    envMeta[env.id] = { name: env.name, desc: env.desc, type: env.type };
    await writeFile(groupDir, `${env.id}.vault`, await packEncrypted(env.vars, password));
  }));

  const gm = {
    name: group.name, desc: group.desc,
    envOrder: group.envs.map(e => e.id), envMeta,
  };
  await writeFile(groupDir, 'group.meta', await packEncrypted(gm, password));
}

// -- Deletion helpers ---------------------------------------------------------

async function deleteGroupDir(groupId) {
  try { await vaultDirHandle.removeEntry(groupId, { recursive: true }); } catch { /* ignore */ }
}

async function deleteEnvFile(groupId, envId) {
  try {
    const groupDir = await vaultDirHandle.getDirectoryHandle(groupId);
    await deleteFile(groupDir, `${envId}.vault`);
  } catch { /* ignore */ }
}
