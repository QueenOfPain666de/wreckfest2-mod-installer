const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const os = require('os');

// ── BACKEND ──────────────────────────────────────────────────────────────────

const PORT = 7666;

// Parse Steam's libraryfolders.vdf to find all library paths
function parseSteamVdf(vdfPath) {
  const paths = [];
  try {
    const content = fs.readFileSync(vdfPath, 'utf8');
    // Match "path" entries in the VDF
    const re = /"path"\s+"([^"]+)"/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
      const p = path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common');
      if (fs.existsSync(p)) paths.push(p);
    }
  } catch {}
  return paths;
}

// Read Steam install path from Windows Registry
function getSteamPathFromRegistry() {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath 2>nul',
      { encoding: 'utf8' }
    );
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) return m[1].trim().replace(/\//g, '\\');
  } catch {}
  return null;
}

function findSteamPaths() {
  const home = os.homedir();
  const platform = os.platform();
  const found = new Set();

  const addCommon = p => {
    try { if (fs.existsSync(p)) found.add(p); } catch {}
  };

  if (platform === 'win32') {
    // 1. Registry — most reliable on Windows
    const regSteam = getSteamPathFromRegistry();
    if (regSteam) {
      const vdf = path.join(regSteam, 'steamapps', 'libraryfolders.vdf');
      parseSteamVdf(vdf).forEach(p => found.add(p));
      addCommon(path.join(regSteam, 'steamapps', 'common'));
    }

    // 2. Common default locations + all drive letters A-Z
    const drives = [];
    for (let c = 67; c <= 90; c++) drives.push(String.fromCharCode(c)); // C-Z
    const suffixes = [
      '\\Program Files (x86)\\Steam\\steamapps\\common',
      '\\Program Files\\Steam\\steamapps\\common',
      '\\Steam\\steamapps\\common',
      '\\SteamLibrary\\steamapps\\common',
      '\\Games\\Steam\\steamapps\\common',
      '\\Games\\SteamLibrary\\steamapps\\common',
    ];
    drives.forEach(d => suffixes.forEach(s => addCommon(d + ':' + s)));

    // 3. VDF from common Steam locations
    const vdfLocations = [
      'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf',
      'C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf',
    ];
    vdfLocations.forEach(v => parseSteamVdf(v).forEach(p => found.add(p)));

  } else if (platform === 'linux') {
    const vdfPaths = [
      path.join(home, '.steam/steam/steamapps/libraryfolders.vdf'),
      path.join(home, '.local/share/Steam/steamapps/libraryfolders.vdf'),
    ];
    vdfPaths.forEach(v => parseSteamVdf(v).forEach(p => found.add(p)));
    addCommon(path.join(home, '.steam/steam/steamapps/common'));
    addCommon(path.join(home, '.local/share/Steam/steamapps/common'));

  } else if (platform === 'darwin') {
    addCommon(path.join(home, 'Library/Application Support/Steam/steamapps/common'));
  }

  // Filter: only return paths where Wreckfest 2 actually exists
  const all = Array.from(found);
  const withWF2 = all.filter(p => fs.existsSync(path.join(p, 'Wreckfest 2')));
  // Return WF2 paths first, then all other Steam library paths
  return [...new Set([...withWF2, ...all])];
}

function listZipContents(zipPath) {
  try {
    let out;
    if (process.platform === 'win32') {
      out = execSync(
        `powershell -command "Add-Type -Assembly System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${zipPath}').Entries | ForEach-Object { $_.FullName }"`,
        { encoding: 'utf8' }
      );
    } else {
      out = execSync(`unzip -l "${zipPath}" | tail -n +4 | head -n -2 | awk '{print $NF}'`, { encoding: 'utf8' });
    }
    const entries = out.split('\n').map(l => l.trim()).filter(l => l && l !== 'Name' && l !== '----');
    const topDirs = new Set();
    const files = [];
    entries.forEach(e => {
      if (!e.endsWith('/')) files.push(e);
      const top = e.split('/')[0];
      if (top) topDirs.add(top);
    });
    return { dirs: Array.from(topDirs).slice(0, 20), files: files.slice(0, 80), total: entries.length };
  } catch (e) {
    return { error: e.message, dirs: [], files: [], total: 0 };
  }
}

