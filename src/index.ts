import type { Result, Text, Enum } from '@polkadot/types-codec'

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cryptoWaitReady } from '@polkadot/util-crypto'
import { HttpProvider, ApiPromise } from '@polkadot/api'
import { Abi } from '@polkadot/api-contract/Abi'
import { options, OnChainRegistry, KeyringPairProvider, unsafeGetAbiFromPatronByCodeHash, fetchMetadata, PinkContractPromise } from '@phala/sdk'

const app = new Hono()

interface RunResult extends Enum {
  asString: Text
}


function asyncMemoizeWith<TResult = unknown, TArgs extends Array<any> = any[]>(keyGen: (...args: TArgs) => string, asyncFn: (...args: TArgs) => Promise<TResult>) {
  const cache = new Map()
  return async function (...args: TArgs) {
    const key = keyGen.apply(null, args)
    if (cache.has(key)) {
      console.log(`cache hit: ${key}`)
      return cache.get(key)
    }
    console.log(`cache miss: ${key}`)
    const result = await asyncFn.apply(null, args)
    cache.set(key, result)
    return result
  }
}

const fetchAbi = asyncMemoizeWith(i => `${i}`, unsafeGetAbiFromPatronByCodeHash)

const fetchIpfsFile = asyncMemoizeWith(i => `${i}`, (cid) => fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`).then(r => r.text()))

const memoizeFetchMetadata = asyncMemoizeWith(i => `${i}`, fetchMetadata)

//

let _instance: OnChainRegistry | null = null

async function getClientSingleton() {
  if (_instance === null) {
    const api = new ApiPromise(options({
      provider: new HttpProvider('https://poc6.phala.network/ws'),
      metadata: await memoizeFetchMetadata('wss://poc6.phala.network/ws'),
      noInitWarn: true,
    }))
    await api.isReady
    const client = new OnChainRegistry(api)
    await client.connect({
      clusterId: '0x0000000000000000000000000000000000000000000000000000000000000001',
      pubkey: '0x923462b42d2213bcd908cf56e469e5404708b9020ca462f4b0441e4a53b0ab6c',
      pruntimeURL: 'https://poc6.phala.network/pruntime/0x923462b4',
    })
    _instance = client
  }
  return _instance
}

//

app.all('/run_js_from_ipfs/:cid/:id?', async (c) => {
  const begin = Date.now()

  const [code, abi] = await Promise.all([
    fetchIpfsFile(c.req.param('cid')),
    fetchAbi('0xb4ed291971360ff5de17845f9922a2bd6930e411e32f33bf0a321735c3fab4a5'),
    cryptoWaitReady(),
  ])

  const fetched = Date.now()
  console.log(`fetching took ${fetched - begin}ms`)

  const client = await getClientSingleton()
  const clientReady = Date.now()
  console.log(`client ready took ${clientReady - fetched}ms`)

  const contractId = '0xf0a398600f02ea9b47a86c59aed61387e450e2a99cb8b921cd1d46f734e45409'
  const contractKey = '0x64fb31ec8dd6aebb8889ca3678f21696d8348e796966a963904b70f557a2331d'

  const provider = await KeyringPairProvider.createFromSURI(client.api, '//Alice')
  const contract = new PinkContractPromise(client.api, client, new Abi(abi), contractId, contractKey, provider)

  const keyringReady = Date.now()
  console.log(`keyring ready took ${keyringReady - clientReady}ms`)

  let body = undefined
  if (c.req.method === 'POST' || c.req.method === 'PATCH' || c.req.method === 'PUT') {
    const buffer = await c.req.arrayBuffer()
    body = Buffer.from(buffer).toString()
  }

  const req = {
    method: c.req.method,
    path: c.req.path,
    // @ts-ignore
    headers: Object.fromEntries(c.req.raw.headers.entries()),
    body,
    id: c.req.param('id') ?? '',
  }

  const result = await contract.q.runJs<Result<RunResult, any>>({
    args: ['SidevmQuickJSWithPolyfill', code, [JSON.stringify(req)]]
  })
  const payload = JSON.parse(result.output?.asOk.asOk.asString.toString() ?? '{}')

  const processed = Date.now()
  console.log(`processing took ${processed - keyringReady}ms`)

  return c.body(payload.body ?? '', payload.status ?? 200, payload.headers ?? {})
})

serve(app)
