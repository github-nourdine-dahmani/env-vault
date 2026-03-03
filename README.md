# 🔐 ENV Vault

A **zero-dependency, fully local** `.env` file manager that encrypts your environment variables directly on your filesystem. No server, no cloud, no account — your secrets never leave your machine.

![ENV Vault screenshot placeholder](https://placehold.co/900x500/0a0a0f/00ff88?text=ENV+Vault)

---

## ✨ Features

| Feature | Details |
|---|---|
| 🔒 **AES-256-GCM encryption** | Every project is stored as an individually encrypted `.vault` file |
| 🗝️ **PBKDF2 key derivation** | 100 000 iterations of SHA-256, with a unique random salt per file write |
| 📁 **Local filesystem storage** | Uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — files live wherever you choose |
| 🔄 **Session persistence** | Vault folder handle is remembered via IndexedDB; only one click to re-grant permission on next visit |
| 📝 **Key-Value editor** | Structured table editor with masked sensitive fields (auto-detected by key name) |
| ✏️ **Raw editor** | Edit your `.env` directly as plain text; switch modes without losing data |
| 💬 **Comment column** | Add private notes to any variable — stored encrypted, never exported |
| ↕️ **Drag-to-reorder projects** | Drag the `⠿` handle to rearrange your project list; order is persisted |
| ⧉ **Duplicate projects** | One-click duplication — great for cloning prod → staging |
| ✏️ **Rename projects** | Edit name and description at any time |
| ↑ **Import `.vault` files** | Import encrypted vault files shared by others (requires their password) |
| ↓ **Export `.env`** | Download a standard `.env` file (comments are not exported) |
| ⎘ **Copy All** | Copy all `KEY=value` pairs to clipboard in one click |
| ↔️ **Resizable sidebar** | Drag the divider to adjust sidebar width; preference saved to `vault.config` |
| 🛡️ **Zero network requests** | No telemetry, no CDN calls at runtime (jQuery is loaded from CDN only once) |

---

## 🚀 Getting Started

ENV Vault is a **static HTML application** — no build step, no npm install.

### Requirements

- A modern browser with support for the [File System Access API](https://caniuse.com/native-filesystem-api):
  - ✅ Chrome / Edge 86+
  - ✅ Opera 72+
  - ❌ Firefox (not yet supported)
  - ❌ Safari (not yet supported)

### Running locally

```bash
git clone https://github.com/your-username/env-vault.git
cd env-vault

# Any static file server works, e.g.:
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html` in your browser.

> **Why a server?** The File System Access API requires a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (`https://` or `localhost`). Opening `index.html` directly as a `file://` URL will not work.

---

## 🗂️ File Structure

```
env-vault/
├── index.html   # App shell & HTML structure
├── styles.css       # All styles (dark terminal theme, design tokens)
├── crypto.js        # PBKDF2 key derivation (Web Crypto API)
├── storage.js       # File System Access API + IndexedDB session persistence
├── ui.js            # Generic helpers: modals, toasts, HTML escaping
├── sidebar.js       # Sidebar resize logic + vault.config persistence
├── editor.js        # Key-value / raw editor, sync helpers, toolbar actions
├── projects.js      # Project CRUD, drag-to-reorder, duplicate, rename, import
└── auth.js          # Two-step unlock flow (folder picker → password)
```

Your vault folder (chosen by you) will contain:

```
your-vault-folder/
├── vault.meta          # Encrypted index: project list (id, name, desc)
├── vault.config        # Plain JSON: UI preferences (sidebar width)
├── <project-id>.vault  # Encrypted variables for each project
└── ...
```

---

## 🔐 Security Model

### Encryption

Each file uses **AES-256-GCM** with a key derived via **PBKDF2**:

```
Binary file format:
[ salt (16 bytes) | iv (12 bytes) | AES-GCM ciphertext ]
```

- A **fresh random salt** is generated on every write, so the derived key changes each time.
- A **fresh random IV** is generated on every write, as required by AES-GCM.
- `vault.meta` and each `.vault` file are independently encrypted and independently decryptable — they are fully self-contained.
- `vault.config` stores only non-sensitive UI preferences (sidebar width) and is **not encrypted**.

### Key derivation parameters

| Parameter | Value |
|---|---|
| Algorithm | PBKDF2 |
| Hash | SHA-256 |
| Iterations | 100 000 |
| Key length | 256 bits |
| Salt length | 16 bytes (random per write) |
| IV length | 12 bytes (random per write) |

### What is never stored

- Your master password is **only held in memory** for the duration of the session. It is wiped when you click 🔒 Lock.
- No data is ever sent to any server.
- No analytics, no tracking.

---

## 🔓 Decrypting a `.vault` file without the app

Each `.vault` file is a self-contained binary blob. You can decrypt it with standard tools:

```python
# Python 3 — requires: pip install cryptography
import struct
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import base64, json, getpass

password = getpass.getpass("Master password: ").encode()

with open("your-project.vault", "rb") as f:
    data = f.read()

salt = data[:16]
iv   = data[16:28]
ct   = data[28:]

kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100_000)
key = kdf.derive(password)

plaintext = AESGCM(key).decrypt(iv, ct, None)
print(json.loads(plaintext))
```

```bash
# Node.js (built-in crypto — no install needed)
node -e "
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Master password: ', async (password) => {
  rl.close();
  const buf  = fs.readFileSync(process.argv[2]);
  const salt = buf.slice(0, 16);
  const iv   = buf.slice(16, 28);
  const ct   = buf.slice(28);

  const keyMat = await crypto.subtle.importKey('raw', Buffer.from(password), 'PBKDF2', false, ['deriveKey']);
  const key    = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  console.log(JSON.parse(Buffer.from(plain).toString()));
});" your-project.vault
```

---

## 🖥️ Usage Guide

### First launch

1. Open `index.html` in a supported browser via a local server.
2. Click **Choose Vault Folder** and select (or create) the folder where your encrypted files will live.
3. Enter a master password. This password encrypts every file in the vault.

> **Important:** There is no password recovery. If you forget your master password, your vault files cannot be decrypted.

### Creating a project

Click **+ New Project** in the sidebar, enter a name and optional description.

### Editing variables

- **Key-Value mode** — structured table with masked sensitive fields (any key containing `secret`, `key`, `token`, `pass`, `pwd`, `auth`, or `private` is masked by default). Click 👁 to reveal.
- **Raw mode** — edit the `.env` content directly as text. Switching modes syncs changes automatically.
- **Comment column** — add private notes per variable. Comments are stored encrypted but are **not included** in exports.

### Saving

Click **✓ Save** to encrypt and write to disk. Changes are not auto-saved.

### Sharing a vault file

1. Save the project.
2. Share the `.vault` file from your vault folder.
3. The recipient imports it via **↑ Import** and enters the password you shared with them out-of-band.

### Reordering projects

Hover over a project in the sidebar to reveal the `⠿` drag handle. Drag it to reorder. Order is saved automatically.

### Duplicating a project

Hover over a project → click **⧉**, or select a project and click **⧉ Duplicate** in the topbar. The copy is named `<original> (copy)` and is inserted immediately after the original.

### Resizing the sidebar

Drag the thin divider between the sidebar and the main panel. Width is saved to `vault.config` in your vault folder.

---

## 🤝 Contributing

Pull requests are welcome. The codebase is intentionally simple — no bundler, no framework, no build step. Each JavaScript file has a single responsibility and is independently readable.

Please keep the zero-dependency philosophy: no npm packages, no external APIs.

---

## 📄 License

MIT — do whatever you want, just don't remove the license header.
