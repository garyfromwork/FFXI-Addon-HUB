// In development .env is loaded; in a packaged build config.js is used.
try { require('dotenv').config(); } catch {}

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { autoUpdater } = require('electron-updater');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// E2EE CRYPTO HELPERS
// ==========================================

// ── Key storage (private key stays on-device, never sent to server) ──
function getKeyPath(userId) {
  return path.join(app.getPath('userData'), 'keys', `${userId}.json`);
}
function loadLocalKeys(userId) {
  try { return JSON.parse(fs.readFileSync(getKeyPath(userId), 'utf8')); }
  catch { return null; }
}
function saveLocalKeys(userId, keys) {
  const p = getKeyPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(keys), { mode: 0o600 }); // owner-only permissions
}

// ── RSA-OAEP: wraps/unwraps the per-conversation AES key ──
function rsaEncrypt(publicKeyPem, plainBase64) {
  return crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plainBase64, 'base64')
  ).toString('base64');
}
function rsaDecrypt(privateKeyPem, cipherBase64) {
  return crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(cipherBase64, 'base64')
  ).toString('base64');
}

// ── AES-256-GCM: encrypts/decrypts message content ──
function aesEncrypt(keyBase64, plaintext) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [iv 12B][tag 16B][ciphertext]
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function aesDecrypt(keyBase64, encBase64) {
  const key  = Buffer.from(keyBase64, 'base64');
  const data = Buffer.from(encBase64, 'base64');
  const iv   = data.subarray(0, 12);
  const tag  = data.subarray(12, 28);
  const ct   = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Conversation key cache (in-memory, cleared on restart) ──
const convKeyCache = new Map();
function convCacheKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

async function getOrCreateConvKey(myId, partnerId) {
  const cacheK = convCacheKey(myId, partnerId);
  if (convKeyCache.has(cacheK)) return convKeyCache.get(cacheK);

  const myKeys = loadLocalKeys(myId);
  if (!myKeys) throw new Error('Local keypair missing — log out and back in to regenerate.');

  // Canonical ordering required by the DB constraint
  const [u1, u2] = myId < partnerId ? [myId, partnerId] : [partnerId, myId];
  const iAmUser1 = (myId === u1);

  // Try to fetch an existing conversation key
  const { data: existing } = await supabase
    .from('conversation_keys')
    .select('key_for_user1, key_for_user2')
    .eq('user1_id', u1)
    .eq('user2_id', u2)
    .maybeSingle();

  if (existing) {
    const encForMe = iAmUser1 ? existing.key_for_user1 : existing.key_for_user2;
    const aesKey = rsaDecrypt(myKeys.privateKey, encForMe);
    convKeyCache.set(cacheK, aesKey);
    return aesKey;
  }

  // No key exists yet — create one
  const { data: partnerProfile } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', partnerId)
    .maybeSingle();

  if (!partnerProfile?.public_key) {
    throw new Error('The other user has not set up encryption yet. Ask them to log in once.');
  }

  const aesKey       = crypto.randomBytes(32).toString('base64');
  const myPubKey     = myKeys.publicKey;
  const theirPubKey  = partnerProfile.public_key;

  await supabase.from('conversation_keys').insert({
    user1_id:      u1,
    user2_id:      u2,
    key_for_user1: rsaEncrypt(iAmUser1 ? myPubKey : theirPubKey, aesKey),
    key_for_user2: rsaEncrypt(iAmUser1 ? theirPubKey : myPubKey, aesKey),
  });

  convKeyCache.set(cacheK, aesKey);
  return aesKey;
}

// ==========================================
// SUPABASE INITIALIZATION
// ==========================================
const { supabaseUrl, supabaseKey } = require('./config');
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// SESSION PERSISTENCE
// ==========================================
// We manage session tokens ourselves — Supabase's built-in storage
// relies on localStorage which doesn't exist in the Electron main process.
function getSessionPath() {
  return path.join(app.getPath('userData'), 'session.json');
}

function saveSession(session) {
  try {
    const p = getSessionPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      access_token:  session.access_token,
      refresh_token: session.refresh_token
    }));
  } catch (e) { console.error('saveSession failed:', e.message); }
}

function clearSession() {
  try { fs.unlinkSync(getSessionPath()); } catch {}
}

