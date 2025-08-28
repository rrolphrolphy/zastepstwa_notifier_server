const WS_CONNECTION_LIMIT = 10;
const WS_MESSAGE_LIMIT = 60;
const HTTP_REQUEST_LIMIT = 30;
const MAX_PAYLOAD_SIZE = 1024;

const ws_connections = new Map();
const ws_messages = new Map();
const http_requests = new Map();

const express = require('express');
const http = require('http');
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');
const etagpath = path.join(__dirname, 'etag');
const etagfile = path.join(etagpath, 'etag');

const httpserver = express();
const server = http.createServer(httpserver);
const wss = new WebSocket.Server({server});

const delay = ms => new Promise(res => setTimeout(res, ms));

var latest_etag, fetcher_running = true, loaded_timestamp = 0;
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

function sendlog(message) {
    console.log(`[${custom_timestamp()}] LOG --> ${message}`);
}

function sendwarn(message) {
    console.warn(`[${custom_timestamp()}] WARN --> ${message}`);
}

function senderr(message) {
    console.log(`[${custom_timestamp()}] ERROR -->`);
    console.log(`[${custom_timestamp()}] ERROR --> ===========================`);
    console.error(`[${custom_timestamp()}] ERROR --> `, message);
    console.log(`[${custom_timestamp()}] ERROR --> ===========================`);
    console.log(`[${custom_timestamp()}] ERROR -->`);
}

async function notify(etag) {
    sendlog(`[NOTIFIER]: Notifying ${wss.clients.size} clients about ETag change`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                s: 1,
                e: etag,
                t: loaded_timestamp
            }));
        };
    });
}

async function save_etag(etag, ts) {
    const payload = {etag, timestamp: ts};
    await fs.writeFile(etagfile, JSON.stringify(payload));
}

async function load_etag() {
    const content = await fs.readFile(etagfile, 'utf-8');
    try {
        const parsed = JSON.parse(content);
        loaded_timestamp = parsed.timestamp;
        return [parsed.etag, parsed.timestamp];
    } catch {
        return content;
    }
}

async function fetcher() {
    while (true) {
        fetcher_running = true;
        internal_error = false;
        external_error = false;
        another_error = false;
        
        try {
            await sendlog('[FETCHER]: Sending HTTP HEAD request to ZSE server...');

            const response = await axios.head(axios_url, {timeout: axios_timeout});

            if (response.status === 200) {
                external_error = false;
                await sendlog('[FETCHER]: Server healthy, returned 200 OK');

                if (response.headers['etag']) {
                    another_error = false;
                    latest_etag = response.headers['etag'].replace(/^"|"$/g, '');
                    await sendlog(`[FETCHER]: Gathered ETag: ${latest_etag}`);

                    try {
                        await fs.mkdir(etagpath, {
                            recursive: true
                        });

                    } catch (err) {
                        throw new Error(`Could not create directory ${etagpath}: ${err}`);
                    }

                    try {
                        const old_etag = await load_etag();

                        if (old_etag[0] !== latest_etag) {
                            await sendlog('[FETCHER]: ETag changed, updating file...');
                            await save_etag(latest_etag, Date.now());
                            await sendlog('[FETCHER]: ETag file updated successfully');
                            loaded_timestamp = Date.now();
                            await notify(latest_etag);

                        } else {
                            await sendlog('[FETCHER]: Current ETag equals the previous one');
                        }

                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            await sendlog('[FETCHER]: No ETag file found, creating new one...');

                            try {
                                await save_etag(latest_etag, Date.now());
                                await sendlog('[FETCHER]: ETag file created successfully');
                                loaded_timestamp = Date.now();
                                await notify(latest_etag);

                            } catch (err) {
                                throw new Error(`Could not create ETag file (${etagfile}): ${err}`);
                            }

                        } else {
                            throw new Error(`File system error: ${err}`);
                        }
                    }

                } else {
                    another_error = true;
                    await senderr(`[FETCHER]: Couldn't receive ETag header`);
                }

            } else {
                external_error = true;
                await senderr(`[FETCHER]: Server returned status: ${response.status}`);
            }

        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                another_error = true;
                await senderr(`[FETCHER]: Request timeout, server not responding: ${error.message}`);

            } else if (error.code === 'ECONNREFUSED') {
                external_error = true;
                await senderr(`[FETCHER]: Connection refused, server down: ${error.message}`);

            } else if (error.response) {
                another_error = true;
                await senderr(`[FETCHER]: Unknown error: ${error.response.status}, Full error message: ${error.message}`);
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

httpserver.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    let requests = http_requests.get(ip);
    if (!requests || now > requests.resetTime) {
        requests = { count: 0, resetTime: now + 60000 };
    }
    if (requests.count >= HTTP_REQUEST_LIMIT) {
        sendwarn(`[HTTP REQUEST]: ${ip} is connecting to many times!`)
        res.status(429).send('You have been rate limited');
    }
    requests.count++;
    http_requests.set(ip, requests);
    sendlog(`[HTTP REQUEST]: ${req.method} ${req.url} from ${ip}`);
    next();
});

