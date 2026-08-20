import { Loader } from '@cloudflare/kumo'
import { Hexagon } from '@phosphor-icons/react'
import type { ChatMessage as ChatMessageType } from '../../data/chat'
import ToolCallCard from './ToolCallCard'

function AssistantAvatar() {
  return (
    <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-kumo-brand">
      <Hexagon size={12} className="text-kumo-inverse" weight="bold" />
    </div>
  )
}

function UserAvatar() {
  return (
    <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-kumo-tint">
      <span className="text-ui-2xs text-kumo-strong">U</span>
    </div>
  )
}

/** Render markdown-ish content: bold, code, backtick blocks, bullets */
function RichContent({ text }: { text: string }) {
  const parts = text.split(/(\*\*.*?\*\*|`[^`]+`|\n)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part === '\n') return <br key={i} />
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={i} className="font-semibold text-kumo-default">
              {part.slice(2, -2)}
            </strong>
          )
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code
              key={i}
              className="text-ui-2xs px-1 py-0.5 rounded bg-kumo-tint font-mono text-kumo-brand"
            >
              {part.slice(1, -1)}
            </code>
          )
        }
        if (part.startsWith('- ')) {
          return (
            <span key={i} className="block pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.55em] before:w-1 before:h-1 before:rounded-full before:bg-kumo-subtle">
              {part.slice(2)}
            </span>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

export default function ChatMessage({ message }: { message: ChatMessageType }) {
  const isUser = message.role === 'user'

  return (
    <div className="flex gap-3 items-start">
      {isUser ? <UserAvatar /> : <AssistantAvatar />}

      <div className="flex-1 min-w-0 space-y-2">
        {/* Role + time */}
        <div className="flex items-center gap-2">
          <span className="text-ui-xs font-semibold text-kumo-default">
            {isUser ? 'You' : 'Workshop'}
          </span>
          <span className="font-mono text-ui-xs text-kumo-subtle">{message.timestamp}</span>
        </div>

        {/* Content */}
        <div className="text-ui-md leading-relaxed text-kumo-default">
          <RichContent text={message.content} />
          {message.isStreaming && (
            <span className="inline-flex items-center ml-1.5">
              <Loader size="sm" />
            </span>
          )}
        </div>

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1.5 mt-2">
            {message.toolCalls.map((tool) => (
              <ToolCallCard key={tool.id} tool={tool} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