function loadSession() {
  try { return JSON.parse(fs.readFileSync(getSessionPath(), 'utf8')); }
  catch { return null; }
}

// ==========================================
// WINDOW CREATION & APP LIFECYCLE
// ==========================================
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 920,
    minHeight: 600,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#090910',
      symbolColor: '#c9a227',
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
}

function sendUpdateStatus(payload) {
  mainWindow?.webContents.send('update-status', payload);
}

function initAutoUpdater() {
  if (!app.isPackaged) return;

  // Wire electron-log for internal electron-updater diagnostics.
  // electron-log v5 changed its config API, so we only set the logger reference
  // and skip the level assignment to avoid a throw that would break the handlers.
  try {
    const log = require('electron-log');
    autoUpdater.logger = log;
  } catch {
    autoUpdater.logger = console;
  }

  autoUpdater.autoDownload    = true;
  autoUpdater.allowPrerelease = false;

  // Event handlers use sendUpdateStatus only — no direct log calls so
  // there is no risk of a "log is not defined" error reaching the renderer.
  autoUpdater.on('checking-for-update',  ()     => sendUpdateStatus({ type: 'checking' }));
  autoUpdater.on('update-available',     (info) => sendUpdateStatus({ type: 'available',   version: info.version }));
  autoUpdater.on('update-not-available', ()     => sendUpdateStatus({ type: 'up-to-date' }));
  autoUpdater.on('download-progress',    (prog) => sendUpdateStatus({ type: 'downloading', percent: Math.round(prog.percent) }));

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ type: 'ready', version: info.version });
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `FFXI Addon HUB ${info.version} is ready to install.`,
      detail: 'Restart the app now to apply the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err.message);
    sendUpdateStatus({ type: 'error', message: err.message });
  });

  // Delay the first check so the renderer window is fully loaded and ready
  // to receive status events before they start firing.
  setTimeout(() => autoUpdater.checkForUpdates(), 3000);
}

app.whenReady().then(() => {
  createWindow();
  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ==========================================
// FILE SYSTEM & ADDON HANDLERS
// ==========================================

// Select Folder with validation and write-permission check
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select your Windower folder',
    buttonLabel: 'Select Windower Folder',
  });

  if (result.canceled) return null;

  const folderPath = result.filePaths[0];
  const addonsDir  = path.join(folderPath, 'addons');

  if (!fs.existsSync(addonsDir)) {
    return { error: 'This doesn\'t look like a Windower folder — no "addons" subfolder was found. Select the root Windower directory (e.g. C:\\Windower).' };
  }

  // Test write access before accepting the path — avoids silent failures or UAC prompts later
  try {
    const testFile = path.join(addonsDir, '.write-test');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
  } catch {
    return {
      error:
        'The app doesn\'t have write permission to that folder.\n\n' +
        'This usually means Windower is installed in a protected location like Program Files. ' +
        'Move your Windower installation to a user-accessible folder such as C:\\Windower or ' +
        'C:\\Games\\Windower and try again.'
    };
  }

  return { path: folderPath };
});

// Install Addon
ipcMain.handle('install-addon', async (event, { downloadUrl, windowerPath, addonName }) => {
  try {
    const addonsDirectory = path.join(windowerPath, 'addons');
    
    if (!fs.existsSync(addonsDirectory)) {
      fs.mkdirSync(addonsDirectory, { recursive: true });
    }

    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    const rootFolder = zipEntries[0].entryName.split('/')[0];

    zipEntries.forEach((entry) => {
      if (!entry.isDirectory) {
        const relativePath = entry.entryName.substring(rootFolder.length + 1);
        const targetPath = path.join(addonsDirectory, addonName, relativePath);
        
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, entry.getData());
      }
    });

    return { success: true };
  } catch (error) {
    console.error("Installation failed:", error);
    const isPermission = error.code === 'EACCES' || error.code === 'EPERM';
    return {
      success: false,
      error: isPermission
        ? 'Permission denied. Your Windower folder may be in a protected location (e.g. Program Files). Move it to C:\\Windower and update your path in Settings.'
        : error.message
    };
  }
});

// Check if Addon exists
ipcMain.handle('check-addon', (event, { windowerPath, addonName }) => {
  if (!windowerPath) return false;
  const targetPath = path.join(windowerPath, 'addons', addonName);
  return fs.existsSync(targetPath);
});