// Extract ZIP into destDir.
// Finds the "data/" segment anywhere in the path and strips everything before+including it.
// e.g. Sandford/data/art/foo.dds → art/foo.dds → destDir/art/foo.dds
function extractZip(zipPath, destDir, overwriteAll, callback) {
  fs.mkdirSync(destDir, { recursive: true });

  const tmpScript = path.join(os.tmpdir(), `wf2x_${Date.now()}.ps1`);
  const overwriteFlag = overwriteAll ? '$true' : '$false';

  const script = `
Add-Type -Assembly System.IO.Compression.FileSystem
$zip     = [System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(zipPath)})
$dest    = ${JSON.stringify(destDir)}
$owAll   = ${overwriteFlag}
$copied  = 0; $skipped = 0; $overwritten = 0; $conflicts = @()

foreach ($entry in $zip.Entries) {
  # skip directory entries
  if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\\')) { continue }

  # normalise to backslashes
  $rel = $entry.FullName -replace '/', '\\'

  # Find "data\" anywhere in path and take everything after it
  $idx = $rel.ToLower().IndexOf('data\')
  if ($idx -lt 0) { continue }  # no data\ found, skip
  $rel = $rel.Substring($idx + 5)  # 5 = length of "data\"
  if ($rel -eq '') { continue }  # was just the data folder itself

  $out = Join-Path $dest $rel
  $dir = Split-Path $out -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  if (Test-Path $out) {
    if ($owAll) {
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $out, $true)
      $overwritten++
    } else {
      $conflicts += $rel
      $skipped++
    }
  } else {
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $out, $false)
    $copied++
  }
}
$zip.Dispose()

Write-Host "RESULT:copied=$copied,skipped=$skipped,overwritten=$overwritten"
if ($conflicts.Count -gt 0) {
  Write-Host "CONFLICTS:$($conflicts -join '|')"
}
`.trimStart();

  fs.writeFileSync(tmpScript, script, 'utf8');

  exec(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`,
    { maxBuffer: 100 * 1024 * 1024 },
    (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) { callback(err, null); return; }

      const resultLine = (stdout.match(/RESULT:(.+)/) || [])[1] || '';
      const conflictLine = (stdout.match(/CONFLICTS:(.+)/) || [])[1] || '';
      const result = {};
      resultLine.split(',').forEach(p => {
        const [k, v] = p.split('=');
        if (k) result[k] = parseInt(v) || 0;
      });
      result.conflicts = conflictLine ? conflictLine.split('|').filter(Boolean) : [];
      callback(null, result);
    }
  );
}

let backendServer = null;

function startBackend() {
  backendServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/steam-paths') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paths: findSteamPaths() }));
      return;
    }

    if (url.pathname === '/api/list-zips') {
      const dir = url.searchParams.get('dir') || path.join(os.homedir(), 'Downloads');
      try {
        const files = fs.readdirSync(dir)
          .filter(f => f.toLowerCase().endsWith('.zip'))
          .map(f => {
            const fp = path.join(dir, f);
            const stat = fs.statSync(fp);
            return { name: f, path: fp, size: stat.size, mtime: stat.mtime };
          })
          .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files, dir }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/api/zip-preview') {
      const zipPath = url.searchParams.get('path');
      if (!zipPath || !fs.existsSync(zipPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ZIP nicht gefunden: ' + zipPath }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listZipContents(zipPath)));
      return;
    }

    if (url.pathname === '/api/install' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { zipPath, destBase, overwriteAll = false } = JSON.parse(body);
          const destDir = path.join(destBase, 'Wreckfest 2', 'data');
          extractZip(zipPath, destDir, overwriteAll, (err, result) => {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            } else if (!overwriteAll && result.conflicts && result.conflicts.length > 0) {
              // Conflicts found — ask frontend what to do
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                needsConfirm: true,
                conflicts: result.conflicts,
                copied: result.copied,
                modName: path.basename(zipPath, '.zip'),
                destDir
              }));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                modName: path.basename(zipPath, '.zip'),
                destDir,
                copied: result.copied,
                overwritten: result.overwritten,
                skipped: result.skipped
              }));
            }
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (url.pathname === '/api/check-dest') {
      const dir = url.searchParams.get('dir');
      const exists = !!(dir && fs.existsSync(dir));
      const wf2 = !!(dir && fs.existsSync(path.join(dir, 'Wreckfest 2')));
      const dataFound = !!(dir && fs.existsSync(path.join(dir, 'Wreckfest 2', 'data')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exists, wreckfest2Found: wf2, dataFound }));
      return;
    }

    // Serve static files (bg.jpg, mp3, index.html)
    const staticMap = {
      '/': 'index.html',
      '/index.html': 'index.html',
      '/bg.jpg': 'bg.jpg',
      '/Midnight_Highway_Circuit.mp3': 'Midnight_Highway_Circuit.mp3',
    };
    const staticFile = staticMap[url.pathname];
    if (staticFile) {
      const filePath = path.join(__dirname, staticFile);
      const mimeTypes = { '.html': 'text/html', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };
      const ext = path.extname(filePath);
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(data);
      } catch (e) {
        res.writeHead(404); res.end('Not found');
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  backendServer.listen(PORT, '127.0.0.1', () => {
    console.log(`Backend running on http://127.0.0.1:${PORT}`);
  });
}

