import express from 'express';
import crypto from 'crypto';

const jobs = new Map();
let activeJobId = null;
const JOB_TTL_MS = 15 * 60_000;
const MAX_RUNTIME_MS = 8 * 60_000;

function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    httpStatus: job.httpStatus,
    error: job.error,
    result: job.status === 'DONE' ? job.result : null
  };
}

function cleanupLater(jobId) {
  const timer = setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
  timer.unref?.();
}

async function runJob(job, body, port) {
  job.status = 'RUNNING';
  job.startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_RUNTIME_MS);
  timer.unref?.();

  try {
    const target = `http://127.0.0.1:${Number(port)}/api/uv/generate`;
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-uv-async-internal': '1' },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: `Interne Generierung lieferte keine JSON-Antwort (HTTP ${response.status}).` };
    }

    job.httpStatus = response.status;
    if (response.ok) {
      job.status = 'DONE';
      job.result = data;
      job.error = null;
    } else {
      job.status = 'FAILED';
      job.result = null;
      job.error = String(data?.error || `HTTP ${response.status}`);
    }
  } catch (error) {
    job.status = 'FAILED';
    job.httpStatus = error?.name === 'AbortError' ? 504 : 500;
    job.error = error?.name === 'AbortError'
      ? 'ÜV-Generierung hat das interne 8-Minuten-Sicherheitslimit überschritten.'
      : String(error?.message || error);
  } finally {
    clearTimeout(timer);
    job.finishedAt = new Date().toISOString();
    if (activeJobId === job.jobId) activeJobId = null;
    cleanupLater(job.jobId);
  }
}

export function createUvGenerateAsyncRouterV2105({ port = process.env.PORT || 3000 } = {}) {
  const router = express.Router();

  router.post('/api/uv/generate-async', (req, res) => {
    if (activeJobId) {
      const existing = jobs.get(activeJobId);
      if (existing && ['QUEUED', 'RUNNING'].includes(existing.status)) {
        return res.status(202).json({
          ok: true,
          accepted: true,
          reused: true,
          jobId: existing.jobId,
          status: existing.status,
          pollUrl: `/api/uv/generate-job/${encodeURIComponent(existing.jobId)}`
        });
      }
      activeJobId = null;
    }

    const jobId = `uvgen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      jobId,
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      httpStatus: null,
      error: null,
      result: null
    };
    jobs.set(jobId, job);
    activeJobId = jobId;

    res.status(202).json({
      ok: true,
      accepted: true,
      reused: false,
      jobId,
      status: job.status,
      pollUrl: `/api/uv/generate-job/${encodeURIComponent(jobId)}`
    });

    setImmediate(() => runJob(job, req.body, port));
  });

  router.get('/api/uv/generate-job/:jobId', (req, res) => {
    const job = jobs.get(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ ok: false, status: 'MISSING', error: 'ÜV-Generierungsjob nicht gefunden oder bereits abgelaufen.' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...publicJob(job) });
  });

  return router;
}