// Uninstall Addon
ipcMain.handle('uninstall-addon', async (event, { windowerPath, addonName }) => {
  try {
    const targetPath = path.join(windowerPath, 'addons', addonName);
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    return { success: true };
  } catch (error) {
    console.error("Uninstall failed:", error);
    return { success: false, error: error.message };
  }
});

// ==========================================
// SUPABASE AUTHENTICATION HANDLERS
// ==========================================

// Register a new user (with automatic server-side confirmation)
ipcMain.handle('register-user', async (event, { email, password }) => {
  try {
    const { data, error } = await supabase.auth.signUp({
      email: email,
      password: password,
      options: {
        // This tells Supabase to instantly verify them, bypassing the dashboard toggle entirely!
        email_confirm: true 
      }
    });

    if (error) throw error;
    if (data.session) saveSession(data.session);
    return { success: true, email: data.user.email, id: data.user.id };
  } catch (error) {
    console.error("Registration error:", error.message);
    return { success: false, error: error.message };
  }
});

// Log in an existing user
ipcMain.handle('login-user', async (event, { email, password }) => {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    saveSession(data.session);
    return { success: true, email: data.user.email, id: data.user.id };
  } catch (error) {
    return { success: false, error: "Invalid email or password." };
  }
});

// ==========================================
// DATABASE & REVIEW HANDLERS
// ==========================================

// App version
ipcMain.handle('get-app-version', () => app.getVersion());

// Open URL in the system browser
ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));

// Check if the current user is an admin
ipcMain.handle('check-is-admin', async (_event, userId) => {
  try {
    const { data } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle();
    return { isAdmin: data?.is_admin === true };
  } catch { return { isAdmin: false }; }
});

