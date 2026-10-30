import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { webhookRouter } from './routes/webhooks.js';
import { smsWebhookRouter } from './routes/sms-webhooks.js';
import { callsRouter } from './routes/calls.js';
import { usersRouter } from './routes/users.js';
import { adminRouter } from './routes/admin.js';
import { voicemailsRouter } from './routes/voicemails.js';
import { analyticsRouter } from './routes/analytics.js';
import { messagesRouter } from './routes/messages.js';
import { templatesRouter } from './routes/templates.js';
import { blacklistRouter } from './routes/blacklist.js';
import { dncRouter } from './routes/dnc.js';
import { spamRouter } from './routes/spam.js';
import { organizationsRouter } from './routes/organizations.js';
import { invitationsRouter } from './routes/invitations.js';
import { emailTemplatesRouter } from './routes/email-templates.js';
import { notificationSettingsRouter } from './routes/notification-settings.js';
import { integrationsRouter } from './routes/integrations.js';
import { publicRouter } from './routes/public.js';
import { aiAssistantsRouter } from './routes/ai-assistants.js';
import { aiSessionsRouter } from './routes/ai-sessions.js';
import { aiCampaignsRouter } from './routes/ai-campaigns.js';
import { vapiWebhookRouter } from './routes/vapi-webhooks.js';
import { startScheduler } from './lib/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProd = process.env.NODE_ENV === 'production';

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: isProd,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }),
);

// CORS
const allowedOrigin = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
app.use(
  cors({
    origin: [allowedOrigin, 'http://localhost:5173'],
    credentials: true,
  }),
);

// Twilio webhooks use URL-encoded bodies
app.use('/webhooks', express.urlencoded({ extended: false }));

// API uses JSON
app.use('/api', express.json({ limit: '1mb' }));

// Session (used for rate-limiting state, not auth — auth is JWT)
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-please-change',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    },
  }),
);

// Routes
app.use('/webhooks', webhookRouter);
app.use('/webhooks', smsWebhookRouter);
app.use('/api', callsRouter);
app.use('/api', usersRouter);
app.use('/api', voicemailsRouter);
app.use('/api', analyticsRouter);
app.use('/api', adminRouter);
app.use('/api', messagesRouter);
app.use('/api', templatesRouter);
app.use('/api', blacklistRouter);
app.use('/api', dncRouter);
app.use('/api', spamRouter);
app.use('/api', organizationsRouter);
app.use('/api', invitationsRouter);
app.use('/api', emailTemplatesRouter);
app.use('/api', notificationSettingsRouter);
app.use('/api', integrationsRouter);
app.use('/api', aiAssistantsRouter);
app.use('/api', aiSessionsRouter);
app.use('/api', aiCampaignsRouter);
app.use('/webhooks', vapiWebhookRouter);
app.use(publicRouter); // /unsubscribe/:token (public)

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Serve built frontend in production
if (isProd) {
  const clientDist = path.join(__dirname, '../../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[CSD Call Manager] Server running on port ${PORT}`);
  console.log(`[CSD Call Manager] Public URL: ${process.env.PUBLIC_BASE_URL || '(not set)'}`);
  startScheduler();
});

export default app;
