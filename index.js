const HTTP_REQUEST_LIMIT = 30;

const http_requests = new Map();

require('dotenv').config();

const express = require('express');
const http = require('http');
const axios = require('axios');
const nodemailer = require('nodemailer');

const httpserver = express();
const server = http.createServer(httpserver);
server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;

const delay = ms => new Promise(res => setTimeout(res, ms));

var latest_etag = null;
var fetcher_running = true;
var loaded_timestamp = 0;
var is_first_fetch = true;

const check_timeout = 30000;
const fetcher_daemon_timeout = 30000;
const axios_timeout = 5000;
const axios_url = 'https://zastepstwa.zse.bydgoszcz.pl/';
const PORT = process.env.PORT || 8080;

const email_recipients = process.env.EMAIL_RECIPIENTS ? process.env.EMAIL_RECIPIENTS.split(',').map(email => email.trim()): [];

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
    console.log('[EMAIL]: Attempting to send an email to recipients...');
    if (email_recipients.length === 0) {
        console.warn('[EMAIL]: No recipients configured.');
        return;
    }

    const subject = changed ?
        `Nowy drop zastępstw!` :
        `Błąd serwera powiadamiania o zastępstwach`;
    
    const message = changed ?
        `ETag: ${etag}\nTimestamp: ${new Date(loaded_timestamp).toISOString()}` : `Error`;

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
        console.log(`[EMAIL]: Notification has been sent successfully to ${email_recipients.length} mails`);
    } catch (error) {
        console.error(`[EMAIL ERROR]: Failed to send email: ${error.message}`);
    }
}

async function fetcher() {
    while (true) {
        fetcher_running = true;
        
        try {
            const response = await axios.head(axios_url, {timeout: axios_timeout});

            if (response.status === 200 && response.headers['etag']) {
                const current_etag = response.headers['etag'].replace(/^"|"$/g, '');
                
                if (latest_etag !== current_etag) {
                    latest_etag = current_etag;
                    loaded_timestamp = Date.now();

                    if (!is_first_fetch) {
                        console.log(`[FETCHER]: ETag CHANGED: ${latest_etag}`);
                        await notify(latest_etag, true);
                    } else {
                        console.log(`[FETCHER]: Initial ETag set: ${latest_etag} (no email sent)`);
                        is_first_fetch = false;
                    }
                }
            }
        } catch (error) {
            if (error.code === 'ECONNREFUSED') {
                console.error(`[FETCHER]: Connection refused - server down`);
            } else if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
                console.error(`[FETCHER]: SSL certificate error`);
            } else if (error.response && error.response.status >= 400) {
                console.error(`[FETCHER]: HTTP error: ${error.response.status}`);
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
        console.log('[FETCHER DAEMON]: Running');
        await fetcher();
    } catch (error) {
        fetcher_running = false;
        console.error(`[FETCHER DAEMON]: Fetcher crashed due to: ${error.message}`);
        await notify('', false);
        console.error(`[FETCHER DAEMON]: Restarting fetcher...`);
        setTimeout(fetcher_daemon, fetcher_daemon_timeout);
    }
}

httpserver.use((req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.connection.remoteAddress;
    
    let requests = http_requests.get(ip);
    if (!requests || now > requests.resetTime) {
        requests = { count: 0, resetTime: now + 60000 };
    }
    
    if (requests.count >= HTTP_REQUEST_LIMIT) {
        res.status(429).send('You have been rate limited');
        return;
    }
    
    requests.count++;
    http_requests.set(ip, requests);
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
        console.error(`[CONFIG ERROR]: Missing required environment variables: ${missing_vars.join(', ')}`);
        return;
    }
    if (email_recipients.length === 0) {
        console.error('[CONFIG ERROR]: No email recipients configured in EMAIL_RECIPIENTS');
        return;
    }

    fetcher_daemon();
    console.log('');
    console.log('===========================');
    console.log('[LISTENER]: Server running!')
    console.log('===========================');
    console.log('');
});

function shutdown() {
    console.log('[SHUTDOWN]: Closing HTTP server...');
    server.close(() => {
        console.log('[SHUTDOWN]: HTTP server closed');
        process.exit(0);
    });

    setTimeout(() => {
        console.warn('[SHUTDOWN]: Forced exit after timeout');
        process.exit(1);
    }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
    console.error(`Uncaught exception: ${err.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error(`Unhandled rejection: ${reason}`);
});