// Get all pending addon submissions (admin only — DB enforces via RLS)
ipcMain.handle('get-pending-submissions', async () => {
  try {
    const { data: addons, error } = await supabase
      .from('addons')
      .select('*')
      .eq('status', 'pending')
      .order('name', { ascending: true });
    if (error) throw error;

    // Fetch submitter usernames
    const ids = [...new Set(addons.map(a => a.submitted_by).filter(Boolean))];
    const { data: profiles } = ids.length
      ? await supabase.from('profiles').select('id, username').in('id', ids)
      : { data: [] };
    const pm = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    return { success: true, data: addons.map(a => ({ ...a, submitter: pm[a.submitted_by] || null })) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Approve or reject a submission
ipcMain.handle('moderate-addon', async (_event, { addonId, status }) => {
  try {
    const { error } = await supabase
      .from('addons')
      .update({ status })
      .eq('id', addonId);
    if (error) throw error;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Log file path — shown in Settings so users can find it for debugging
ipcMain.handle('get-log-path', () => {
  try {
    const log = require('electron-log');
    return log.transports.file.getFile().path;
  } catch {
    return null;
  }
});

// Open a file's containing folder in Explorer/Finder
ipcMain.handle('show-in-folder', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// Manual update check triggered from Settings UI
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { message: 'Auto-updates only work in the installed app, not in dev mode.' };
  try {
    await autoUpdater.checkForUpdates();
    return { message: 'Checking…' };
  } catch (err) {
    return { message: `Error: ${err.message}` };
  }
});

// ==========================================
// UTILITY & MISC HANDLERS
// ==========================================

// Fetch and render README from a GitHub repository
ipcMain.handle('fetch-addon-readme', async (_event, { repositoryUrl }) => {
  try {
    if (!repositoryUrl?.includes('github.com')) return { success: false };
    const match = repositoryUrl.match(/github\.com\/([^\/\s]+)\/([^\/\s#?]+)/);
    if (!match) return { success: false };

    const [, owner, repo] = match;
    const { marked } = require('marked');

    // Try default branch candidates
    for (const branch of ['master', 'main', 'develop']) {
      try {
        const res = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`
        );
        if (!res.ok) continue;
        const text = await res.text();
        const html  = marked.parse(text);
        return { success: true, html };
      } catch {}
    }
    return { success: false, reason: 'README not found' };
  } catch (error) {
    console.error('fetch-addon-readme error:', error.message);
    return { success: false };
  }
});

// Upload an addon zip directly to Supabase Storage (50 MB limit)
const MAX_ADDON_ZIP_SIZE = 50 * 1024 * 1024; // 50 MB

ipcMain.handle('upload-addon-zip', async (_event, userId) => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Select Addon Zip File',
      properties: ['openFile'],
      filters: [{ name: 'Zip Archives', extensions: ['zip'] }]
    });

    if (result.canceled) return { canceled: true };

    const filePath = result.filePaths[0];
    const stats    = fs.statSync(filePath);

    if (stats.size > MAX_ADDON_ZIP_SIZE) {
      const mb = (stats.size / 1024 / 1024).toFixed(1);
      return { success: false, error: `File is ${mb} MB — the maximum allowed size is 50 MB.` };
    }

    const fileBuffer  = fs.readFileSync(filePath);
    const fileName    = path.basename(filePath);
    const storagePath = `${userId}/${Date.now()}-${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('addon-files')
      .upload(storagePath, fileBuffer, { contentType: 'application/zip', upsert: false });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from('addon-files').getPublicUrl(storagePath);

    return {
      success:  true,
      url:      urlData.publicUrl,
      name:     path.basename(fileName, '.zip'), // suggested addon name
      sizeMb:   (stats.size / 1024 / 1024).toFixed(2),
    };
  } catch (error) {
    console.error('upload-addon-zip error:', error.message);
    return { success: false, error: error.message };
  }
});

// Update tags on an addon (admin only — RLS enforces)
ipcMain.handle('update-addon-tags', async (_event, { addonId, tags }) => {
  try {
    const { error } = await supabase.from('addons').update({ tags }).eq('id', addonId);
    if (error) throw error;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Auto-detect common Windower installation paths
ipcMain.handle('auto-detect-windower', async () => {
  const candidates = [
    'C:\\Windower',
    'C:\\Windower4',
    path.join('C:\\', 'Program Files', 'Windower'),
    path.join('C:\\', 'Program Files (x86)', 'Windower'),
    path.join('C:\\', 'Games', 'Windower'),
    path.join(process.env.USERPROFILE || '', 'Windower'),
    path.join(process.env.USERPROFILE || '', 'Desktop', 'Windower'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.existsSync(path.join(p, 'addons'))) return { found: true, path: p };
    } catch {}
  }
  return { found: false };
});

// Get a user's public profile
ipcMain.handle('get-user-profile', async (_event, userId) => {
  try {
    const { data, error } = await supabase
      .from('profiles').select('id, username, avatar_url, bio').eq('id', userId).maybeSingle();
    if (error) throw error;
    return { success: true, data };
  } catch (error) { return { success: false }; }
});

// Get reviews written by a user (with addon name)
ipcMain.handle('get-user-reviews', async (_event, userId) => {
  try {
    const { data: reviews, error } = await supabase
      .from('reviews').select('id, rating, review_text, created_at, addon_id')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    if (!reviews?.length) return { success: true, data: [] };

    const addonIds = [...new Set(reviews.map(r => r.addon_id))];
    const { data: addons } = await supabase.from('addons').select('id, name').in('id', addonIds);
    const am = Object.fromEntries((addons || []).map(a => [a.id, a]));
    return { success: true, data: reviews.map(r => ({ ...r, addon: am[r.addon_id] || null })) };
  } catch (error) { return { success: false, data: [] }; }
});

// Update own review
ipcMain.handle('update-review', async (_event, { reviewId, rating, reviewText }) => {
  try {
    const { error } = await supabase.from('reviews')
      .update({ rating: parseInt(rating), review_text: reviewText }).eq('id', reviewId);
    if (error) throw error;
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

// Delete own review
ipcMain.handle('delete-review', async (_event, reviewId) => {
  try {
    const { error } = await supabase.from('reviews').delete().eq('id', reviewId);
    if (error) throw error;
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

// Admin: aggregate stats
ipcMain.handle('get-admin-stats', async () => {
  try {
    const [users, addons, reviews, pending, reports] = await Promise.all([
      supabase.from('profiles').select('*', { count: 'exact', head: true }),
      supabase.from('addons').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('reviews').select('*', { count: 'exact', head: true }),
      supabase.from('addons').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);
    return { success: true, users: users.count || 0, addons: addons.count || 0,
      reviews: reviews.count || 0, pending: pending.count || 0, reports: reports.count || 0 };
  } catch { return { success: false }; }
});

// Fetch pending reports with reporter profile and target content
ipcMain.handle('get-reports', async () => {
  try {
    const { data: reports, error } = await supabase
      .from('reports').select('*').eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!reports?.length) return { success: true, data: [] };

    // Reporter profiles
    const reporterIds = [...new Set(reports.map(r => r.reporter_id).filter(Boolean))];
    const { data: profiles } = reporterIds.length
      ? await supabase.from('profiles').select('id, username').in('id', reporterIds)
      : { data: [] };
    const pm = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    // Fetch target content by type
    const byType = (type) => reports.filter(r => r.target_type === type).map(r => r.target_id);
    const addonIds  = byType('addon');
    const packIds   = byType('pack');
    const reviewIds = byType('review');
    const userIds   = byType('user');

    const [addons, packs, reviews, users] = await Promise.all([
      addonIds.length  ? supabase.from('addons').select('id, name, status').in('id', addonIds)          : { data: [] },
      packIds.length   ? supabase.from('addon_packs').select('id, name, status').in('id', packIds)       : { data: [] },
      reviewIds.length ? supabase.from('reviews').select('id, review_text, rating').in('id', reviewIds)  : { data: [] },
      userIds.length   ? supabase.from('profiles').select('id, username').in('id', userIds)              : { data: [] },
    ]);

    const tm = {
      addon:  Object.fromEntries((addons.data  || []).map(x => [x.id, x])),
      pack:   Object.fromEntries((packs.data   || []).map(x => [x.id, x])),
      review: Object.fromEntries((reviews.data || []).map(x => [x.id, x])),
      user:   Object.fromEntries((users.data   || []).map(x => [x.id, x])),
    };

    return {
      success: true,
      data: reports.map(r => ({
        ...r,
        reporter: pm[r.reporter_id] || null,
        target:   tm[r.target_type]?.[r.target_id] || null,
      }))
    };
  } catch (error) {
    console.error('get-reports error:', error.message);
    return { success: false, error: error.message };
  }
});

// Resolve a report — optionally take action on the reported content
ipcMain.handle('resolve-report', async (_event, { reportId, status, action, targetType, targetId }) => {
  try {
    // Mark the report resolved
    const { error: re } = await supabase.from('reports').update({
      status, action_taken: action, resolved_at: new Date().toISOString()
    }).eq('id', reportId);
    if (re) throw re;

    // Act on the reported content
    if (action === 'hide_addon') {
      await supabase.from('addons').update({ status: 'hidden' }).eq('id', targetId);
    } else if (action === 'hide_pack') {
      await supabase.from('addon_packs').update({ status: 'hidden' }).eq('id', targetId);
    } else if (action === 'delete_review') {
      await supabase.from('reviews').delete().eq('id', targetId);
    }

    return { success: true };
  } catch (error) {
    console.error('resolve-report error:', error.message);
    return { success: false, error: error.message };
  }
});

// Submit a report
ipcMain.handle('submit-report', async (_event, { reporterId, targetType, targetId, reason }) => {
  try {
    const { error } = await supabase.from('reports')
      .insert({ reporter_id: reporterId, target_type: targetType, target_id: targetId, reason });
    if (error) throw error;
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

// ==========================================
// ADDON PACK HANDLERS
// ==========================================

ipcMain.handle('get-packs', async () => {
  try {
    const { data: packs, error } = await supabase
      .from('addon_packs').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    if (!packs?.length) return { success: true, data: [] };

    const authorIds = [...new Set(packs.map(p => p.author_id).filter(Boolean))];
    const { data: profiles } = authorIds.length
      ? await supabase.from('profiles').select('id, username, avatar_url').in('id', authorIds)
      : { data: [] };
    const pm = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    const packIds = packs.map(p => p.id);
    const { data: items } = await supabase
      .from('addon_pack_items').select('pack_id').in('pack_id', packIds);
    const countMap = {};
    (items || []).forEach(i => { countMap[i.pack_id] = (countMap[i.pack_id] || 0) + 1; });

    return { success: true, data: packs.map(p => ({
      ...p, author: pm[p.author_id] || null, addon_count: countMap[p.id] || 0,
    })) };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('get-pack-detail', async (_event, packId) => {
  try {
    const { data: pack, error } = await supabase
      .from('addon_packs').select('*').eq('id', packId).maybeSingle();
    if (error) throw error;
    if (!pack) return { success: false };

    const { data: items } = await supabase
      .from('addon_pack_items').select('id, addon_id, optional, sort_order')
      .eq('pack_id', packId).order('sort_order', { ascending: true });

    const addonIds = (items || []).map(i => i.addon_id);
    const { data: addons } = addonIds.length
      ? await supabase.from('addons')
          .select('id, name, author, description, folder_name, download_url, tags, reviews(rating)')
          .in('id', addonIds)
      : { data: [] };
    const addonMap = Object.fromEntries((addons || []).map(a => [a.id, a]));

    const { data: author } = await supabase
      .from('profiles').select('id, username, avatar_url').eq('id', pack.author_id).maybeSingle();

    return { success: true, data: {
      ...pack, author: author || null,
      items: (items || []).map(i => ({ ...i, addon: addonMap[i.addon_id] || null })).filter(i => i.addon),
    } };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('create-pack', async (_event, { name, description, tags, authorId, items }) => {
  try {
    const { data: pack, error: pe } = await supabase
      .from('addon_packs')
      .insert({ name, description, tags: tags || [], author_id: authorId, status: 'pending' })
      .select().single();
    if (pe) throw pe;

    if (items?.length) {
      const { error: ie } = await supabase.from('addon_pack_items').insert(
        items.map((item, i) => ({
          pack_id: pack.id, addon_id: item.addonId,
          optional: item.optional || false, sort_order: i,
        }))
      );
      if (ie) throw ie;
    }
    return { success: true, id: pack.id };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('delete-pack', async (_event, packId) => {
  try {
    const { error } = await supabase.from('addon_packs').delete().eq('id', packId);
    if (error) throw error;
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

// ==========================================
// FRIENDS HANDLERS
// ==========================================

// Get all friendship data for a user in one call
ipcMain.handle('get-friends-data', async (event, userId) => {
  try {
    const { data: rows, error } = await supabase
      .from('friendships')
      .select('*')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
    if (error) throw error;

    // Fetch profiles for all other parties
    const otherIds = [...new Set(rows.map(r => r.requester_id === userId ? r.addressee_id : r.requester_id))];
    const { data: profiles } = otherIds.length
      ? await supabase.from('profiles').select('id, username, avatar_url').in('id', otherIds)
      : { data: [] };
    const pm = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    const friends = [], incoming = [], outgoing = [];
    for (const r of rows) {
      const otherId = r.requester_id === userId ? r.addressee_id : r.requester_id;
      const entry = { ...r, profile: pm[otherId] || { id: otherId, username: 'Unknown', avatar_url: null } };
      if (r.status === 'accepted') friends.push(entry);
      else if (r.status === 'pending' && r.addressee_id === userId) incoming.push(entry);
      else if (r.status === 'pending' && r.requester_id === userId) outgoing.push(entry);
    }
    return { success: true, friends, incoming, outgoing };
  } catch (error) {
    console.error('get-friends-data error:', error.message);
    return { success: false, friends: [], incoming: [], outgoing: [] };
  }
});

// Send a friend request
ipcMain.handle('send-friend-request', async (event, { requesterId, addresseeId }) => {
  try {
    const { error } = await supabase
      .from('friendships')
      .insert({ requester_id: requesterId, addressee_id: addresseeId, status: 'pending' });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('send-friend-request error:', error.message);
    return { success: false, error: error.message };
  }
});

// Accept or decline a friend request
ipcMain.handle('respond-friend-request', async (event, { friendshipId, status }) => {
  try {
    const { error } = await supabase
      .from('friendships')
      .update({ status })
      .eq('id', friendshipId);
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('respond-friend-request error:', error.message);
    return { success: false, error: error.message };
  }
});

// Remove a friend or cancel/decline a request
ipcMain.handle('remove-friend', async (event, friendshipId) => {
  try {
    const { error } = await supabase
      .from('friendships')
      .delete()
      .eq('id', friendshipId);
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('remove-friend error:', error.message);
    return { success: false, error: error.message };
  }
});

// Bulk-insert addons from GitHub importer (auto-approved — verified GitHub source)
ipcMain.handle('bulk-submit-addons', async (event, addons) => {
  try {
    const withStatus = addons.map(a => ({ ...a, status: 'approved' }));
    const { error } = await supabase.from('addons').insert(withStatus);
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('bulk-submit-addons error:', error.message);
    return { success: false, error: error.message };
  }
});

// Submit a new Addon (goes to pending — requires moderation approval)
ipcMain.handle('submit-addon', async (event, { name, author, description, folder_name, download_url, repository_url, screenshots, tags, submittedBy }) => {
  try {
    const { error } = await supabase
      .from('addons')
      .insert({
        name, author, description, folder_name, download_url,
        repository_url: repository_url || null,
        screenshots:    screenshots    || [],
        tags:           tags           || [],
        status:         'pending',
        submitted_by:   submittedBy,
      });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('submit-addon error:', error.message);
    return { success: false, error: error.message };
  }
});

// Fetch Addons — includes nested review ratings so cards can show avg stars
ipcMain.handle('get-addons', async () => {
  try {
    const { data, error } = await supabase
      .from('addons')
      .select('*, reviews(rating)');
    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error("Failed to fetch addons:", error.message);
    return { success: false, error: error.message };
  }
});

// Count reviews written by a user (for profile stats)
ipcMain.handle('get-review-count', async (event, userId) => {
  try {
    const { count, error } = await supabase
      .from('reviews')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw error;
    return { success: true, count };
  } catch (error) {
    return { success: false, count: 0 };
  }
});

// Submit a Review
ipcMain.handle('submit-review', async (event, { addonId, userId, rating, reviewText }) => {
  try {
    const { error } = await supabase.from('reviews').insert({
      addon_id: addonId,
      user_id: userId,
      rating: parseInt(rating),
      review_text: reviewText
    });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error("Review error:", error.message);
    return { success: false, error: error.message };
  }
});

// Fetch User Profile
ipcMain.handle('get-profile', async (event, userId) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle(); // returns null (not an error) if the row doesn't exist yet

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error("Profile fetch error:", error.message);
    return { success: false, error: error.message };
  }
});

// Update User Profile (upsert creates the row if it doesn't exist yet)
ipcMain.handle('update-profile', async (event, { userId, username, avatar_url, bio, notes }) => {
  try {
    const { error } = await supabase
      .from('profiles')
      .upsert({ id: userId, username, avatar_url, bio, notes });

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error("Profile update error:", error.message);
    return { success: false, error: error.message };
  }
});

// Fetch Reviews for an Addon — fetches reviews then enriches with profile data
ipcMain.handle('get-reviews', async (event, addonId) => {
  try {
    // Step 1: fetch reviews
    const { data: reviews, error: reviewErr } = await supabase
      .from('reviews')
      .select('*')
      .eq('addon_id', addonId)
      .order('created_at', { ascending: false });
    if (reviewErr) throw reviewErr;
    if (!reviews.length) return { success: true, data: [] };

    // Step 2: fetch profiles for those reviewers
    const userIds = [...new Set(reviews.map(r => r.user_id))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username, avatar_url')
      .in('id', userIds);

    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));
    const data = reviews.map(r => ({ ...r, profiles: profileMap[r.user_id] || null }));

    return { success: true, data };
  } catch (error) {
    console.error("Get reviews error:", error.message);
    return { success: false, error: error.message };
  }
});

// Upload Avatar to Supabase Storage
ipcMain.handle('upload-avatar', async (event, userId) => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
    });

    if (result.canceled) return { canceled: true };

    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).substring(1).toLowerCase();
    const fileBuffer = fs.readFileSync(filePath);
    const storagePath = `${userId}/avatar.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(storagePath, fileBuffer, {
        contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        upsert: true
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from('avatars')
      .getPublicUrl(storagePath);

    return { success: true, url: `${urlData.publicUrl}?t=${Date.now()}` };
  } catch (error) {
    console.error("Avatar upload error:", error.message);
    return { success: false, error: error.message };
  }
});

// Get Conversations for a user (grouped by partner, most recent first)
ipcMain.handle('get-conversations', async (event, userId) => {
  try {
    // Step 1: fetch messages
    const { data: messages, error } = await supabase
      .from('messages')
      .select('id, content, created_at, read, sender_id, receiver_id')
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    // Step 2: fetch profiles for all conversation partners
    const partnerIds = [...new Set(
      messages.map(m => m.sender_id === userId ? m.receiver_id : m.sender_id)
    )];
    const { data: profiles } = partnerIds.length
      ? await supabase.from('profiles').select('id, username, avatar_url').in('id', partnerIds)
      : { data: [] };
    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    // Step 3: group into conversations
    const convMap = new Map();
    for (const msg of messages) {
      const partnerId = msg.sender_id === userId ? msg.receiver_id : msg.sender_id;
      const partner   = profileMap[partnerId] || { id: partnerId, username: 'Unknown', avatar_url: null };
      if (!convMap.has(partnerId)) {
        convMap.set(partnerId, { partnerId, partner, lastMessage: msg, unreadCount: 0 });
      }
      if (msg.sender_id === partnerId && !msg.read) {
        convMap.get(partnerId).unreadCount++;
      }
    }

    return { success: true, data: Array.from(convMap.values()) };
  } catch (error) {
    console.error('get-conversations error:', error.message);
    return { success: false, error: error.message };
  }
});

// Get Messages between two users (decrypt content before returning)
ipcMain.handle('get-messages', async (event, { userId, partnerId }) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, content, created_at, read, sender_id')
      .in('sender_id',   [userId, partnerId])
      .in('receiver_id', [userId, partnerId])
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Attempt to get the conversation key for decryption
    let aesKey = null;
    try { aesKey = await getOrCreateConvKey(userId, partnerId); } catch {}

    const decrypted = data.map(msg => {
      if (msg.content.startsWith('enc:') && aesKey) {
        try {
          return { ...msg, content: aesDecrypt(aesKey, msg.content.slice(4)) };
        } catch {
          return { ...msg, content: '[Could not decrypt — key mismatch]' };
        }
      }
      return msg; // legacy plaintext messages shown as-is
    });

    return { success: true, data: decrypted };
  } catch (error) {
    console.error('get-messages error:', error.message);
    return { success: false, error: error.message };
  }
});

// Ensure user has an RSA keypair — generate locally if missing, sync public key to DB
ipcMain.handle('ensure-keypair', async (event, userId) => {
  try {
    let keys = loadLocalKeys(userId);
    if (!keys) {
      keys = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding:  { type: 'spki',   format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8',  format: 'pem' },
      });
      saveLocalKeys(userId, keys);
    }
    // Always push the public key to the profile (idempotent)
    const { error } = await supabase
      .from('profiles')
      .upsert({ id: userId, public_key: keys.publicKey });
    if (error) console.error('Failed to save public key:', error.message);
    return { success: true };
  } catch (error) {
    console.error('ensure-keypair error:', error.message);
    return { success: false, error: error.message };
  }
});

// Send a Message (content encrypted with AES-256-GCM before storage)
ipcMain.handle('send-message', async (event, { senderId, receiverId, content }) => {
  try {
    const aesKey    = await getOrCreateConvKey(senderId, receiverId);
    const encrypted = 'enc:' + aesEncrypt(aesKey, content);
    const { error } = await supabase
      .from('messages')
      .insert({ sender_id: senderId, receiver_id: receiverId, content: encrypted });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('send-message error:', error.message);
    return { success: false, error: error.message };
  }
});

// Search Users by username (for starting new conversations)
ipcMain.handle('search-users', async (event, { query, currentUserId }) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, avatar_url')
      .ilike('username', `%${query}%`)
      .neq('id', currentUserId)
      .limit(10);
    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('search-users error:', error.message);
    return { success: false, error: error.message };
  }
});

// Mark messages from a partner as read
ipcMain.handle('mark-read', async (event, { userId, partnerId }) => {
  try {
    const { error } = await supabase
      .from('messages')
      .update({ read: true })
      .eq('receiver_id', userId)
      .eq('sender_id', partnerId)
      .eq('read', false);
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('mark-read error:', error.message);
    return { success: false, error: error.message };
  }
});

// Restore session on app restart
ipcMain.handle('get-session', async () => {
  try {
    const saved = loadSession();
    if (!saved) return { success: false };

    const { data, error } = await supabase.auth.setSession({
      access_token:  saved.access_token,
      refresh_token: saved.refresh_token
    });

    if (error || !data.session) { clearSession(); return { success: false }; }

    // Persist the refreshed tokens
    saveSession(data.session);
    return { success: true, email: data.user.email, id: data.user.id };
  } catch (error) {
    clearSession();
    return { success: false };
  }
});

// Log out the user
ipcMain.handle('logout-user', async () => {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    clearSession();
    return { success: true };
  } catch (error) {
    console.error("Logout error:", error.message);
    return { success: false, error: error.message };
  }
});