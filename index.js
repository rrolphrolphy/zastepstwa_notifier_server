const express = require('express');
const server = express();
const axios = require('axios');
const fs = require('fs');
const etagpath = './etag/';

const delay = ms => new Promise(res => setTimeout(res, ms));

var latest_etag, is_error = false, to_update = false;

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
        try {
            await sendlog('[FETCHER] Sending HTTP HEAD request to ZSE server...');
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await axios.head('http://127.0.0.1:8090', {
                signal: controller.signal,
                timeout: 10000
            });
            
            clearTimeout(timeoutId);
            
            if (response.status === 200) {
                await sendlog('[FETCHER] Server healthy, returned 200 OK');
                if (response.headers.has('ETag')) {
                    latest_etag = response.headers.get('ETag');
                    await sendlog(`[FETCHER] Gathered ETag: ${latest_etag}`);
                    fs.readdir(etagpath, (err, files) => {
                        if (err) {
                            senderr(`[FETCHER] An error occured while scanning ETag\'s directory: ${err}`);
                        } else {
                            if (files.length === 0) {
                                sendlog('[FETCHER] ETag\'s directory is empty, saving the current one in a new file...');
                                fs.writeFile('./etag/etag', latest_etag, (err) => {
                                    if (err) {
                                        senderr(`[FETCHER] An error occured while saving ETag file: ${err}`);
                                        is_error = true;
                                    } else {
                                        sendlog('[FETCHER] ETag file saved successfully');
                                        is_error = false;
                                    }
                                });
                            } else {
                                sendlog('[FETCHER] Found a previous ETag');
                                fs.readFile('./etag/etag', 'utf-8', (err, data) => {
                                    if (err) {
                                        senderr(`[FETCHER] An error occured while reading ETag file: ${err}`);
                                        is_error = true;
                                    } else {
                                        if (!data.includes(latest_etag)) {
                                            sendlog('[FETCHER] ETag file is going to be updated');
                                            to_update = true;
                                        } else {
                                            sendlog('[FETCHER] Current ETag equals the previous check\'s one');
                                            is_error = false;
                                        }
                                    }
                                });

                                if (to_update) {
                                    to_update = false;
                                    fs.writeFile('./etag/etag', latest_etag, (err) => {
                                        if (err) {
                                            senderr(`[FETCHER] An error occured while updating ETag file: ${err}`);
                                        } else {
                                            sendlog('[FETCHER] ETag file has been updated successfully');
                                        }
                                    });
                                }
                            }
                        }
                    });
                } else {
                    await senderr(`[FETCHER] Couldn\'t receive ETag header`)
                }
            } else {
                await senderr(`[FETCHER] Server returned status: ${response.status}`);
            }
            
        } catch (error) {
            if (error.name === 'AbortError') {
                await senderr(`[FETCHER] Request timeout, server not responding: ${error.message}`);
            } else if (error.code === 'ECONNREFUSED') {
                await senderr(`[FETCHER] Connection refused, server down: ${error.message}`);
            } else if (error.response) {
                await senderr(`[FETCHER] Server error: ${error.response.status}, Full error message: ${error.message}`);
            } else {
                await senderr(`[FETCHER] Network error: ${error.message}`);
            }
        }
        await delay(30000);
    }
}

async function fetcher_daemon() {
    try {
        await sendlog('[FETCHER DAEMON]: Running');
        await fetcher();
    } catch (error) {
        await senderr(`[FETCHER DAEMON]: Fetcher crashed, restarting: ${error.message}`);
        setTimeout(fetcher_daemon, 5000);
    }
}

fetcher_daemon();

server.use((req, res, next) => {
    sendlog(`[REQUEST] Received a ${req.method} request for ${req.url}`);
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