import type { Result, Text, Enum } from '@polkadot/types-codec'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { getClient, getContract, KeyringPairProvider, unsafeGetAbiFromPatronByCodeHash } from '@phala/sdk'
import * as R from 'ramda'

const app = new Hono()

const code = `
(()=>{"use strict";globalThis.scriptOutput=function(t){return JSON.stringify({status:200,headers:{"content-type":"text/plain"},body:"Hello, world!"})}.apply(null,globalThis.scriptArgs)})();
`

interface RunResult extends Enum {
  asString: Text
}


function asyncMemoizeWith(keyGen, asyncFn) {
  const cache = new Map()
  return async (...args) => {
    const key = keyGen.apply(this, args)
    if (cache.has(key)) {
      console.log(`cache hit: ${key}`)
      return cache.get(key)
    }
    console.log(`cache miss: ${key}`)
    const result = await asyncFn.apply(this, args)
    cache.set(key, result)
    return result
  }
}

const fetchAbi = asyncMemoizeWith(i => `${i}`, async (codeHash) => {
  return unsafeGetAbiFromPatronByCodeHash(codeHash)
})

const fetchIpfsFile = asyncMemoizeWith(i => `${i}`, async (cid) => {
  const resp = await fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`)
  const text = await resp.text()
  return text
})

app.all('/run_js_from_ipfs/:cid', async (c) => {
  const client = await getClient({
    transport: 'wss://poc6.phala.network/ws',
  })
  const [file, abi] = await Promise.all([
    fetchIpfsFile(c.req.param('cid')),
    fetchAbi('0xb4ed291971360ff5de17845f9922a2bd6930e411e32f33bf0a321735c3fab4a5')
  ])
  const provider = await KeyringPairProvider.createFromSURI(client.api, '//Alice')
  const contract = await getContract({
    client,
    provider,
    abi,
    contractId: '0xf0a398600f02ea9b47a86c59aed61387e450e2a99cb8b921cd1d46f734e45409',
  })

  let body = undefined
  if (c.req.method === 'POST' || c.req.method === 'PATCH' || c.req.method === 'PUT') {
    const buffer = await c.req.arrayBuffer()
    body = Buffer.from(buffer).toString()
  }

  const req = {
    method: c.req.method,
    path: c.req.path,
    headers: Object.fromEntries(c.req.raw.headers.entries()),
    body,
  }
  console.log(req)

  const result = await contract.q.runJs<Result<RunResult, any>>({
    args: ['SidevmQuickJS', code, [JSON.stringify(req)]]
  })
  const payload = JSON.parse(result.output?.asOk.asOk.asString ?? '{}')

  return c.body(payload.body ?? '', payload.status ?? 200, payload.headers ?? {})
})

serve(app)
