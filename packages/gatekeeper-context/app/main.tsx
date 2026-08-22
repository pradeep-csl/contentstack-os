// Entrypoint for the sandboxed Context Library iframe. All data flows through the host-injected
// ContextApi RPC capability.

import { createRoot } from 'react-dom/client'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcTarget, newMessagePortRpcSession } from 'capnweb'
import type { RpcStub } from 'capnweb'
import type { ContextApi } from '../src/context-types'
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from '@gadgets/workshop-shared/theme'
import ContextLibraryPage from './ContextLibraryPage'
import {
  ContextApiProvider,
  PresentationProvider,
  WorkspaceHostProvider,
  type PresentAck,
} from './bridge'
import { applyAppTheme } from './theme'
import './styles.css'
import ErrorBoundary from './ErrorBoundary'
import { installErrorReporting, reportIssue } from './error-reporting'

installErrorReporting()

// The only capability the iframe exposes back to the host: a receiver for theme pushes.
class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme)
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<ContextApi>
  // Grow the iframe to a full-viewport overlay for app-level modals (`true`) or restore it (`false`).
  setPresenting(active: boolean): Promise<PresentAck>
  // Returns the current theme and calls back on `receiver` whenever it changes.
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>
  // Presents the Workshop's workspace picker; resolves to the chosen workspace or null.
  pickWorkspace(): Promise<{ id: string; title: string } | null>
  // Resolves workspace ids this app already holds to their live titles.
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>
}

function main() {
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')

  const { port1, port2 } = new MessageChannel()
  // Opaque-origin iframes can't name their parent origin. The parent accepts this handshake only from
  // this frame + null origin; the message only transfers a private port.
  window.parent.postMessage({ type: 'handshake' }, '*', [port2])
  const iframe = new AppIframe()
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe)
  // The initial theme comes back from the call; later changes arrive via iframe.setTheme().
  host.subscribeTheme(iframe).then(applyAppTheme).catch(() => {})

  createRoot(root, {
    onUncaughtError: (error) => reportIssue('context.react-root', error, {
      handled: false, severity: 'fatal', captureMechanism: 'react',
    }),
  }).render(
    <ErrorBoundary><ContextApiProvider value={host.ui}>
      <PresentationProvider setPresenting={(active) => host.setPresenting(active)}>
        <WorkspaceHostProvider
          pickWorkspace={() => host.pickWorkspace()}
          resolveWorkspaceTitles={(ids) => host.resolveWorkspaceTitles(ids)}
        >
          <TooltipProvider>
            <Toasty>
              <ContextLibraryPage />
            </Toasty>
          </TooltipProvider>
        </WorkspaceHostProvider>
      </PresentationProvider>
    </ContextApiProvider></ErrorBoundary>,
  )
}

main()
