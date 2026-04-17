require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// Initialize the Winston logger
const logger = require('./logger');

// Global console override so existing console.log/console.error calls 
// automatically pipe into winston files per user request.
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

console.log = function(...args) {
  logger.info(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));
  // Keep regular terminal output running seamlessly too
  origLog.apply(console, args);
};

console.error = function(...args) {
  logger.error(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));
  origError.apply(console, args);
};

console.warn = function(...args) {
  logger.warn(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));
  origWarn.apply(console, args);
};

// Import routes
const authRoutes = require('./routes/auth');
const syncRoutes = require('./routes/sync');
const contactsRoutes = require('./routes/contacts');
const organizeRoutes = require('./routes/organize');
const calendarRoutes = require('./routes/calendar');
const debugRoutes = require('./routes/debug');
const linkedinRoutes = require('./routes/linkedin');
const notesRoutes = require('./routes/notes');
const remindersRoutes = require('./routes/reminders');
const activitiesRoutes = require('./routes/activities');
const aiRoutes = require('./routes/ai');
const settingsRoutes = require('./routes/settings');
const whatsappRoutes = require('./routes/whatsapp');
const dedupRoutes = require('./routes/dedup');
const groupsRoutes = require('./routes/groups');
const searchRoutes = require('./routes/search');
const introsRoutes = require('./routes/intros');
const extensionRoutes = require('./routes/extension');

// Import database
const db = require('./db');

// Import cron jobs
require('./cron/syncJob');
require('./cron/notificationJob');

// In-memory reminder scheduler (exact-time notifications)
const { loadUpcomingReminders } = require('./services/reminderScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// ============= MIDDLEWARE =============

// CORS configuration
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim()) 
  : ['http://localhost:5173'];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests) or if the origin is in our allowed list
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Gzip/Brotli compression — reduces payload size by 60-80%
app.use(compression());

// Global rate limiter — 200 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later' },
});
app.use(globalLimiter);

// Stricter rate limiter for AI endpoints — 20 requests per minute per IP
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'AI rate limit exceeded, please slow down' },
});

// Body parsing
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Setup Morgan to pipe HTTP request logs to Winston
app.use(morgan('combined', { 
  stream: { write: message => logger.info(message.trim()) } 
}));

// ============= ROUTES =============

// Health check
app.get('/health', async (req, res) => {
  const dbHealth = await db.testConnection();
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'NEXO Backend API',
    database: dbHealth ? 'connected' : 'disconnected'
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/organize', organizeRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/linkedin', linkedinRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/reminders', remindersRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/ai', aiLimiter, aiRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/dedup', dedupRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/intros', introsRoutes);
app.use('/api/extension', extensionRoutes);

// Root endpoint with API documentation
app.get('/', (req, res) => {
  res.json({
    service: 'Nexo Backend API',
    version: '2.0.0',
    message: 'Nexo — Community Network Intelligence Platform'
  });
});

// ============= ERROR HANDLING =============

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  
  res.status(error.status || 500).json({
    success: false,
    error: error.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
});

// ============= SERVER STARTUP =============

async function startServer() {
  try {
    // Test database connection
    console.log('Testing database connection...');
    const dbConnected = await db.testConnection();
    
    if (!dbConnected) {
      console.error('❌ Failed to connect to database');
      console.error('Please check your DATABASE_URL in .env file');
      process.exit(1);
    }

    // Load upcoming reminders into in-memory scheduler for exact-time delivery
    await loadUpcomingReminders();

    // Start server
    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   🚀 NEXO Backend API                                          ║
║   Server running on http://localhost:${PORT}                      ║
║                                                                ║
║   ✅ Database: Connected                                       ║
║   📚 Docs: http://localhost:${PORT}                               ║
║   🏥 Health: http://localhost:${PORT}/health                      ║
║                                                                ║
║   Frontend Integration Ready!                                  ║
║                                                                ║
║   Key Endpoints:                                               ║
║   - POST /api/sync/complete      (Sync Google data)            ║
║   - GET  /api/contacts           (Get all contacts)            ║
║   - GET  /api/contacts/search    (Search contacts)             ║
║   - POST /api/organize/tags      (Create tags)                 ║
║   - POST /api/organize/lists     (Create lists)                ║
║   - GET  /api/whatsapp/webhook   (Whatsapp webhook)            ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
      `);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await db.pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  await db.pool.end();
  process.exit(0);
});

// Start the server
startServer();

module.exports = app;