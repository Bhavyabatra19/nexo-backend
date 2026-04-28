/**
 * BullMQ Queue definitions — shared between API and workers.
 * Redis connection is required (REDIS_URL env var).
 */

const { Queue } = require('bullmq');
const IORedis = require('ioredis');

let connection;

function getRedisConnection() {
  if (!connection) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    connection = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    connection.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
  }
  return connection;
}

const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail:     { count: 200 },
};

const enrichQueue = new Queue('enrichment', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
  },
});

const embedQueue = new Queue('embedding', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 },
  },
});

const messageParseQueue = new Queue('message-parse', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
  },
});

const networkScanQueue = new Queue('network-scan', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 2,
  },
});

const notificationQueue = new Queue('notifications', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

const profileMonitorQueue = new Queue('profile-monitor', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 2,
    backoff: { type: 'fixed', delay: 10000 },
  },
});

// Chat-based network scan (Sprint 1 P0). Single attempt — failures persist
// to the scans row, no value in retrying an LLM-driven query that errored.
const scanQueryQueue = new Queue('scan-query', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

module.exports = {
  enrichQueue,
  embedQueue,
  messageParseQueue,
  networkScanQueue,
  notificationQueue,
  profileMonitorQueue,
  scanQueryQueue,
  getRedisConnection,
};
