/**
 * Fetches a workbook image as a data URL. Lives apart from the visual layer
 * so a picture inside a note can be shown the same way an in-cell picture is,
 * by id, without either place owning the other's component.
 */
import { useEffect, useState } from 'react'

/// Metafile mimes (EMF/WMF and their gzip-wrapped forms); same set as
/// @genoffice/docx-engine metafile (Apache-2.0). The browser build has no
/// EMF/WMF rasterizer, so a metafile part degrades to an empty frame.
const EMF_MIMES = new Set(['image/emf', 'image/x-emf'])
const WMF_MIMES = new Set(['image/wmf', 'image/x-wmf'])
const EMZ_MIMES = new Set(['image/emz', 'image/x-emz'])
const WMZ_MIMES = new Set(['image/wmz', 'image/x-wmz'])

function isMetafileMime(mime: string | undefined): boolean {
  return (
    mime !== undefined &&
    (EMF_MIMES.has(mime) || WMF_MIMES.has(mime) || EMZ_MIMES.has(mime) || WMZ_MIMES.has(mime))
  )
}

/// A workbook media part as a data URL; metafiles have no browser renderer.
/// Null when the bytes cannot be rendered.
export async function workbookMediaDataUrl(media: {
  readonly mediaType: string
  readonly base64: string
}): Promise<string | null> {
  if (isMetafileMime(media.mediaType)) return null
  return `data:${media.mediaType};base64,${media.base64}`
}

/// Lazily fetches a workbook image as a data URL (metafiles degrade to an
/// empty frame). Pass an undefined sessionId to skip fetching.
export function useWorkbookMediaUrl(
  sessionId: string | undefined,
  visualId: string,
): { url: string | null; unavailable: boolean } {
  const [url, setUrl] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (sessionId === undefined) return
    let isCurrent = true
    void window.desktopApi
      .readWorkbookMedia({ sessionId, visualId })
      .then(async (media) => {
        const next = await workbookMediaDataUrl(media)
        if (!isCurrent) return
        if (next) setUrl(next)
        else setUnavailable(true)
      })
      .catch((reason: unknown) => {
        // Unsupported or unreadable media degrades to an empty frame; the
        // grid must never show the failure text.
        console.warn(`workbook media unavailable (${visualId})`, reason)
        if (isCurrent) setUnavailable(true)
      })
    return () => {
      isCurrent = false
    }
  }, [sessionId, visualId])

  return { url, unavailable }
}
