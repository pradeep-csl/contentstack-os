import { useEffect, useState } from 'react'
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
}) {
  const serverConfig = useServerConfig()
  const configuredUrl = serverConfig?.siteLogo?.url
  const src = srcOverride === undefined ? configuredUrl : srcOverride ?? undefined
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src, serverConfig])

  // An admin-uploaded logo always wins; otherwise fall back to the Contentstack mark.
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
