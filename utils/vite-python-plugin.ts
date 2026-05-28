import { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

export function pythonRunnerPlugin(): Plugin {
  const sandboxDir = path.resolve(__dirname, '../python_sandbox');

  // Ensure sandbox directory exists
  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  return {
    name: 'vite-plugin-python-runner',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();

        // 1. Save media file to sandbox
        if (req.url.startsWith('/api/save-media')) {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { filename, base64 } = JSON.parse(body);
              if (!filename || !base64) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing filename or base64 data' }));
                return;
              }

              const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
              const buffer = Buffer.from(cleanBase64, 'base64');
              const filePath = path.join(sandboxDir, filename);

              // Prevent directory traversal attacks
              if (!filePath.startsWith(sandboxDir)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Invalid file path' }));
                return;
              }

              fs.writeFileSync(filePath, buffer);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, message: `Saved ${filename} successfully` }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // 2. Run Python script
        if (req.url.startsWith('/api/run-python')) {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { script } = JSON.parse(body);
              if (!script) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing script parameter' }));
                return;
              }

              // A. Clean up old output files from sandbox
              if (fs.existsSync(sandboxDir)) {
                const sandboxFiles = fs.readdirSync(sandboxDir);
                for (const file of sandboxFiles) {
                  if (file.startsWith('output_')) {
                    try {
                      fs.unlinkSync(path.join(sandboxDir, file));
                    } catch (e) {
                      // ignore delete errors
                    }
                  }
                }
              }

              // B. Write script.py
              const scriptPath = path.join(sandboxDir, 'script.py');
              fs.writeFileSync(scriptPath, script);

              // C. Execute Python script inside sandbox using virtualenv binary
              const pythonBin = path.join(sandboxDir, '.venv/bin/python');
              const execCmd = `"${pythonBin}" "${scriptPath}"`;

              exec(execCmd, { cwd: sandboxDir, timeout: 60000 }, (error, stdout, stderr) => {
                const success = !error;
                const exitCode = error ? (error.code || 1) : 0;

                // D. Scan for output_* files
                const outputFiles: any[] = [];
                if (fs.existsSync(sandboxDir)) {
                  const sandboxFiles = fs.readdirSync(sandboxDir);
                  for (const file of sandboxFiles) {
                    if (file.startsWith('output_') && file !== 'script.py') {
                      const filePath = path.join(sandboxDir, file);
                      try {
                        const fileBuffer = fs.readFileSync(filePath);
                        const base64Data = fileBuffer.toString('base64');
                        const ext = path.extname(file).toLowerCase();
                        let mimeType = 'application/octet-stream';

                        if (ext === '.png') mimeType = 'image/png';
                        else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                        else if (ext === '.gif') mimeType = 'image/gif';
                        else if (ext === '.webm') mimeType = 'video/webm';
                        else if (ext === '.mp4') mimeType = 'video/mp4';
                        else if (ext === '.mp3') mimeType = 'audio/mp3';
                        else if (ext === '.wav') mimeType = 'audio/wav';

                        outputFiles.push({
                          filename: file,
                          mimeType,
                          base64: base64Data
                        });

                        // Delete output file after reading
                        fs.unlinkSync(filePath);
                      } catch (e) {
                        // ignore file read/delete errors
                      }
                    }
                  }
                }

                // E. Respond with stdout/stderr/files
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  success,
                  exitCode,
                  stdout,
                  stderr,
                  files: outputFiles
                }));
              });
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        next();
      });
    }
  };
}
