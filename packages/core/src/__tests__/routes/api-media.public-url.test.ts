import { describe, it, expect } from 'vitest'
import { buildMediaPublicUrl } from '../../routes/api-media'
import type { Bindings } from '../../app'

const env = (over: Partial<Bindings> = {}) => over as Bindings

describe('buildMediaPublicUrl', () => {
  it('defaults to the r2.dev URL using BUCKET_NAME', () => {
    expect(buildMediaPublicUrl(env({ BUCKET_NAME: 'my-bucket' }), 'uploads/a.png'))
      .toBe('https://pub-my-bucket.r2.dev/uploads/a.png')
  })

  it('falls back to the dev bucket name when BUCKET_NAME is unset', () => {
    expect(buildMediaPublicUrl(env(), 'uploads/a.png'))
      .toBe('https://pub-sonicjs-media-dev.r2.dev/uploads/a.png')
  })

  it('uses MEDIA_PUBLIC_BASE when set (private bucket served via a custom base)', () => {
    expect(buildMediaPublicUrl(env({ MEDIA_PUBLIC_BASE: 'https://cdn.example.com/media' }), 'uploads/a.png'))
      .toBe('https://cdn.example.com/media/uploads/a.png')
  })

  it('trims a trailing slash on MEDIA_PUBLIC_BASE and ignores BUCKET_NAME when set', () => {
    expect(buildMediaPublicUrl(env({ MEDIA_PUBLIC_BASE: 'https://cdn.example.com/media/', BUCKET_NAME: 'ignored' }), 'uploads/a.png'))
      .toBe('https://cdn.example.com/media/uploads/a.png')
  })

  it('supports a root-relative base (same-origin Worker serving)', () => {
    expect(buildMediaPublicUrl(env({ MEDIA_PUBLIC_BASE: '/media' }), 'uploads/a.png'))
      .toBe('/media/uploads/a.png')
  })
})
