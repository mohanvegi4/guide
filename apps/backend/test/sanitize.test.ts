import { describe, expect, it } from 'vitest';
import { sanitizePlainText, sanitizeStepContent } from '../src/sanitize';

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
