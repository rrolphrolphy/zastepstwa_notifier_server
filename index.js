const express = require('express');
const server = express();

server.use((req, res, next) => {
    console.log('Received a', req.method, 'request for', req.url);
    next();
});

server.get('/get', async (req, res) => {
    res.send('Hello world!');
});

server.use(async (req, res) => {
    res.status(404).send('404 not found');
});

server.listen(8080, () => {
    console.log('Server running!');
});