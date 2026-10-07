import { v } from "convex/values"
import { internalMutation, internalQuery } from "../_generated/server"

/**
 * The bookkeeping behind `POST /api/pipeline/files` (convex/http.ts), which
 * decodes and stores the bytes itself — `ctx.storage.store` exists only in
 * actions. These two functions de-duplicate by content hash, so a logo
 * uploaded on every run is stored once.
 */

/** Largest file the pipeline may upload: logos and event images, not media. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

/** Raster images plus PDF (termcards). No SVG: it can carry script. */
export const ALLOWED_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "application/pdf",
] as const

/** The type the leading bytes identify, among the accepted ones, or null. */
export function sniffContentType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte)
  const ascii = (offset: number, text: string) =>
    [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0))
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif"
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp"
  if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) return "image/avif"
  if (ascii(0, "%PDF-")) return "application/pdf"
  return null
}

export const findBySha256 = internalQuery({
  args: { sha256: v.string() },
  returns: v.union(v.null(), v.id("_storage")),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("storedFiles")
      .withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
      .first()
    return row?.storageId ?? null
  },
})

/**
 * Records a stored file. If a concurrent upload of the same bytes won the
 * race, the duplicate blob is deleted and the existing id returned.
 */
export const record = internalMutation({
  args: {
    sha256: v.string(),
    storageId: v.id("_storage"),
    contentType: v.string(),
    size: v.number(),
  },
  returns: v.object({ storageId: v.id("_storage"), deduplicated: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("storedFiles")
      .withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
      .first()
    if (existing && existing.storageId !== args.storageId) {
      await ctx.storage.delete(args.storageId)
      return { storageId: existing.storageId, deduplicated: true }
    }
    if (!existing) await ctx.db.insert("storedFiles", { ...args, createdAt: Date.now() })
    return { storageId: args.storageId, deduplicated: false }
  },
})
