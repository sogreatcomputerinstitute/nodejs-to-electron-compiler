const express = require('express');
const busboy = require('busboy');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');
const compression = require('compression');
const { downloadArtifact } = require('@electron/get'); // Official Binary Downloader

const app = express();
app.use(compression());
app.use(express.static('public'));

const activeBuilds = new Map();
const activeStreams = new Map();

function sendStatus(buildId, message, progress = null) {
    const res = activeStreams.get(buildId);
    if (res) res.write(`data: ${JSON.stringify({ message, progress })}\n\n`);
}

// Function to fetch the official Windows Electron distribution directly
async function getBaseElectronZip(buildId) {
    const cacheDir = path.join(__dirname, 'cache');
    await fs.ensureDir(cacheDir);

    sendStatus(buildId, "Fetching official Windows Electron binaries directly from source...", 30);
    
    // Downloads electron-v30.0.0-win32-x64.zip directly from GitHub releases safely
    const zipFilePath = await downloadArtifact({
        version: '30.0.0',
        platform: 'win32',
        arch: 'x64',
        artifactName: 'electron',
        cacheRoot: cacheDir
    });

    return zipFilePath;
}

app.get('/status/:buildId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    activeStreams.set(req.params.buildId, res);
    req.on('close', () => activeStreams.delete(req.params.buildId));
});

app.post('/compile', (req, res) => {
    const bb = busboy({ headers: req.headers });
    const buildId = `build_${Date.now()}`;
    const workspaceDir = path.join(__dirname, 'workspaces', buildId);
    const appDir = path.join(workspaceDir, 'resources', 'app'); 
    const tempZipPath = path.join(__dirname, 'uploads', `${buildId}.zip`);
    const finalZipPath = path.join(__dirname, 'uploads', `final_${buildId}.zip`);
    
    fs.ensureDirSync(path.dirname(tempZipPath));
    fs.ensureDirSync(appDir);

    let writeStream;
    req.pipe(bb);
    bb.on('file', (name, file) => {
        writeStream = fs.createWriteStream(tempZipPath);
        file.pipe(writeStream);
    });

    bb.on('finish', () => {
        if (!writeStream) return res.status(400).send('No file uploaded.');

        writeStream.on('finish', async () => {
            try {
                // 1. Fetch base package directly via function call
                const baseElectronZipPath = await getBaseElectronZip(buildId);
                
                sendStatus(buildId, "Extracting clean Windows architecture framework...", 55);
                const baseZip = new AdmZip(baseElectronZipPath);
                baseZip.extractAllTo(workspaceDir, true);

                sendStatus(buildId, "Injecting your source code into executable runtime...", 75);
                const userZip = new AdmZip(tempZipPath);
                userZip.extractAllTo(appDir, true);

                // 2. Handle metadata fallback configurations
                const userPackageJsonPath = path.join(appDir, 'package.json');
                if (!fs.existsSync(userPackageJsonPath)) {
                    fs.writeJsonSync(userPackageJsonPath, { name: "electron-app", version: "1.0.0", main: "main.js" });
                }

                sendStatus(buildId, "Compressing delivery archive...", 90);
                const finalZip = new AdmZip();
                finalZip.addLocalFolder(workspaceDir);
                finalZip.writeZip(finalZipPath);

                activeBuilds.set(buildId, {
                    filePath: finalZipPath,
                    name: `electron-packaged-app.zip`
                });

                sendStatus(buildId, "Ready for download!", 100);
                res.json({ buildId, totalBytes: fs.statSync(finalZipPath).size });

            } catch (error) {
                console.error(error);
                sendStatus(buildId, `Process Error: ${error.message}`, 0);
                if (!res.headersSent) res.status(500).send(error.message);
            } finally {
                fs.remove(workspaceDir).catch(() => {});
                fs.remove(tempZipPath).catch(() => {});
            }
        });
    });
});

// Parallel Download Channels
app.get('/download/:buildId', (req, res) => {
    const build = activeBuilds.get(req.params.buildId);
    if (!build || !fs.existsSync(build.filePath)) return res.status(404).send('Not found.');
    const totalSize = fs.statSync(build.filePath).size;
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${build.name}"`);

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${totalSize}`, 'Content-Length': (end - start) + 1 });
        fs.createReadStream(build.filePath, { start, end }).pipe(res);
    } else {
        res.set('Content-Length', totalSize);
        fs.createReadStream(build.filePath).pipe(res);
    }
});

app.delete('/download/:buildId', (req, res) => {
    const build = activeBuilds.get(req.params.buildId);
    if (build) { fs.remove(build.filePath).catch(() => {}); activeBuilds.delete(req.params.buildId); }
    res.sendStatus(200);
});

app.listen(3000, () => console.log('Server stabilized with @electron/get on port 3000'));
