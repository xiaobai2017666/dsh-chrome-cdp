/** Tests for the `connection.rpc.handle()` compatibility shim. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handleRpcChannel } from '../src/rpc-shim.ts'
import type { RpcHandlerLike, RpcOptions } from '../src/rpc-shim.ts'

/** Build an error matching cordis' exact diagnostic text. */
function injectError(): Error {
  return new Error('cannot get property "webServer" without inject')
}

const OPTIONS: RpcOptions = { authority: 'trusted-host' }
const CHANNEL = '/cdp'
const noopHandler: RpcHandlerLike = async () => ({ ok: true, value: undefined })
const asyncNoop = () => Promise.resolve()

describe('handleRpcChannel — healthy path', () => {
  it('uses ctx.connection.rpc.handle and returns its disposer', async () => {
    const calls: string[] = []
    const disposer = async () => {}
    const ctx = {
      connection: {
        rpc: {
          handle: (channel: string, handler: unknown, options: unknown) => {
            calls.push(`handle:${channel}:${typeof handler}:${JSON.stringify(options)}`)
            return disposer
          },
        },
      },
      webServer: { register: () => asyncNoop },
    }
    const result = handleRpcChannel(ctx, CHANNEL, noopHandler, OPTIONS)
    assert.equal(result, disposer)
    assert.deepEqual(calls, [`handle:/cdp:function:${JSON.stringify(OPTIONS)}`])
  })

  it('does not fall back when a non-inject error is thrown', () => {
    const ctx = {
      connection: {
        rpc: {
          handle: () => {
            throw new Error('some other failure')
          },
        },
      },
      webServer: { register: () => asyncNoop },
    }
    assert.throws(() => handleRpcChannel(ctx, CHANNEL, noopHandler, OPTIONS), /some other failure/)
  })

  it('propagates inject errors when the fallback is impossible', () => {
    const service = { rpc: null, register: undefined }
    const ctx = { connection: service, webServer: undefined }
    // `.rpc` read itself throws via a getter; register() absent → rethrow.
    const throwing = {
      get rpc(): never {
        throw injectError()
      },
    }
    assert.throws(
      () => handleRpcChannel({ ...ctx, connection: throwing }, CHANNEL, noopHandler, OPTIONS),
      /without inject/,
    )
  })
})

describe('handleRpcChannel — fallback path', () => {
  it('retries via service.register with an owner overlaying webServer', async () => {
    let captured: { owner: unknown; channel: string; handler: unknown } | undefined
    const service = () => {
      throw injectError()
    }
    const rawService = {
      register(owner: unknown, channel: string, handler: unknown) {
        captured = { owner, channel, handler }
        return asyncNoop
      },
    }
    const webServer = { register: () => asyncNoop }
    const ctx = {
      connection: new Proxy(rawService, {
        get(target, prop, receiver) {
          if (prop === 'rpc') return service()
          return Reflect.get(target, prop, receiver)
        },
      }),
      webServer,
    }
    const disposer = handleRpcChannel(ctx, CHANNEL, noopHandler, OPTIONS)
    assert.equal(disposer, asyncNoop)
    assert.ok(captured)
    assert.equal(captured.channel, CHANNEL)
    assert.equal(captured.handler, noopHandler)
    // Overlay serves webServer, delegates everything else to the plugin ctx.
    const owner = captured.owner as Record<PropertyKey, unknown>
    assert.equal(owner.webServer, webServer)
  })

  it('owner overlay delegates non-webServer reads to the plugin context', async () => {
    const rawService = {
      register(owner: unknown) {
        // The real register() reads owner.effect(...) etc; prove the
        // overlay forwards such reads to the plugin context.
        const read = (owner as Record<string, () => string>).label()
        return () => read
      },
    }
    const ctx = {
      connection: new Proxy(rawService, {
        get(target, prop, receiver) {
          // Faithful simulation: only the `rpc` getter's webServer read
          // throws; other members (register) resolve normally.
          if (prop === 'rpc') {
            throw injectError()
          }
          return Reflect.get(target, prop, receiver)
        },
      }),
      webServer: {},
      label: () => 'from-plugin-ctx',
    }
    const disposer = handleRpcChannel(ctx, CHANNEL, noopHandler, OPTIONS) as () => string
    assert.equal(disposer(), 'from-plugin-ctx')
  })

  it('peels traceable proxies to find register()', async () => {
    const rawService = {
      register(owner: unknown, channel: string) {
        assert.equal(channel, CHANNEL)
        return asyncNoop
      },
    }
    const wrapped = new Proxy(rawService, {
      get(target, prop) {
        if (prop === Symbol.for('cordis.original')) return target
        return Reflect.get(target, prop)
      },
    })
    const ctx = {
      connection: new Proxy(wrapped, {
        get(target, prop, receiver) {
          if (prop === 'rpc') {
            throw injectError()
          }
          return Reflect.get(target, prop, receiver)
        },
      }),
      webServer: {},
    }
    assert.doesNotThrow(() => handleRpcChannel(ctx, CHANNEL, noopHandler, OPTIONS))
  })

  it('throws a diagnostic when neither path can register', () => {
    const ctx = {
      connection: {
        get rpc(): never {
          throw injectError()
        },
      },
      webServer: { register: () => asyncNoop },
    }
    assert.throws(() => handleRpcChannel(ctx, CHANNEL, noopHandler, OPTIONS), /dsh-chrome-cdp/)
  })
})
