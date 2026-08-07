import { useEffect, useState, type ReactNode } from 'react'
import { useServerConfig } from '../ServerConfigContext'
import ContentstackMark from './ContentstackMark'

export default function SiteLogo({
  size,
  className,
  srcOverride,
}: {
  size: number
  className?: string
  srcOverride?: string | null
  /**
   * @deprecated No longer rendered. SiteLogo falls back to the ContentstackMark itself so every
   * call site gets the mark uniformly; this stays in the prop type purely so existing call sites
   * (which still pass a Phosphor icon here) keep compiling unchanged.
   */
  children?: ReactNode
}) {
  const serverConfig = useServerConfig()
  const configuredUrl = serverConfig?.siteLogo?.url
  const src = srcOverride === undefined ? configuredUrl : srcOverride ?? undefined
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src, serverConfig])

  // An admin-uploaded logo always wins; otherwise fall back to the Contentstack mark rather
  // than whatever the caller passed as children (see the deprecation note above).
  if (!src || failed) return <ContentstackMark size={size} className={className} />
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`object-contain ${className ?? ''}`}
      onError={() => setFailed(true)}
    />
  )
}
