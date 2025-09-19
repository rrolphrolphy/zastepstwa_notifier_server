const HTTP_REQUEST_LIMIT = 30;

const http_requests = new Map();

require('dotenv').config();

const express = require('express');
const http = require('http');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const nodemailer = require('nodemailer');
const etagpath = path.join(__dirname, 'etag');
const etagfile = path.join(etagpath, 'etag');

const httpserver = express();
const server = http.createServer(httpserver);

const delay = ms => new Promise(res => setTimeout(res, ms));

var latest_etag, fetcher_running = true, loaded_timestamp = 0;
const check_timeout = 30000;
const fetcher_daemon_timeout = 30000;
const axios_timeout = 8000;
const axios_url = 'https://zastepstwa.zse.bydgoszcz.pl/';
const PORT = process.env.PORT || 8080;

const email_recipients = process.env.EMAIL_RECIPIENTS ? process.env.EMAIL_RECIPIENTS.split(',').map(email => email.trim()): [];

function sendlog(message) { logger.info(message); }
function sendwarn(message) { logger.warn(message); }
function senderr(message) { logger.error(message); }

async function create_transporter() {
    return nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: {
            user: process.env.SMTP_MAIL,
            pass: process.env.SMTP_PASS
        },
    });
}

async function notify(etag, changed = true) {
    await sendlog('[EMAIL]: Attempting to send an email to recipients...');
    if (email_recipients.length === 0) {
        sendwarn('[EMAIL]: No recipients configured.');
        return;
    }

    const subject = changed ?
        `Nowy drop zastępstw!` :
        `Błąd serwera powiadamiania o zastępstwach`;
    
    const message = changed ?
        `ETag: ${etag}\nTimestamp: ${new Date(loaded_timestamp).toISOString()}` : ``;

    try {
        const transporter = await create_transporter();

        for (const recipient of email_recipients) {
            await transporter.sendMail({
                from: process.env.EMAIL_FROM,
                to: recipient,
                subject: subject,
                text: message,
                html: `<p>${message.replace(/\n/g, '<br>')}</p>`
            });

        }
        sendlog(`[EMAIL]: Notification has been send successfully to ${email_recipients.length} mails`);
    } catch (error) {
        senderr(`[EMAIL ERROR]: Failed to send email: ${error.message}`);
    }
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
        
        try {
            await sendlog('[FETCHER]: Sending HTTP HEAD request to ZSE server...');

            const response = await axios.head(axios_url, {timeout: axios_timeout});

            if (response.status === 200) {
                await sendlog('[FETCHER]: Server healthy, returned 200 OK');

                if (response.headers['etag']) {
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
                            await notify(latest_etag, true);

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
                                await notify(latest_etag, true);

                            } catch (err) {
                                throw new Error(`Could not create ETag file (${etagfile}): ${err}`);
                            }

                        } else {
                            throw new Error(`File system error: ${err}`);
                        }
                    }

                } else {
                    await senderr(`[FETCHER]: Couldn't receive ETag header`);
                    await notify('', false);
                }

            } else {
                await senderr(`[FETCHER]: Server returned status: ${response.status}`);
                await notify('', false);
            }

        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                await senderr(`[FETCHER]: Request timeout, server not responding: ${error.message}`);
                await notify('', false);

            } else if (error.code === 'ECONNREFUSED') {
                await senderr(`[FETCHER]: Connection refused, server down: ${error.message}`);
                await notify('', false);
            } else if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || error.code === 'CERT_HAS_EXPIRED') {
                await senderr(`[FETCHER]: SSL certificate error: ${error.message}`);
                await notify('', false);
            } else if (error.response) {
                await senderr(`[FETCHER]: Unknown error: ${error.response.status}, Full error message: ${error.message}`);
                await notify('', false);
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
        fetcher_running = false;
        await senderr(`[FETCHER DAEMON]: Fetcher crashed due to: ${error.message}`);
        await notify('', false);
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
}, 60000);

httpserver.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        latest_etag: latest_etag,
        fetcher_running: fetcher_running
    });
});

httpserver.get('/', (req, res) => {
    res.send('Server running')
});

httpserver.use(async (req, res) => {
    res.status(404).send('404 not found');
});

server.listen(PORT, () => {
    const required_env_vars = ['SMTP_MAIL', 'SMTP_PASS', 'EMAIL_FROM', 'EMAIL_RECIPIENTS'];
    const missing_vars = required_env_vars.filter(var_name => !process.env[var_name]);

    if (missing_vars.length > 0) {
        senderr(`[CONFIG ERROR]: Missing required environment variables: ${missing_vars.join(', ')}`);
        return;
    }
    if (email_recipients.length === 0) {
        senderr('[CONFIG ERROR]: No email recipients configured in EMAIL_RECIPIENTS');
        return;
    }

    fetcher_daemon();
    sendlog('');
    sendlog('===========================');
    sendlog('[LISTENER]: Server running!')
    sendlog('===========================');
    sendlog('');
});

// terminate handler

function shutdown() {
    sendlog('[SHUTDOWN]: Closing HTTP server...');
    server.close(() => {
        sendlog('[SHUTDOWN]: HTTP server closed');
        process.exit(0);
    });

    setTimeout(() => {
        sendwarn('[SHUTDOWN]: Forced exit after timeout');
        process.exit(1);
    }, 5000);
}

process.on('SIGINT', () => {
    sendwarn('Server interrupted by user from keyboard');
    shutdown();
});

process.on('SIGTERM', () => {
    sendwarn('Server terminated by SIGTERM');
    shutdown();
});

process.on('uncaughtException', (err) => {
    senderr(`Uncaught exception: ${err.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    senderr(`Unhandled rejection: ${reason}`);
});