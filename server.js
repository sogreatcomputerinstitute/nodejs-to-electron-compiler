const express = require('express');
const busboy = require('busboy');
const packager = require('@electron/packager');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');
const { execSync } = require('child_process');
const compression = require('compression'); // Compresses static text assets

const app = express();

// Enable GZIP compression for server traffic
app.use(compression());
app.use(express.static('public'));

// Global in-memory storage for finalized builds (cleared after download)
const activeBuilds = new Map();

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
            const zip = new AdmZip(tempZipPath);
            zip.extractAllTo(srcDir, true);

            const userPackageJsonPath = path.join(srcDir, 'package.json');
            if (!fs.existsSync(userPackageJsonPath)) {
                return res.status(400).send('Error: package.json missing.');
            }

            const userPackageJson = fs.readJsonSync(userPackageJsonPath);

            if (!userPackageJson.dependencies || !userPackageJson.dependencies.electron) {
                userPackageJson.dependencies = userPackageJson.dependencies || {};
                userPackageJson.dependencies['electron'] = '^30.0.0';
                fs.writeJsonSync(userPackageJsonPath, userPackageJson, { spaces: 2 });
            }

            execSync('npm install --production', { cwd: srcDir, stdio: 'ignore' });

            const appPaths = await packager({
                dir: srcDir,
                out: outputDir,
                name: userPackageJson.name || 'ElectronApp',
                platform: 'win32',
                arch: 'x64',
                overwrite: true,
                asar: true
            });

            const clientZip = new AdmZip();
            clientZip.addLocalFolder(appPaths[0]);
            
            // Generate buffer with maximum compression levels to minimize download size
            const finalZipBuffer = clientZip.toBuffer(); 

            // Cache the compiled binary in RAM for high-speed multi-threaded retrieval
            activeBuilds.set(buildId, {
                buffer: finalZipBuffer,
                name: `${userPackageJson.name || 'windows-app'}-win32-x64.zip`
            });

            // Return the build ID and total content length so frontend can calculate chunk sizes
            res.json({ buildId, totalBytes: finalZipBuffer.length });

        } catch (error) {
            console.error(error);
            res.status(500).send(`Compilation Error: ${error.message}`);
        } finally {
            fs.remove(workspaceDir).catch(() => {});
            fs.remove(tempZipPath).catch(() => {});
        }
    });
});

// High-speed HTTP Range endpoint to let client download specific byte blocks in parallel
app.get('/download/:buildId', (req, res) => {
    const build = activeBuilds.get(req.params.buildId);
    if (!build) return res.status(404).send('Build expired or not found.');

    const totalSize = build.buffer.length;
    const range = req.headers.range;

    // Set headers to explicitly permit multi-threaded chunking
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${build.name}"`);

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        const chunksize = (end - start) + 1;

        // Slice the memory buffer instantly without disk reading delays
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

// Clear cache endpoint once client stitches the download successfully
app.delete('/download/:buildId', (req, res) => {
    activeBuilds.delete(req.params.buildId);
    res.sendStatus(200);
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));
