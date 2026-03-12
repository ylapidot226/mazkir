const timestamp = () => new Date().toISOString();

const logger = {
  info: (context, message, data = {}) => {
    console.log(JSON.stringify({ level: 'INFO', time: timestamp(), context, message, ...data }));
  },
  error: (context, message, error = {}) => {
    console.error(JSON.stringify({
      level: 'ERROR',
      time: timestamp(),
      context,
      message,
      error: error.message || error,
      stack: error.stack,
    }));
  },
  warn: (context, message, data = {}) => {
    console.warn(JSON.stringify({ level: 'WARN', time: timestamp(), context, message, ...data }));
  },
};

module.exports = logger;
