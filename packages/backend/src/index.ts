import 'dotenv/config';
import express from 'express';
import { guidesRouter } from './routes/guides';
import { eventsRouter } from './routes/events';
import { systemRouter } from './routes/system';

const app = express();
app.use(express.json({ limit: '256kb' })); // guides + event batches are small; cap defensively

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/guides', guidesRouter);
app.use('/events', eventsRouter);
app.use('/system', systemRouter);

// Centralized error handler — never leak stack traces or let an unhandled
// rejection crash the process for a single bad request.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`guide-engine backend listening on :${port}`);
});
