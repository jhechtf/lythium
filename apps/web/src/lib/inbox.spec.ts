import { describe, expect, it } from 'vitest';
import { inboxHref, parseInboxQuery, prHref, relativeTime } from './inbox';

const parse = (s: string) => parseInboxQuery(new URLSearchParams(s));

describe('inboxHref', () => {
  it('preserves other filters and resets the page on a change', () => {
    const q = parse('status=approved&q=x&group_by=repository&page=4');
    expect(inboxHref(q, { repo: 'a/b' })).toBe(
      '/?status=approved&repo=a%2Fb&q=x&group_by=repository',
    );
  });
  it('keeps an explicit page and omits defaults', () => {
    const q = parse('page=2');
    expect(inboxHref(q, { page: 3 })).toBe('/?page=3');
    expect(inboxHref(parse(''), {})).toBe('/');
  });
});

describe('parseInboxQuery', () => {
  it('drops a repo that is not owner/name', () => {
    expect(parse('repo=foo').repo).toBeNull();
    expect(parse('repo=a/b/c').repo).toBeNull();
    expect(parse('repo=a%2F').repo).toBeNull();
    expect(parse('repo=a/b').repo).toBe('a/b');
  });
});

describe('prHref', () => {
  it('links to the existing review route', () => {
    expect(prHref('acme/web', 7)).toBe('/pr/acme/web/7');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  it('formats ages', () => {
    expect(relativeTime('2026-01-02T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2025-12-30T12:00:00Z', now)).toBe('3d ago');
  });
  it('does not round up or invent a time', () => {
    expect(relativeTime('2026-01-02T12:00:00Z', now)).toBe('just now');
    expect(relativeTime('2025-12-02T12:00:00Z', now)).toBe('1mo ago');
    expect(relativeTime('2024-01-02T12:00:00Z', now)).toBe('2y ago');
  });
  it('does not invent a time', () => {
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime('garbage', now)).toBeNull();
  });
});
