/**
 * Test fixtures wiring a ToolDispatcher to a FakeCdpClient through a fake
 * HostBridge — no Chrome, no socket, no DSH process involvement.
 *
 * @module dsh-chrome-cdp/tests/fixtures
 */

import { ToolDispatcher } from '../src/tools/dispatch.ts'
import type { HostBridge } from '../src/tools/dispatch.ts'
import type { CdpStatus, CdpTargetInfo } from '../src/types.ts'
import { FakeCdpClient } from './fake-client.ts'

/** Minimal CdpStatus stub. */
export function fakeStatus(overrides: Partial<CdpStatus> = {}): CdpStatus {
  return {
    phase: 'connected',
    host: '127.0.0.1',
    port: 9222,
    autoReconnect: true,
    error: null,
    lastDisconnect: null,
    ...overrides,
  }
}

/** One page target as /json/list reports it. */
export function pageTarget(overrides: Partial<CdpTargetInfo> = {}): CdpTargetInfo {
  return {
    id: overrides.id ?? 'target-1',
    type: 'page',
    title: 'Test Page',
    url: 'https://example.test/app.html',
    description: '',
    devtoolsFrontendUrl: '',
    faviconUrl: '',
    wsDebuggerUrl: '',
  }
}

export interface Fixture {
  client: FakeCdpClient
  dispatcher: ToolDispatcher
  /** Emit Target.attachedToTarget the way CRI/Chrome would. */
  attach(targetId: string, sessionId: string): void
  /** Update the bridge status (e.g. phase: 'disconnected'). */
  setStatus(phase: CdpStatus['phase']): void
  /** Set the /json/list payload. */
  setTargets(targets: CdpTargetInfo[]): void
}

/** Build the dispatcher-under-test. */
export function makeFixture(options: {
  targets?: CdpTargetInfo[]
  status?: Partial<CdpStatus>
} = {}): Fixture {
  const client = new FakeCdpClient()
  let targets: CdpTargetInfo[] = options.targets ?? [pageTarget()]
  let status: CdpStatus = fakeStatus(options.status)
  const bridge: HostBridge = {
    getClient: () => client,
    getStatus: () => status,
    listTargets: async () => targets,
    persistImage: async () => undefined,
    attachmentsAvailable: () => false,
  }
  const dispatcher = new ToolDispatcher(bridge)
  return {
    client,
    dispatcher,
    attach(targetId: string, sessionId: string): void {
      client.emit('Target.attachedToTarget', {
        sessionId,
        targetInfo: { targetId },
      })
    },
    setStatus(phase: CdpStatus['phase']): void {
      status = fakeStatus({ ...options.status, phase })
    },
    setTargets(next: CdpTargetInfo[]): void {
      targets = next
    },
  }
}
