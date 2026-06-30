const express = require('express');
const cors = require('cors');
const { Connection } = require('./src/config/db');
const { CandidateRouter } = require('./src/routes/candidate.routes');
const { userRouter } = require('./src/routes/user.Routes');
const { CandidateController } = require('./src/controllers/Candidate.controller');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
// Restrict to known origins in production; fall back to open in dev
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin) and listed origins
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
}));

// ── Razorpay webhook must receive raw body for HMAC verification ──────────────
app.post(
  '/users/webhook',
  bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }),
  CandidateController.webhook
);

// ── Body parsing ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'Krishna Pulse API' }));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/users', CandidateRouter);
app.use('/admin/users', userRouter);

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Unhandled error]', err.message);
  res.status(500).json({ status: 'error', message: err.message });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3300;

// Start listening immediately so the platform healthcheck on `/` succeeds
// regardless of DB connection timing.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// Connect to MongoDB separately. Retry instead of exiting, so a slow or
// briefly-unavailable database doesn't take the whole service down.
const connectWithRetry = async (attempt = 1) => {
  try {
    await Connection();
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error(`❌ DB connection failed (attempt ${attempt}):`, err.message);
    if (attempt < 10) {
      setTimeout(() => connectWithRetry(attempt + 1), 5000);
    } else {
      console.error('❌ Giving up on DB connection after 10 attempts');
    }
  }
};
connectWithRetry();
