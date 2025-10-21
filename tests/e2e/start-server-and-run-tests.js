#!/usr/bin/env node

/**
 * Simple replacement for start-server-and-test that doesn't rely on wmic.exe
 * Starts http-server, waits for it to be ready, runs tests, then cleanly shuts down
 */

/* global process */

import { spawn, spawnSync } from 'child_process';
import http from 'http';
import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

const PORT = 8080;
const MAX_WAIT_TIME = 30000; // 30 seconds
const testCommand = process.argv[2];

if (!testCommand) {
    console.error('Usage: node start-server-and-run-tests.js <test-command>');
    process.exit(1);
}

// Recursively get the newest modification time in a directory
function getNewestMtime(dir) {
    let newest = statSync(dir).mtime;

    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                const dirMtime = getNewestMtime(fullPath);
                if (dirMtime > newest) newest = dirMtime;
            } else {
                const fileMtime = statSync(fullPath).mtime;
                if (fileMtime > newest) newest = fileMtime;
            }
        }
    } catch {
        // Skip if we can't read directory
    }

    return newest;
}

// Check if source files are newer than the build
function checkBuildFreshness() {
    try {
        // Get the build time from the dist/www directory
        if (!existsSync('dist/www')) {
            return true; // Can't check, skip
        }
        const buildTime = statSync('dist/www').mtime;

        // Check key source locations
        const sourceDirs = ['www', 'service-worker.js'];

        for (const source of sourceDirs) {
            if (existsSync(source)) {
                const sourceTime = statSync(source).isDirectory()
                    ? getNewestMtime(source)
                    : statSync(source).mtime;

                if (sourceTime > buildTime) {
                    console.warn('\n⚠️  WARNING: Source files have been modified since the last build!');
                    console.warn(`   Location: ${source}`);
                    console.warn('   Your tests may not reflect your latest code changes.');
                    console.warn('   Run "npm run build-src" to rebuild before testing.\n');
                    return false;
                }
            }
        }
        return true;
    } catch {
        // If we can't check (missing files, etc.), skip the check
        return true;
    }
}

// Detect where www/index.html is located and verify build exists
function detectIndexPath() {
    // Check if we're in the root directory (has both www/ and dist/)
    if (existsSync('www/index.html') && existsSync('dist')) {
        // Verify the build exists
        if (!existsSync('dist/www/index.html')) {
            console.error('Error: Build not found at dist/www/index.html');
            console.error('Please build the app first with: npm run build-src (or npm run build)');
            console.error('The e2e tests require the built version in dist/');
            process.exit(1);
        }

        // Check if build is stale
        checkBuildFreshness();

        console.log('Running tests against: ./dist/www/index.html (built version)');
        return '/dist/www/index.html';
    }
    // Check if we're in the dist directory
    if (existsSync('www/index.html') && !existsSync('dist')) {
        console.log('Running tests against: ./www/index.html (built version in dist)');
        return '/www/index.html';
    }
    // Fallback - couldn't determine location
    console.error('Error: Could not find www/index.html in expected location');
    console.error('Make sure you run tests from the project root (after building) or from the dist directory');
    process.exit(1);
}

const INDEX_PATH = detectIndexPath();

let serverProcess = null;
let testExitCode = 0;

// Function to check if server is ready
function checkServer(debug = false) {
    return new Promise((resolve) => {
        // Use 127.0.0.1 explicitly to avoid IPv6 issues
        // Check the detected index path
        const req = http.get(`http://127.0.0.1:${PORT}${INDEX_PATH}`, (res) => {
            // Got a response - server is ready
            if (debug) console.log(`[DEBUG] Got response with status code: ${res.statusCode}`);
            res.resume(); // Consume response to free up memory
            resolve(true);
        });
        req.on('error', (err) => {
            if (debug) console.log(`[DEBUG] Got error: ${err.code} - ${err.message}`);
            // ECONNREFUSED means server not ready, anything else might mean server is up
            resolve(err.code !== 'ECONNREFUSED');
        });
        req.on('timeout', () => {
            if (debug) console.log(`[DEBUG] Request timed out`);
            req.destroy();
            resolve(false);
        });
        req.setTimeout(500);
    });
}

