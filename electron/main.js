// Desktop app shell (Windows / macOS / Linux).
// Loads the same UI from disk. Web security is relaxed inside this window only, so the player can
// read playlists and streams from any IPTV server directly (no local proxy needed).
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');

const UA = 'VLC/3.0.20 LibVLC/3.0.20';

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: '#0b0f17',
    autoHideMenuBar: true,
    title: 'Faza IPTV',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      webSecurity: false, // allow cross-origin playlists/streams (this window only loads our own files)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
  // Links open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
}

app.whenReady().then(() => {
  // Many IPTV providers only answer media-player user agents.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    details.requestHeaders['User-Agent'] = UA;
    delete details.requestHeaders.Origin;
    cb({ requestHeaders: details.requestHeaders });
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
