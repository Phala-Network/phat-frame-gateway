import type { Result, Text, Enum } from '@polkadot/types-codec'
import type { Context } from 'hono'
import { startTime, endTime } from 'hono/timing'
import * as Bun from 'bun'
import { cryptoWaitReady } from '@polkadot/util-crypto'
import { HttpProvider, ApiPromise } from '@polkadot/api'
import { Abi } from '@polkadot/api-contract/Abi'
import { options, OnChainRegistry, KeyringPairProvider, unsafeGetAbiFromPatronByCodeHash, fetchMetadata, PinkContractPromise, type LiteralRpc } from '@phala/sdk'
import Redis from 'ioredis'
import * as z from 'zod'
import * as R from 'ramda'

import { memoize } from './memoize'

interface RunResult extends Enum {
  asString: Text
  asOther: Text

  isString: boolean
  isOther: boolean
}

const fetchAbi = memoize(
  {
    keyGen: (codeHash: string) => `abis/${codeHash}`,
    adapters: ['fs'],
  },
  unsafeGetAbiFromPatronByCodeHash
)

const fetchIpfsFile = memoize(
  {
    keyGen: (cid: string) => `ipfs/${cid}`,
    adapters: ['redis'],
  },
  (cid: string) => fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`).then(r => r.text()),
)

const memoizedFetchMetadata = memoize(
  {
    keyGen: (url: string) => `metadata/${url}`,
    adapters: ['redis'],
  },
  fetchMetadata
)

const getClient = memoize(
  {
    keyGen: (..._args) => 'client',
    adapters: ['memory'],
  },
  async (chainRpc: string, pruntimeUrl: string, pruntimePubkey: string) => {
    const http = chainRpc.replace('wss://', 'https://').replace('ws://', 'http://')
    const ws = chainRpc.replace('https://', 'wss://').replace('http://', 'ws://') as LiteralRpc
    const api = new ApiPromise(options({
      provider: new HttpProvider(http),
      metadata: await memoizedFetchMetadata(ws),
      noInitWarn: true,
    }))
    await api.isReady
    const client = new OnChainRegistry(api)
    await client.connect({
      clusterId: '0x0000000000000000000000000000000000000000000000000000000000000001',
      pubkey: pruntimePubkey,
      pruntimeURL: pruntimeUrl,
    })
    return client
  }
)

function inheritVault(parents: Record<string, any>, data: Record<string, any>) {
  return R.mergeDeepWith(
    (l, r) => Array.isArray(l) ? R.concat(l, r) : r,
    parents,
    data
  )
}

//

export async function runJs<TContext extends Context>(c: TContext) {
  if (!process.env.VAULT_REDIS_URI) {
    return c.body('Vault not yet setup.', 500)
  }
  const redis = new Redis(process.env.VAULT_REDIS_URI)

  try {
    const cid = c.req.param('cid')

    //
    // Boot
    //
    startTime(c, 'boot')
    const [code, abi, client] = await Promise.all([
      fetchIpfsFile(cid),
      fetchAbi('0xb4ed291971360ff5de17845f9922a2bd6930e411e32f33bf0a321735c3fab4a5'),
      getClient(
        process.env.PHAT_CHAIN_RPC!,
        process.env.PHAT_PRUNTIME_URI!,
        process.env.PHAT_PRUNTIME_PUBKEY!,
      ),
      cryptoWaitReady(),
    ])

    
    const contract = new PinkContractPromise(
      client.api,
      client,
      new Abi(abi),
      process.env.JS_CONTRACT_ID!,
      process.env.JS_CONTRACT_KEY!,
      await KeyringPairProvider.createFromSURI(client.api, '//Alice')
    )
    endTime(c, 'boot')

    //
    // Prepare payload
    //
    let body = undefined
    if (c.req.method === 'POST' || c.req.method === 'PATCH' || c.req.method === 'PUT') {
      const buffer = await c.req.arrayBuffer()
      body = Buffer.from(buffer).toString()
    }

    const key = c.req.query('key')
    let secret: any = undefined
    if (key) {
      const raw = await redis.get(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.data && parsed.cid === c.req.param('cid')) {
          secret = inheritVault(parsed.parents || {}, parsed.data)
        }
      }
    }

    const req = {
      method: c.req.method,
      path: c.req.path,
      // @ts-ignore
      headers: Object.fromEntries(c.req.raw.headers.entries()),
      body,
      secret: secret || undefined,
    }

    //
    // Transform to PRuntime Query and execute
    //
    startTime(c, 'execute')
    const result = await contract.q.runJs<Result<RunResult, any>>({
      args: ['SidevmQuickJSWithPolyfill', code, [JSON.stringify(req)]]
    })
    let payload = { body: 'Script returns malformed response.', status: 400, headers: {} }
    try {
      if (result.output.asOk.asOk.isString) {
        payload = JSON.parse(result.output?.asOk.asOk.asString.toString() ?? '{}')
      } else {
        payload.body =result.output.asOk.asOk.asOther.toString()
      }
    } catch (err) {
      console.error(err)
    }
    endTime(c, 'execute')

    return c.body(payload.body ?? '', payload.status ?? 200, payload.headers ?? {})
  } finally {
    redis.disconnect()
    redis.quit()
  }
}

//

export const secretSchema = z.object({
  cid: z.string(),
  data: z.any(),
  inherit: z.string().optional(),
})

export type Secret = z.infer<typeof secretSchema>

export async function saveSecret<TContext extends Context<any, any, { out: { json: Secret }}>>(c: TContext) {
  if (!process.env.VAULT_REDIS_URI) {
    return c.body('Vault not yet setup.', 500)
  }
  const redis = new Redis(process.env.VAULT_REDIS_URI)
  try {
    // @FIXME for now everyone can put anything into the vault
    const { cid, data, inherit } = c.req.valid('json')
    const token = Bun.hash(`${cid}:${Math.random()}:${Date.now()}`).toString(16)
    if (inherit) {
      const secret = await redis.get(inherit)
      if (secret) {
        const parsed = JSON.parse(secret)
        if (parsed.cid !== cid) {
          return c.json({ error: 'Inherit from different cid is not allow', succeed: false }, 403)
        }
        const payload = JSON.stringify({
          token,
          cid,
          parents: inheritVault(parsed.parents ?? {}, parsed.data),
          inherit,
          data,
        })
        const key = Bun.hash(`${cid}:${payload}`).toString(16)
        await redis.set(key, payload)
        return c.json({ token, key, succeed: true })
      } else {
        return c.json({ error: 'inherit not found', succeed: false }, 400)
      }
    } else {
      const payload = JSON.stringify({ token, cid, data })
      const key = Bun.hash(`${cid}:${payload}`).toString(16)
      await redis.set(key, payload)
      return c.json({ token, key, succeed: true })
    }
  } finally {
    redis.disconnect()
    redis.quit()
  }
}

//

export const visitSecretSchema = z.object({
  key: z.string(),
  token: z.string(),
})

export type VisitSecret = z.infer<typeof visitSecretSchema>

export async function getSecret<TContext extends Context<any, any, { out: { param: VisitSecret }}>>(c: TContext) {
  if (!process.env.VAULT_REDIS_URI) {
    return c.body('Vault not yet setup.', 500)
  }
  const redis = new Redis(process.env.VAULT_REDIS_URI)
  try {
    const { key, token } = c.req.valid('param')
    const raw = await redis.get(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.token === token) {
        return c.json({ data: parsed.data, inherit: parsed.inherit, succeed: true })
      } else {
        return c.json({ error: 'access denied', succeed: false }, 403)
      }
    } else {
      return c.json({ error: 'not found', succeed: false }, 404)
    }
  } finally {
    redis.disconnect()
    redis.quit()
  }
}
