// utilities for infrastructure such as error handling and logging

const pino = require('pino');

// currently let do simple console logging... we may make it configurable
// in the future
const logger = pino({});

// handle uncaught exception
process.on('uncaughtException', (e) => {
  logger.error(e);
});

// handle uncaught promise rejection
process.on('unhandledRejection', (reason) => {
  logger.warn('Promise rejected was not handled. Reason: %s', reason);
})

module.exports = {
  logger,
};