setInterval(() => {
    const now = Date.now();
    
    for (const [ip, data] of http_requests) {
        if (now > data.resetTime) {
            http_requests.delete(ip);
        }
    }

    for (const [ip, data] of ws_messages) {
        if (now > data.resetTime) {
            ws_messages.delete(ip);
        }
    }
}, 60000);

httpserver.get('/', (req, res) => {
    res.send('Server running')
});

httpserver.use(async (req, res) => {
    res.status(404).send('404 not found');
});

// ws

// keep-alive

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('connection', async (ws, req) => {
    const ip = req.socket.remoteAddress;
    const connections = ws_connections.get(ip) || 0;
    if (connections >= WS_CONNECTION_LIMIT) {
        ws.close(1008, 'Too many connections from your IP');
        await sendwarn(`[WS RATE LIMIT]: ${ip} is connecting too many times!`);
        return;
    }
    ws_connections.set(ip, connections + 1);
    const message_limit = {
        count: 0,
        resetTime: Date.now() + 60000
    };
    ws_messages.set(ip, message_limit);
    sendlog(`[WS]: New client connected from ${ip}`);

    if (fetcher_running) {
        await new Promise(resolve => {
            const checkInterval = setInterval(() => {
                if (!fetcher_running) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
    }

    // s:
    // 0 new etag
    // 1 etag up to date
    // 2 internal error
    // 3 another error
    // 4 external error

    // if client sends 0 means respond me with an etag

    ws.on('message', async function message(data) {

        const message_count = ws_messages.get(ip);
        if (message_count && message_count.count >= WS_MESSAGE_LIMIT) {
            ws.close(1008, 'Message rate limit exceeded');
            await sendwarn(`[WS RATE LIMIT]: ${ip} has been sending too many messages!`);
            return;
        }

        if (message_count) {
            message_count.count++;
            ws_messages.set(ip, message_count);
        }

        if (data.length > MAX_PAYLOAD_SIZE) {
            ws.close(1009, 'Message to large');
            await sendwarn(`[WS]: ${ip} sent too large message!`);
            return;
        }

        if (fetcher_running) {
            await new Promise(resolve => {
                const checkInterval = setInterval(() => {
                    if (!fetcher_running) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
            });
        }

        if (!(data == "")) {
            if (latest_etag) {

                // check if any known error exist
                if (internal_error) {ws.send(JSON.stringify({s: 2}));
                } else if (another_error) {ws.send(JSON.stringify({s: 3}));
                } else if (external_error) {ws.send(JSON.stringify({s: 4}));}
                else {
                    // if no error

                    if (data == latest_etag) {ws.send(JSON.stringify({s: 1}));}
                    else {
                        ws.send(JSON.stringify({
                            s: 0,
                            e: latest_etag,
                            t: loaded_timestamp
                        }));
                    }
                }

            } else {
                ws.send(JSON.stringify({
                    s: 2
                }));
            }
        }
    });

    ws.on('close', () => {
        const current = ws_connections.get(ip) || 0;
        if (current > 0) ws_connections.set(ip, current - 1);
        ws_messages.delete(ip);
        sendlog(`[WS]: Client from ${ip} disconnected`);
    });
    ws.on('error', (err) => {senderr(`[WS CLIENT ERROR] ${ip}: ${err.message}`);});

    ws.isAlive = true;
    ws.on('pong', () => {ws.isAlive = true;});
});

wss.on('error', (err) => {
    senderr(`[WS SERVER ERROR]: ${err.message}`);
})

server.listen(8080, () => {
    fetcher_daemon();
    sendlog('');
    sendlog('===========================');
    sendlog('[LISTENER]: Server running!')
    sendlog('===========================');
    sendlog('');
});