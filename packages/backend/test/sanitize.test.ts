import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db';
import { sanitizePlainText, sanitizeStepContent } from '../src/sanitize';
import { adminPool, app, createTenant, resetData, sampleStep } from './helpers';
import { bearer } from './auth-helpers';

describe('sanitizeStepContent', () => {
  it.each([
    ['<p>Hi</p><script>alert(1)</script>', '<p>Hi</p>'],
    ['<img src="https://x.test/a.png" onerror="alert(1)">', '<img src="https://x.test/a.png" />'],
    ['<a href="javascript:alert(1)">x</a>', '<a target="_blank" rel="noopener noreferrer">x</a>'],
    ['<iframe src="https://evil.test"></iframe><p>ok</p>', '<p>ok</p>'],
    ['<p style="position:fixed">x</p>', '<p>x</p>'],
    ['<style>body{display:none}</style><p>x</p>', '<p>x</p>'],
    ['<img src="data:image/png;base64,AAAA">', '<img />'],
    ['<svg onload="alert(1)"><circle/></svg>text', 'text'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeStepContent(input)).toBe(expected);
  });

  it('keeps allowed formatting and hardens links', () => {
    expect(
      sanitizeStepContent('<h2>Title</h2><p><strong>Bold</strong> <a href="https://docs.test">docs</a></p>'),
    ).toBe(
      '<h2>Title</h2><p><strong>Bold</strong> <a href="https://docs.test" target="_blank" rel="noopener noreferrer">docs</a></p>',
    );
  });

  it('strips all markup from plain-text fields', () => {
    expect(sanitizePlainText('<b>Next</b><script>x()</script>')).toBe('Next');
  });
});

describe('POST /guides/:id/publish sanitization', () => {
  let tenant: string;
  let guideId: string;

  beforeEach(async () => {
    await resetData();
    tenant = await createTenant('Acme');
    const res = await request(app)
      .post('/guides')
      .set('Authorization', bearer(tenant))
      .send({ name: 'G', type: 'tooltip' });
    guideId = res.body.id;
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  it('strips <script> from step.content in the returned AND stored version', async () => {
    const res = await request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send({
        steps: [
          {
            ...sampleStep,
            content: '<p>Hi</p><script>alert(document.cookie)</script>',
            actions: [{ label: '<img src=x onerror=alert(1)>Done', action: 'complete' }],
          },
        ],
        routeMatch: { type: 'exact', value: '/dashboard' },
      });

    expect(res.status).toBe(201);
    expect(res.body.steps[0].content).toBe('<p>Hi</p>');
    expect(res.body.steps[0].actions[0].label).toBe('Done');

    // Via the API...
    const fetched = await request(app).get(`/guides/${guideId}`).set('Authorization', bearer(tenant));
    expect(JSON.stringify(fetched.body.versions)).not.toContain('script');

    // ...and in the raw row, read with the superuser pool so nothing in the app
    // layer could be masking what's actually persisted.
    const raw = await adminPool.query(`SELECT steps::text AS steps FROM guide_version WHERE guide_id = $1`, [
      guideId,
    ]);
    expect(raw.rows[0].steps).not.toMatch(/script|onerror/i);
  });

  it('rejects a step whose content is empty after sanitization', async () => {
    const res = await request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send({
        steps: [{ ...sampleStep, content: '<script>alert(1)</script>' }],
        routeMatch: { type: 'exact', value: '/' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('empty_content_after_sanitize');
    const raw = await adminPool.query(`SELECT count(*)::int AS n FROM guide_version WHERE guide_id = $1`, [
      guideId,
    ]);
    expect(raw.rows[0].n).toBe(0);
  });

  it('rejects target selectors that bypass the data-guide-id convention', async () => {
    const res = await request(app)
      .post(`/guides/${guideId}/publish`)
      .set('Authorization', bearer(tenant))
      .send({
        steps: [{ ...sampleStep, targetSelector: '.btn-primary' }],
        routeMatch: { type: 'exact', value: '/' },
      });
    expect(res.status).toBe(400);
  });
});
