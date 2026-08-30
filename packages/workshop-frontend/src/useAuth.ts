import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { classifyRpcError } from './rpcErrors'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
}

export { CF_ACCESS_MODE }

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null
  })

  // Track current authenticated API stub for cleanup on unmount.
  // State closures go stale in cleanup functions, so we use a ref.
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  authenticatedApiRef.current = authState.authenticatedApi

  /**
   * Names the signed-in user on error reports, for as long as this stub is the current one.
   *
   * Keyed on the stub rather than called from each authenticate path, so it covers however the
   * session was established — stored token, inline login, or CF Access. This is why the claim lives
   * in the hook and not in `AuthProvider`: the public blueprint page renders outside that provider
   * and logs in inline, so reports from the rest of its session would otherwise name nobody.
   *
   * `whoami` is pipelined rather than awaited, so its answer can outlive the session that asked.
   * The cleanup drops it when the stub is replaced or cleared, which is what stops a logout or a
   * newer login from being overwritten by the previous user. Disposal would not be enough on its
   * own: capnweb does not guarantee that disposing a stub rejects calls already in flight.
   *
   * Cleanup also runs on unmount, and two instances of this hook can be mounted at once — the
   * blueprint page runs its own inside the root's — so an inner one going away must not blank an
   * identity the outer still holds, which is what `cancelled` guards.
   *
   * This call doubles as the session's liveness probe. `publicApi.authenticate()` is pipelined, so
   * its stub is truthy before the server has accepted the token; without watching a real call, a
   * token the server rejects leaves the app rendering its authenticated shell and the rejection
   * surfaces later as unexplained failures on whatever the app calls first. `whoami` is that call,
   * and it is the one already being made — probing with a second call would only add traffic.
   */
  useEffect(() => {
    const authenticatedApi = authState.authenticatedApi
    if (!authenticatedApi) return
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      // Only a real user account names a person: for a gadget author `id` is its owner's id.
      if (!cancelled && info.type === 'user') setReportedUserId(info.id)
    }).catch((err: unknown) => {
      // A session the server refuses ends here, which drops the root back to the login page. That
      // page renders in place at the current URL, so signing in again returns the user to the page
      // they were on, and a first-time account still meets the onboarding gate.
      //
      // Only auth failures qualify. A lost connection belongs to the connection manager, which
      // reconnects and re-authenticates with the same token; signing the user out for it would be
      // its own bug. Access sessions are exempt because they carry no local token to forget and
      // have no login page to fall back to — clearing one would strand the user on a spinner.
      if (cancelled || CF_ACCESS_MODE || classifyRpcError(err) !== 'auth') return
      clearSession()
    })
    return () => { cancelled = true }
  }, [authState.authenticatedApi])

  useEffect(() => {
    if (CF_ACCESS_MODE) {
      authenticateWithCfAccess()
    } else {
      const storedToken = localStorage.getItem('authToken')
      if (storedToken) {
        authenticateWithToken(storedToken)
      } else {
        setAuthState(prev => ({ ...prev, isLoading: false }))
      }
    }
    return () => {
      // The authenticateWithXxx functions also dispose the old stub via their setAuthState
      // updater, so this may double-dispose on reconnect. That's fine — dispose is idempotent.
      authenticatedApiRef.current?.[Symbol.dispose]()
    }
  }, [publicApi])

  const authenticateWithCfAccess = () => {
    setAuthState(prev => {
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return { ...prev, authenticatedApi: null, isLoading: true, error: null }
    })

    // Use promise pipelining - no need to await. The CF Access JWT is already attached
    // to the request by the browser (injected by the Access service worker/cookie), so
    // the server validates it and returns an authenticated stub immediately.
    const authenticatedApi = publicApi.authenticateFromCfAccess()
    setAuthState({
      token: null,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  /**
   * Drop the session locally: release the stub, forget the stored token, and stop naming the user
   * on error reports. Shared by an explicit logout and by a session the server no longer accepts.
   */
  const clearSession = () => {
    setReportedUserId(undefined)

    setAuthState(prev => {
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return {
        token: null,
        authenticatedApi: null,
        isLoading: false,
        error: null
      }
    })

    localStorage.removeItem('authToken')
  }

  const authenticateWithToken = (token: string) => {
    setAuthState(prev => {
      // Dispose the previous authenticated API stub if it exists
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return {
        ...prev,
        authenticatedApi: null, // Clear the disposed stub
        isLoading: true,
        error: null
      }
    })

    // Use promise pipelining - we can use the returned promise as a stub immediately
    // without awaiting, so the app renders without waiting for a round trip.
    const authenticatedApi = publicApi.authenticate(token)
    setAuthState({
      token,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  const login = (token: string) => {
    authenticateWithToken(token)
  }

  const logout = () => {
    if (CF_ACCESS_MODE) {
      setReportedUserId(undefined)
      window.location.assign('/cdn-cgi/access/logout')
      return
    }

    clearSession()
  }

  return {
    ...authState,
    login,
    logout,
    isAuthenticated: !!authState.authenticatedApi
  }
}
