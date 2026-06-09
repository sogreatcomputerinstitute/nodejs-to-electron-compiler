const express = require('express');
const busboy = require('busboy');
const packager = require('@electron/packager');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');
const { execSync } = require('child_process');

const app = express();

app.use(express.static('public'));

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

    bb.on('file', (name, file, info) => {
        const fstream = fs.createWriteStream(tempZipPath);
        file.pipe(fstream);
    });

    bb.on('finish', async () => {
        try {
            console.log(`[${buildId}] Upload complete. Extracting source...`);
            const zip = new AdmZip(tempZipPath);
            zip.extractAllTo(srcDir, true);

            const userPackageJsonPath = path.join(srcDir, 'package.json');
            
            if (!fs.existsSync(userPackageJsonPath)) {
                return res.status(400).send('Error: package.json missing from root of zip.');
            }

            const userPackageJson = fs.readJsonSync(userPackageJsonPath);
            console.log(`[${buildId}] Found package.json for: ${userPackageJson.name}`);

            // Force injection of Electron core dependency if omitted
            if (!userPackageJson.dependencies || !userPackageJson.dependencies.electron) {
                console.log(`[${buildId}] Injecting Electron core dependency...`);
                userPackageJson.dependencies = userPackageJson.dependencies || {};
                userPackageJson.dependencies['electron'] = '^30.0.0';
                fs.writeJsonSync(userPackageJsonPath, userPackageJson, { spaces: 2 });
            }

            // Install standard dependencies specified in your uploaded package.json
            console.log(`[${buildId}] Running npm install...`);
            execSync('npm install --production', { cwd: srcDir, stdio: 'ignore' });

            console.log(`[${buildId}] Compiling to Windows Executable...`);
            
            // TARGETED WINDOWS PACKAGING OPTIONS
            const appPaths = await packager({
                dir: srcDir,
                out: outputDir,
                name: userPackageJson.name || 'ElectronApp',
                platform: 'win32',  // Always compiles a Windows app (.exe)
                arch: 'x64',        // Standard 64-bit Windows architecture
                overwrite: true,
                asar: true          // Packages your files into an internal secure archive
            });

            console.log(`[${buildId}] Packaging completed successfully. Compressing...`);
            const clientZip = new AdmZip();
            clientZip.addLocalFolder(appPaths[0]);
            const finalZipBuffer = clientZip.toBuffer();

            res.set({
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${userPackageJson.name || 'windows-app'}-win32-x64.zip"`,
                'Content-Length': finalZipBuffer.length
            });

            res.end(finalZipBuffer);

        } catch (error) {
            console.error(error);
            res.status(500).send(`Compilation Error: ${error.message}`);
        } finally {
            // Clean up files safely to prevent server storage bloat
            fs.remove(workspaceDir).catch(() => {});
            fs.remove(tempZipPath).catch(() => {});
        }
    });
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));
