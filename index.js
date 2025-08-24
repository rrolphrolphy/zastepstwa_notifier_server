const express = require('express');
const server = express();
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const etagpath = path.join(__dirname, 'etag');
const etagfile = path.join(etagpath, 'etag');

const delay = ms => new Promise(res => setTimeout(res, ms));

var latest_etag, fetcher_running;
var internal_error = false, external_error = false, another_error = false;
const check_timeout = 30000;
const fetcher_daemon_timeout = 30000;
const axios_timeout = 10000;
const axios_url = 'http://127.0.0.1:8090';

function custom_timestamp() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

async function sendlog(message) {
    console.log(`[${custom_timestamp()}] LOG --> ${message}`);
}

async function sendwarn(message) {
    console.warn(`[${custom_timestamp()}] WARN --> ${message}`);
}

async function senderr(message) {
    console.log(`[${custom_timestamp()}] ERROR -->`);
    console.log(`[${custom_timestamp()}] ERROR --> ===========================`);
    console.error(`[${custom_timestamp()}] ERROR --> `, message);
    console.log(`[${custom_timestamp()}] ERROR --> ===========================`);
    console.log(`[${custom_timestamp()}] ERROR -->`);
}

async function fetcher() {
    while (true) {
        fetcher_running = true;
        internal_error = false;
        external_error = false;
        another_error = false;
        
        try {
            await sendlog('[FETCHER] Sending HTTP HEAD request to ZSE server...');

            const response = await axios.head(axios_url, {
                timeout: axios_timeout
            });

            if (response.status === 200) {
                external_error = false;
                await sendlog('[FETCHER] Server healthy, returned 200 OK');

                if (response.headers['etag']) {
                    another_error = false;
                    latest_etag = response.headers['etag'];
                    await sendlog(`[FETCHER] Gathered ETag: ${latest_etag}`);

                    try {
                        await fs.mkdir(etagpath, {
                            recursive: true
                        });

                    } catch (err) {
                        throw new Error(`Could not create directory ${etagpath}: ${err}`);
                    }

                    try {
                        const old_etag = await fs.readFile(etagfile, 'utf-8');

                        if (old_etag !== latest_etag) {
                            await sendlog('[FETCHER] ETag changed, updating file...');
                            await fs.writeFile(etagfile, latest_etag);
                            await sendlog('[FETCHER] ETag file updated successfully');

                        } else {
                            await sendlog('[FETCHER] Current ETag equals the previous one');
                        }

                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            await sendlog('[FETCHER] No ETag file found, creating new one...');

                            try {
                                await fs.writeFile(etagfile, latest_etag);
                                await sendlog('[FETCHER] ETag file created successfully');

                            } catch (err) {
                                throw new Error(`Could not create ETag file (${etagfile}): ${err}`);
                            }

                        } else {
                            throw new Error(`File system error: ${err}`);
                        }
                    }

                } else {
                    another_error = true;
                    await senderr(`[FETCHER] Couldn't receive ETag header`);
                }

            } else {
                external_error = true;
                await senderr(`[FETCHER] Server returned status: ${response.status}`);
            }

        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                another_error = true;
                await senderr(`[FETCHER] Request timeout, server not responding: ${error.message}`);

            } else if (error.code === 'ECONNREFUSED') {
                external_error = true;
                await senderr(`[FETCHER] Connection refused, server down: ${error.message}`);

            } else if (error.response) {
                another_error = true;
                await senderr(`[FETCHER] Unknown error: ${error.response.status}, Full error message: ${error.message}`);

            } else if (error.message && error.message.includes('Could not create')) {
                throw error;

            } else if (error.message && error.message.includes('File system error')) {
                throw error;

            } else {
                throw error;
                
            }
        }

        fetcher_running = false;
        await delay(check_timeout);
    }
}

async function fetcher_daemon() {
    try {
        await sendlog('[FETCHER DAEMON]: Running');
        await fetcher();
    } catch (error) {
        internal_error = true;
        fetcher_running = false;
        await senderr(`[FETCHER DAEMON]: Fetcher crashed due to: ${error.message}`);
        await senderr(`[FETCHER DAEMON]: Restarting fetcher...`)
        setTimeout(fetcher_daemon, fetcher_daemon_timeout);
    }
}

fetcher_daemon();

server.use((req, res, next) => {
    sendlog(`[REQUEST] Received a ${req.method} request for ${req.url} from ${req.ip} ({${req.connection.remoteAddress})`);
    next();
});

server.get('/get', async (req, res) => {
    res.send('Hello world!');
});

server.use(async (req, res) => {
    res.status(404).send('404 not found');
});

server.listen(8080, () => {
    sendlog('');
    sendlog('===========================');
    sendlog('[LISTENER]: Server running!')
    sendlog('===========================');
    sendlog('');
});