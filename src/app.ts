import type { Result, Text, Enum } from '@polkadot/types-codec'
import type { Context } from 'hono'

import { cryptoWaitReady } from '@polkadot/util-crypto'
import { HttpProvider, ApiPromise } from '@polkadot/api'
import { Abi } from '@polkadot/api-contract/Abi'
import { options, OnChainRegistry, KeyringPairProvider, unsafeGetAbiFromPatronByCodeHash, fetchMetadata, PinkContractPromise, type LiteralRpc } from '@phala/sdk'

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

export async function handle<TContext extends Context>(c: TContext) {
  const begin = Date.now()

  const [code, abi] = await Promise.all([
    fetchIpfsFile(c.req.param('cid')),
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
}
