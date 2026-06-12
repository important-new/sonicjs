import { Hono } from 'hono'
import { requireAuth, requireRole } from '../middleware'
import { getCacheService, CACHE_CONFIGS } from '../services'
import { runHook } from '../plugins/core-hooks'
import { HOOKS } from '../types'
import type { Bindings, Variables } from '../app'
import { resolveContentVariables } from '../plugins/core-plugins/global-variables-plugin/variable-resolver'

/** Normalize a raw `content` DB row into the hook payload shape. */
function toHookRecord(row: any) {
  return {
    id: row.id,
    collectionId: row.collection_id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    data: row.data ? JSON.parse(row.data) : {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const apiContentCrudRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/content/check-slug - Check if slug is available in collection
// Query params: collectionId, slug, excludeId (optional - when editing)
// NOTE: This MUST come before /:id route to avoid route conflict
apiContentCrudRoutes.get('/check-slug', async (c) => {
  try {
    const db = c.env.DB
    const collectionId = c.req.query('collectionId')
    const slug = c.req.query('slug')
    const excludeId = c.req.query('excludeId') // When editing, exclude current item
    
    if (!collectionId || !slug) {
      return c.json({ error: 'collectionId and slug are required' }, 400)
    }
    
    // Check for existing content with this slug in the collection
    let query = 'SELECT id FROM content WHERE collection_id = ? AND slug = ?'
    const params: string[] = [collectionId, slug]
    
    if (excludeId) {
      query += ' AND id != ?'
      params.push(excludeId)
    }
    
    const existing = await db.prepare(query).bind(...params).first()
    
    if (existing) {
      return c.json({ 
        available: false, 
        message: 'This URL slug is already in use in this collection' 
      })
    }
    
    return c.json({ available: true })
  } catch (error: unknown) {
    console.error('Error checking slug:', error)
    return c.json({ 
      error: 'Failed to check slug availability',
      details: error instanceof Error ? error.message : String(error)
    }, 500)
  }
})

// GET /api/content/:id - Get single content item by ID
apiContentCrudRoutes.get('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const db = c.env.DB

    const stmt = db.prepare('SELECT * FROM content WHERE id = ?')
    const content = await stmt.bind(id).first()

    if (!content) {
      return c.json({ error: 'Content not found' }, 404)
    }

    const transformedContent = {
      id: (content as any).id,
      title: (content as any).title,
      slug: (content as any).slug,
      status: (content as any).status,
      collectionId: (content as any).collection_id,
      data: (content as any).data ? JSON.parse((content as any).data) : {},
      created_at: (content as any).created_at,
      updated_at: (content as any).updated_at
    }

    // Resolve {variable_key} tokens in content data
    const resolveVars = c.req.query('resolve_variables') !== 'false'
    if (resolveVars) {
      transformedContent.data = await resolveContentVariables(transformedContent.data, db)
    }

    return c.json({ data: transformedContent })
  } catch (error) {
    console.error('Error fetching content:', error)
    return c.json({
      error: 'Failed to fetch content',
      details: error instanceof Error ? error.message : String(error)
    }, 500)
  }
})

// POST /api/content - Create new content (requires authentication)
apiContentCrudRoutes.post('/', requireAuth(), requireRole(['admin', 'editor', 'author']), async (c) => {
  try {
    const db = c.env.DB
    const user = c.get('user')
    const body = await c.req.json()

    const { collectionId, title, slug, status, data } = body

    // Validate required fields
    if (!collectionId) {
      return c.json({ error: 'collectionId is required' }, 400)
    }

    if (!title) {
      return c.json({ error: 'title is required' }, 400)
    }

    // Generate slug from title if not provided
    let finalSlug = slug || title
    finalSlug = finalSlug.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim()

    // Check for duplicate slug within the same collection
    const duplicateCheck = db.prepare(
      'SELECT id FROM content WHERE collection_id = ? AND slug = ?'
    )
    const existing = await duplicateCheck.bind(collectionId, finalSlug).first()

    if (existing) {
      return c.json({ error: 'A content item with this slug already exists in this collection' }, 409)
    }

    // Create new content
    const contentId = crypto.randomUUID()
    const now = Date.now()

    // content:save hook (before write) — handlers may mutate fields, e.g. derive
    // a value such as an OG image and write it back into `data` before insert.
    const saved = await runHook(HOOKS.CONTENT_SAVE, {
      id: contentId,
      collectionId,
      title,
      slug: finalSlug,
      status: status || 'draft',
      data: data || {},
      operation: 'create' as const,
    }, { env: c.env, user })

    const insertStmt = db.prepare(`
      INSERT INTO content (
        id, collection_id, slug, title, data, status,
        author_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    await insertStmt.bind(
      contentId,
      saved.collectionId ?? collectionId,
      saved.slug ?? finalSlug,
      saved.title ?? title,
      JSON.stringify(saved.data ?? {}),
      saved.status ?? 'draft',
      user?.userId || 'system',
      now,
      now
    ).run()

    // Invalidate cache
    const cache = getCacheService(CACHE_CONFIGS.api!)
    await cache.invalidate(`content:list:${collectionId}:*`)
    await cache.invalidate('content-filtered:*')

    // Get the created content
    const getStmt = db.prepare('SELECT * FROM content WHERE id = ?')
    const createdContent = await getStmt.bind(contentId).first() as any

    // content:create hook (after write) — notification with the saved record.
    await runHook(HOOKS.CONTENT_CREATE, toHookRecord(createdContent), { env: c.env, user })

    return c.json({
      data: {
        id: createdContent.id,
        title: createdContent.title,
        slug: createdContent.slug,
        status: createdContent.status,
        collectionId: createdContent.collection_id,
        data: createdContent.data ? JSON.parse(createdContent.data) : {},
        created_at: createdContent.created_at,
        updated_at: createdContent.updated_at
      }
    }, 201)
  } catch (error) {
    console.error('Error creating content:', error)
    return c.json({
      error: 'Failed to create content',
      details: error instanceof Error ? error.message : String(error)
    }, 500)
  }
})

// PUT /api/content/:id - Update content (requires authentication)
apiContentCrudRoutes.put('/:id', requireAuth(), requireRole(['admin', 'editor', 'author']), async (c) => {
  try {
    const id = c.req.param('id')
    const db = c.env.DB
    const body = await c.req.json()

    // Check if content exists
    const existingStmt = db.prepare('SELECT * FROM content WHERE id = ?')
    const existing = await existingStmt.bind(id).first() as any

    if (!existing) {
      return c.json({ error: 'Content not found' }, 404)
    }

    // Compute the next state (body fields override the existing row), then run
    // the content:save hook (before write) so handlers may mutate fields — the
    // returned values are what get persisted. Unprovided fields fall back to the
    // existing row, so the result is equivalent to the previous partial update.
    const slugify = (s: string) => s.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim()

    const saved = await runHook(HOOKS.CONTENT_SAVE, {
      id,
      collectionId: existing.collection_id,
      title: body.title !== undefined ? body.title : existing.title,
      slug: body.slug !== undefined ? slugify(body.slug) : existing.slug,
      status: body.status !== undefined ? body.status : existing.status,
      data: body.data !== undefined ? body.data : (existing.data ? JSON.parse(existing.data) : {}),
      operation: 'update' as const,
    }, { env: c.env, user: c.get('user') })

    // Execute update
    const now = Date.now()
    const updateStmt = db.prepare(`
      UPDATE content SET title = ?, slug = ?, status = ?, data = ?, updated_at = ?
      WHERE id = ?
    `)

    await updateStmt.bind(
      saved.title,
      saved.slug,
      saved.status,
      JSON.stringify(saved.data ?? {}),
      now,
      id
    ).run()

    // Invalidate cache
    const cache = getCacheService(CACHE_CONFIGS.api!)
    await cache.delete(cache.generateKey('content', id))
    await cache.invalidate(`content:list:${existing.collection_id}:*`)
    await cache.invalidate('content-filtered:*')

    // Get updated content
    const getStmt = db.prepare('SELECT * FROM content WHERE id = ?')
    const updatedContent = await getStmt.bind(id).first() as any

    // content:update hook (after write) — notification with the saved record.
    await runHook(HOOKS.CONTENT_UPDATE, toHookRecord(updatedContent), { env: c.env, user: c.get('user') })

    return c.json({
      data: {
        id: updatedContent.id,
        title: updatedContent.title,
        slug: updatedContent.slug,
        status: updatedContent.status,
        collectionId: updatedContent.collection_id,
        data: updatedContent.data ? JSON.parse(updatedContent.data) : {},
        created_at: updatedContent.created_at,
        updated_at: updatedContent.updated_at
      }
    })
  } catch (error) {
    console.error('Error updating content:', error)
    return c.json({
      error: 'Failed to update content',
      details: error instanceof Error ? error.message : String(error)
    }, 500)
  }
})

// DELETE /api/content/:id - Delete content (requires authentication)
apiContentCrudRoutes.delete('/:id', requireAuth(), requireRole(['admin', 'editor', 'author']), async (c) => {
  try {
    const id = c.req.param('id')
    const db = c.env.DB

    // Check if content exists
    const existingStmt = db.prepare('SELECT * FROM content WHERE id = ?')
    const existing = await existingStmt.bind(id).first() as any

    if (!existing) {
      return c.json({ error: 'Content not found' }, 404)
    }

    // content:delete hook (before delete) — handlers can clean up derived
    // assets (e.g. a generated OG image in R2) using the record being removed.
    await runHook(HOOKS.CONTENT_DELETE, toHookRecord(existing), { env: c.env, user: c.get('user') })

    // Delete the content (hard delete for API, soft delete happens in admin routes)
    const deleteStmt = db.prepare('DELETE FROM content WHERE id = ?')
    await deleteStmt.bind(id).run()

    // Invalidate cache
    const cache = getCacheService(CACHE_CONFIGS.api!)
    await cache.delete(cache.generateKey('content', id))
    await cache.invalidate(`content:list:${existing.collection_id}:*`)
    await cache.invalidate('content-filtered:*')

    return c.json({ success: true })
  } catch (error) {
    console.error('Error deleting content:', error)
    return c.json({
      error: 'Failed to delete content',
      details: error instanceof Error ? error.message : String(error)
    }, 500)
  }
})

export default apiContentCrudRoutes
