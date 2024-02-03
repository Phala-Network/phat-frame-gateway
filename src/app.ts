import type { Result, Text, Enum } from '@polkadot/types-codec'
import type { Context } from 'hono'
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
    adapters: ['fs', 'redis'],
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

//

export async function runJs<TContext extends Context>(c: TContext) {
  if (!process.env.VAULT_REDIS_URI) {
    return c.body('Vault not yet setup.', 500)
  }
  const redis = new Redis(process.env.VAULT_REDIS_URI)

  try {
    const begin = Date.now()
    const cid = c.req.param('cid')

    const [code, abi] = await Promise.all([
      fetchIpfsFile(cid),
      fetchAbi('0xb4ed291971360ff5de17845f9922a2bd6930e411e32f33bf0a321735c3fab4a5'),
      cryptoWaitReady(),
    ])

    const fetched = Date.now()
    console.log(`fetching took ${fetched - begin}ms`)

    const client = await getClient(
      process.env.PHAT_CHAIN_RPC!,
      process.env.PHAT_PRUNTIME_URI!,
      process.env.PHAT_PRUNTIME_PUBKEY!,
    )
    const clientReady = Date.now()
    console.log(`client ready took ${clientReady - fetched}ms`)

    const contractId = process.env.JS_CONTRACT_ID!
    const contractKey = process.env.JS_CONTRACT_KEY!

    const provider = await KeyringPairProvider.createFromSURI(client.api, '//Alice')
    const contract = new PinkContractPromise(client.api, client, new Abi(abi), contractId, contractKey, provider)

    const keyringReady = Date.now()
    console.log(`keyring ready took ${keyringReady - clientReady}ms`)

    let body = undefined
    if (c.req.method === 'POST' || c.req.method === 'PATCH' || c.req.method === 'PUT') {
      const buffer = await c.req.arrayBuffer()
      body = Buffer.from(buffer).toString()
    }

    const key = c.req.param('key')
    let secret: any = undefined
    if (key) {
      const raw = await redis.get(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.data && parsed.cid === c.req.param('cid')) {
          secret = parsed.data
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

    const result = await contract.q.runJs<Result<RunResult, any>>({
      args: ['SidevmQuickJSWithPolyfill', code, [JSON.stringify(req)]]
    })
    let payload = {body: 'Script returns malformed response.', status: 400, headers: {}}
    try {
      payload = JSON.parse(result.output?.asOk.asOk.asString.toString() ?? '{}')
    } catch (err) {
      console.error(err)
    }

    const processed = Date.now()
    console.log(`processing took ${processed - keyringReady}ms`)

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
        const payload = JSON.stringify({
          token,
          cid,
          data: R.mergeDeepRight(parsed, data)
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
        return c.json({ data: parsed.data, succeed: true })
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
