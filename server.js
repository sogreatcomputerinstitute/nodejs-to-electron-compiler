const express = require('express');
const busboy = require('busboy');
const { packager } = require('@electron/packager');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');
const { execSync } = require('child_process');
const compression = require('compression');

const app = express();

app.use(compression());
app.use(express.static('public'));

const activeBuilds = new Map();
// Keep track of active log streams for users
const activeStreams = new Map();

// Helper to push status updates to the frontend
function sendStatus(buildId, message, progress = null) {
    const res = activeStreams.get(buildId);
    if (res) {
        res.write(`data: ${JSON.stringify({ message, progress })}\n\n`);
    }
}

// SSE Endpoint for Live Logs
app.get('/status/:buildId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    activeStreams.set(req.params.buildId, res);

    req.on('close', () => {
        activeStreams.delete(req.params.buildId);
    });
});

app.post('/compile', (req, res) => {
    const bb = busboy({ headers: req.headers });
    const buildId = `build_${Date.now()}`;
    const workspaceDir = path.join(__dirname, 'workspaces', buildId);
    const srcDir = path.join(workspaceDir, 'src');
    const outputDir = path.join(workspaceDir, 'dist');
    let tempZipPath = path.join(__dirname, 'uploads', `${buildId}.zip`);
    
    fs.ensureDirSync(path.dirname(tempZipPath));
    fs.ensureDirSync(srcDir);

    req.pipe(bb);

    bb.on('file', (name, file) => {
        const fstream = fs.createWriteStream(tempZipPath);
        file.pipe(fstream);
    });

    bb.on('finish', async () => {
        try {
            // Let the frontend know upload is done and parsing is starting
            sendStatus(buildId, "Upload finished! Extracting project workspace...", 10);
            
            const zip = new AdmZip(tempZipPath);
            zip.extractAllTo(srcDir, true);

            const userPackageJsonPath = path.join(srcDir, 'package.json');
            if (!fs.existsSync(userPackageJsonPath)) {
                sendStatus(buildId, "Error: package.json missing from root.");
                return res.status(400).send('Error: package.json missing.');
            }

            const userPackageJson = fs.readJsonSync(userPackageJsonPath);

            sendStatus(buildId, `Parsing package.json for dependencies...`, 25);
            
            if (!userPackageJson.dependencies || !userPackageJson.dependencies.electron) {
                userPackageJson.dependencies = userPackageJson.dependencies || {};
                userPackageJson.dependencies['electron'] = '^30.0.0';
                fs.writeJsonSync(userPackageJsonPath, userPackageJson, { spaces: 2 });
            }

            sendStatus(buildId, "Running 'npm install' for production node_modules...", 40);
            execSync('npm install --production', { cwd: srcDir, stdio: 'ignore' });

            sendStatus(buildId, "Compiling native Windows binary (.exe)...", 65);
            
            // FIX: Explicitly pass electronVersion here to stop the 'electron/package.json' search error
            const appPaths = await packager({
                dir: srcDir,
                out: outputDir,
                name: userPackageJson.name || 'ElectronApp',
                platform: 'win32',
                arch: 'x64',
                overwrite: true,
                asar: true,
                electronVersion: '30.0.0' // <-- Explicit hardcoded fallback version fixed the error
            });

            sendStatus(buildId, "Compilation complete. Archiving distribution folder...", 85);
            const clientZip = new AdmZip();
            clientZip.addLocalFolder(appPaths[0]);
            const finalZipBuffer = clientZip.toBuffer(); 

            activeBuilds.set(buildId, {
                buffer: finalZipBuffer,
                name: `${userPackageJson.name || 'windows-app'}-win32-x64.zip`
            });

            sendStatus(buildId, "Ready for download!", 100);
            res.json({ buildId, totalBytes: finalZipBuffer.length });

        } catch (error) {
            console.error(error);
            sendStatus(buildId, `Compilation Failed: ${error.message}`, 0);
            res.status(500).send(`Compilation Error: ${error.message}`);
        } finally {
            fs.remove(workspaceDir).catch(() => {});
            fs.remove(tempZipPath).catch(() => {});
        }
    });
});

// Download & Cleanup endpoints remain unchanged
app.get('/download/:buildId', (req, res) => {
    const build = activeBuilds.get(req.params.buildId);
    if (!build) return res.status(404).send('Build expired or not found.');

    const totalSize = build.buffer.length;
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${build.name}"`);

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        const chunksize = (end - start) + 1;
        const slicedBuffer = build.buffer.subarray(start, end + 1);

        res.status(206).set({
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': chunksize,
        });
        res.end(slicedBuffer);
    } else {
        res.set('Content-Length', totalSize);
        res.end(build.buffer);
    }
});

app.delete('/download/:buildId', (req, res) => {
    activeBuilds.delete(req.params.buildId);
    res.sendStatus(200);
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));
