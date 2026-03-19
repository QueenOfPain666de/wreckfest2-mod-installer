const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const os = require('os');

const PORT = 7666;

function findSteamPaths() {
  const home = os.homedir();
  const platform = os.platform();
  const candidates = [];
  if (platform === 'linux') {
    candidates.push(
      path.join(home, '.steam/steam/steamapps/common'),
      path.join(home, '.local/share/Steam/steamapps/common'),
      '/mnt/games/SteamLibrary/steamapps/common',
    );
  } else if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files (x86)\\Steam\\steamapps\\common',
      'C:\\Program Files\\Steam\\steamapps\\common',
      'D:\\Steam\\steamapps\\common',
      'D:\\SteamLibrary\\steamapps\\common',
      'E:\\SteamLibrary\\steamapps\\common',
    );
  } else if (platform === 'darwin') {
    candidates.push(path.join(home, 'Library/Application Support/Steam/steamapps/common'));
  }
  return candidates.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
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
      const clean = e.replace(/\/$/, '');
      if (!e.endsWith('/')) files.push(e);
      const top = e.split('/')[0];
      if (top) topDirs.add(top);
    });
    return { dirs: Array.from(topDirs).slice(0, 20), files: files.slice(0, 80), total: entries.length };
  } catch (e) {
    return { error: e.message, dirs: [], files: [], total: 0 };
  }
}

function extractZip(zipPath, destDir, callback) {
  fs.mkdirSync(destDir, { recursive: true });
  const cmd = process.platform === 'win32'
    ? `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`
    : `unzip -o "${zipPath}" -d "${destDir}"`;
  exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => callback(err, stdout, stderr));
}

const server = http.createServer((req, res) => {
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
    const contents = listZipContents(zipPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(contents));
    return;
  }

  if (url.pathname === '/api/install' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { zipPath, destBase } = JSON.parse(body);
        const destDir = path.join(destBase, 'Wreckfest 2', 'data');
        extractZip(zipPath, destDir, (err, stdout) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, modName: path.basename(zipPath, '.zip'), destDir }));
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

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  WRECKFEST 2 MOD INSTALLER`);
  console.log(`  Backend → http://127.0.0.1:${PORT}`);
  console.log(`  Ziel:     steamapps/common/Wreckfest 2/data/\n`);
});