// Function to wait for server to be ready
async function waitForServer() {
    const startTime = Date.now();
    let attempts = 0;
    const maxAttempts = 60; // 60 attempts * 250ms = 15 seconds max

    // Show progress every 10 attempts
    while (attempts < maxAttempts && Date.now() - startTime < MAX_WAIT_TIME) {
        attempts++;
        // Enable debug on attempts 5 and 15 to see what's happening
        const debug = (attempts === 5 || attempts === 15);
        if (await checkServer(debug)) {
            console.log(`Server is ready on port ${PORT} (attempt ${attempts})`);
            return true;
        }
        if (attempts % 10 === 0) {
            console.log(`Still waiting for server... (attempt ${attempts})`);
        }
        // Wait a bit before next attempt
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.error(`Server did not respond after ${attempts} attempts`);
    console.error(`Try manually accessing http://localhost:${PORT}/ in a browser to debug`);
    return false;
}

// Function to start the server
function startServer() {
    return new Promise((resolve, reject) => {
        console.log('Starting http-server...');
        const spawnOptions = {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true
        };

        // On Linux/macOS, create a new process group so we can kill all children
        if (process.platform !== 'win32') {
            spawnOptions.detached = true;
        }

        serverProcess = spawn('npx', ['http-server', '-p', PORT.toString()], spawnOptions);

        let serverStarted = false;

        serverProcess.stdout.on('data', (data) => {
            const output = data.toString();
            // http-server outputs "Starting up" and "Available on:" when ready
            if ((output.includes('Starting up') || output.includes('Available on')) && !serverStarted) {
                serverStarted = true;
                console.log('http-server process started');
            }
        });

        serverProcess.stderr.on('data', (data) => {
            const errorMsg = data.toString();
            // Check for port in use error
            if (errorMsg.includes('EADDRINUSE') || errorMsg.includes('address already in use')) {
                console.error(`\nError: Port ${PORT} is already in use.`);
                console.error('Please close any running http-server instances or other applications using this port.');
                console.error(`On Windows, you can find the process with: netstat -ano | findstr :${PORT}`);
                console.error('Then kill it with: taskkill /PID <process-id> /F\n');
                reject(new Error(`Port ${PORT} already in use`));
            } else {
                console.error(`Server error: ${errorMsg}`);
            }
        });

        serverProcess.on('error', (err) => {
            reject(err);
        });

        // Give server a moment to start before we begin health checks
        setTimeout(() => resolve(), 1500);
    });
}

// Function to run tests
function runTests() {
    return new Promise((resolve) => {
        console.log(`Running tests: ${testCommand}`);
        const testProcess = spawn(testCommand, [], {
            stdio: 'inherit',
            shell: true
        });

        testProcess.on('exit', (code) => {
            testExitCode = code || 0;
            resolve();
        });

        testProcess.on('error', (err) => {
            console.error(`Test process error: ${err}`);
            testExitCode = 1;
            resolve();
        });
    });
}

// Function to stop the server cleanly
function stopServer() {
    return new Promise((resolve) => {
        if (!serverProcess || serverProcess.killed) {
            resolve();
            return;
        }

        console.log('Stopping http-server...');

        // On Windows, kill the entire process tree
        if (process.platform === 'win32') {
            try {
                // Use taskkill to kill the process tree on Windows - must be synchronous
                const result = spawnSync('taskkill', ['/pid', serverProcess.pid.toString(), '/T', '/F'], {
                    shell: true
                });

                if (result.error) {
                    console.error('Failed to kill server process:', result.error.message);
                }

                // Wait a moment for the port to be released
                setTimeout(() => {
                    console.log('Server stopped');
                    resolve();
                }, 1000);
            } catch (err) {
                console.error('Failed to kill server process:', err.message);
                resolve();
            }
        } else {
            // On Linux/macOS, kill the process group to ensure all children are killed
            let resolved = false;

            try {
                // Kill the entire process group (negative PID)
                process.kill(-serverProcess.pid, 'SIGTERM');
            } catch {
                // If process group kill fails, try killing just the process
                serverProcess.kill('SIGTERM');
            }

            // Wait for process to exit
            serverProcess.once('exit', () => {
                if (!resolved) {
                    resolved = true;
                    console.log('Server stopped');
                    // Give the OS a moment to release the port
                    setTimeout(() => resolve(), 500);
                }
            });

            // Force kill after 2 seconds if still running
            setTimeout(() => {
                if (!resolved) {
                    try {
                        process.kill(-serverProcess.pid, 'SIGKILL');
                    } catch {
                        if (serverProcess && !serverProcess.killed) {
                            serverProcess.kill('SIGKILL');
                        }
                    }
                    resolved = true;
                    console.log('Server force-stopped');
                    setTimeout(() => resolve(), 500);
                }
            }, 2000);
        }
    });
}

// Main execution
async function main() {
    try {
        // Start server
        await startServer();

        // Wait for server to be ready
        const serverReady = await waitForServer();
        if (!serverReady) {
            console.error('Server failed to start within timeout period');
            await stopServer();
            process.exit(1);
        }

        // Run tests
        await runTests();

        // Stop server and wait for it to fully stop
        await stopServer();

        // Exit with test exit code
        process.exit(testExitCode);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        await stopServer();
        process.exit(1);
    }
}

// Handle cleanup on exit signals
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, cleaning up...');
    await stopServer();
    process.exit(130);
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, cleaning up...');
    await stopServer();
    process.exit(143);
});

main();
