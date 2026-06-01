// In development .env is loaded; in a packaged build config.js is used.
try { require('dotenv').config(); } catch {}

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { autoUpdater } = require('electron-updater');
const { createClient } = require('@supabase/supabase-js');

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
function createWindow() {
  const win = new BrowserWindow({
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

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  // Initialize the auto-updater
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-available', () => {
    console.log('A new version of the manager is available. Downloading...');
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('Update downloaded. It will be installed on restart.');
  });

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

// Select Folder with validation
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  
  if (result.canceled) return null;
  
  const folderPath = result.filePaths[0];
  
  // Validation check
  if (!fs.existsSync(path.join(folderPath, 'addons'))) {
    return { error: 'Invalid directory. Could not find the "addons" folder inside this path.' };
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
    return { success: false, error: error.message };
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

// Bulk-insert addons (used by the GitHub importer)
ipcMain.handle('bulk-submit-addons', async (event, addons) => {
  try {
    const { error } = await supabase.from('addons').insert(addons);
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('bulk-submit-addons error:', error.message);
    return { success: false, error: error.message };
  }
});

// Submit a new Addon
ipcMain.handle('submit-addon', async (event, { name, author, description, folder_name, download_url }) => {
  try {
    const { error } = await supabase
      .from('addons')
      .insert({ name, author, description, folder_name, download_url });
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

// Get Messages between two users
ipcMain.handle('get-messages', async (event, { userId, partnerId }) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, content, created_at, read, sender_id')
      .in('sender_id',   [userId, partnerId])
      .in('receiver_id', [userId, partnerId])
      .order('created_at', { ascending: true });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('get-messages error:', error.message);
    return { success: false, error: error.message };
  }
});

// Send a Message
ipcMain.handle('send-message', async (event, { senderId, receiverId, content }) => {
  try {
    const { error } = await supabase
      .from('messages')
      .insert({ sender_id: senderId, receiver_id: receiverId, content });
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