const winston = require('winston');
require('winston-daily-rotate-file');

const file_transport = new winston.transports.DailyRotateFile({
    dirname: 'logs',
    filename: '%DATE%.log',
    datePattern: 'DD.MM.YYYY',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d'
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'DD.MM.YYYY HH:mm:ss.SSS' }),
        winston.format.printf(info => `[${info.timestamp}] ${info.level.toUpperCase()} --> ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        file_transport
    ]
});

module.exports = logger;