// ── ELECTRON WINDOW ──────────────────────────────────────────────────────────

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1280,
    minHeight: 820,
    maxWidth: 1280,
    maxHeight: 820,
    resizable: false,
    title: 'WRECKFEST 2 — MOD INSTALLER',
    backgroundColor: '#02000a',
    icon: path.join(__dirname, 'icon.png'),
    frame: false,           // frameless — we use custom titlebar
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load from our embedded backend so relative paths (bg.jpg, mp3) work
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);

  // Inject custom titlebar + window controls after load
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        const bar = document.createElement('div');
        bar.id = '_titlebar';
        bar.style.cssText = [
          'position:fixed','top:0','left:0','right:0','height:32px','z-index:9999',
          'display:flex','align-items:center','justify-content:space-between',
          'background:rgba(2,0,14,0.92)','border-bottom:1px solid rgba(0,220,255,0.18)',
          '-webkit-app-region:drag','padding:0 12px','user-select:none',
        ].join(';');
        bar.innerHTML = \`
          <span style="font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:3px;color:rgba(0,238,255,0.6)">
            WRECKFEST 2 // MOD INSTALLER
          </span>
          <div style="-webkit-app-region:no-drag;display:flex;gap:6px">
            <button onclick="window._ipc.minimize()" style="background:rgba(0,200,255,0.08);border:1px solid rgba(0,200,255,0.25);color:#00eeff;width:28px;height:20px;border-radius:2px;cursor:pointer;font-size:12px;line-height:1">─</button>
            <button onclick="window._ipc.maximize()" style="background:rgba(0,200,255,0.08);border:1px solid rgba(0,200,255,0.25);color:#00eeff;width:28px;height:20px;border-radius:2px;cursor:pointer;font-size:12px;line-height:1">□</button>
            <button onclick="window._ipc.close()" style="background:rgba(255,0,100,0.1);border:1px solid rgba(255,0,100,0.3);color:#ff0088;width:28px;height:20px;border-radius:2px;cursor:pointer;font-size:12px;line-height:1">✕</button>
          </div>
        \`;
        document.body.prepend(bar);
        // push app content down
        const app = document.getElementById('app');
        if (app) app.style.paddingTop = '32px';
      })();
    `);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// IPC handlers for window controls
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize', () => mainWindow && (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()));
ipcMain.on('win-close', () => mainWindow && mainWindow.close());

// IPC handler for native folder picker
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Wreckfest 2 Ordner wählen (steamapps/common)',
    properties: ['openDirectory'],
    buttonLabel: 'Auswählen',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

app.whenReady().then(() => {
  startBackend();
  // Small delay so backend is ready before window loads
  setTimeout(createWindow, 150);
});

app.on('window-all-closed', () => {
  if (backendServer) backendServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
