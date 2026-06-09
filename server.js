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
const activeStreams = new Map();

function sendStatus(buildId, message, progress = null) {
    const res = activeStreams.get(buildId);
    if (res) {
        res.write(`data: ${JSON.stringify({ message, progress })}\n\n`);
    }
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
    const srcDir = path.join(workspaceDir, 'src');
    const outputDir = path.join(workspaceDir, 'dist');
    const tempZipPath = path.join(__dirname, 'uploads', `${buildId}.zip`);
    const finalZipPath = path.join(__dirname, 'uploads', `final_${buildId}.zip`);
    
    fs.ensureDirSync(path.dirname(tempZipPath));
    fs.ensureDirSync(srcDir);

    let writeStream;

    req.pipe(bb);

    bb.on('file', (name, file) => {
        writeStream = fs.createWriteStream(tempZipPath);
        file.pipe(writeStream);
    });

    bb.on('finish', () => {
        // CRITICAL FIX: Wait for the file stream to fully finish flushing to disk before unzipping
        if (!writeStream) {
            return res.status(400).send('No file uploaded.');
        }

        writeStream.on('finish', async () => {
            try {
                sendStatus(buildId, "Upload flushed to disk safely. Extracting project...", 15);
                
                if (!fs.existsSync(tempZipPath) || fs.statSync(tempZipPath).size === 0) {
                    throw new Error("Uploaded zip file is empty or missing from disk.");
                }

                const zip = new AdmZip(tempZipPath);
                zip.extractAllTo(srcDir, true);

                const userPackageJsonPath = path.join(srcDir, 'package.json');
                if (!fs.existsSync(userPackageJsonPath)) {
                    sendStatus(buildId, "Error: package.json missing from root.");
                    return res.status(400).send('Error: package.json missing.');
                }

                const userPackageJson = fs.readJsonSync(userPackageJsonPath);
                userPackageJson.dependencies = userPackageJson.dependencies || {};

                // FIX: Strip Electron module completely out of npm install to save RAM
                if (userPackageJson.dependencies.electron) delete userPackageJson.dependencies.electron;
                if (userPackageJson.devDependencies?.electron) delete userPackageJson.devDependencies.electron;
                fs.writeJsonSync(userPackageJsonPath, userPackageJson, { spaces: 2 });

                sendStatus(buildId, "Running lightweight npm install...", 40);
                // --no-audit and --no-fund save massive amounts of temporary container RAM
                execSync('npm install --production --no-audit --no-fund', { cwd: srcDir, stdio: 'ignore' });

                sendStatus(buildId, "Compiling native Windows binary (.exe)...", 65);
                
                const appPaths = await packager({
                    dir: srcDir,
                    out: outputDir,
                    name: userPackageJson.name || 'ElectronApp',
                    platform: 'win32',
                    arch: 'x64',
                    overwrite: true,
                    asar: true,
                    electronVersion: '30.0.0',
                    prune: false // Keeps our light node_modules intact smoothly
                });

                sendStatus(buildId, "Archiving build directly to file system...", 85);
                
                // FIX: Write zip directly to file system instead of creating huge memory buffers
                const clientZip = new AdmZip();
                clientZip.addLocalFolder(appPaths[0]);
                clientZip.writeZip(finalZipPath);

                // Track download info via file path references instead of caching heavy array buffers in RAM
                activeBuilds.set(buildId, {
                    filePath: finalZipPath,
                    name: `${userPackageJson.name || 'windows-app'}-win32-x64.zip`
                });

                sendStatus(buildId, "Ready for download!", 100);
                res.json({ buildId, totalBytes: fs.statSync(finalZipPath).size });

            } catch (error) {
                console.error(error);
                sendStatus(buildId, `Compilation Failed: ${error.message}`, 0);
                if (!res.headersSent) res.status(500).send(`Compilation Error: ${error.message}`);
            } finally {
                // Clean up source folders safely
                fs.remove(workspaceDir).catch(() => {});
                fs.remove(tempZipPath).catch(() => {});
            }
        });
    });
});

// Stream from File System using fast native Range streams instead of memory slices
app.get('/download/:buildId', (req, res) => {
    const build = activeBuilds.get(req.params.buildId);
    if (!build || !fs.existsSync(build.filePath)) return res.status(404).send('Build not found.');

    const totalSize = fs.statSync(build.filePath).size;
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${build.name}"`);

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        const chunksize = (end - start) + 1;

        res.status(206).set({
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': chunksize,
        });

        // High-speed file system stream mapping
        const fileStream = fs.createReadStream(build.filePath, { start, end });
        fileStream.pipe(res);
    } else {
        res.set('Content-Length', totalSize);
        fs.createReadStream(build.filePath).pipe(res);
    }
});

app.delete('/download/:buildId', (req, res) => {
    const build = activeBuilds.get(req.params.buildId);
    if (build) {
        fs.remove(build.filePath).catch(() => {});
        activeBuilds.delete(req.params.buildId);
    }
    res.sendStatus(200);
});

app.listen(3000, () => console.log('Server running on port 3000'));
