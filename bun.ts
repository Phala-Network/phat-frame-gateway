import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { timing } from 'hono/timing'
import { zValidator } from '@hono/zod-validator'

import { runJs, saveSecret, secretSchema, getSecret, visitSecretSchema } from './src/app'

const app = new Hono()

app.use('*', logger())
app.use('*', timing())
app.all('/run_js_from_ipfs/:cid{[a-zA-Z0-9\/]+}', runJs)
app.all('/ipfs/:cid{[a-zA-Z0-9\/]+}', runJs)
app.post('/vaults', zValidator('json', secretSchema), saveSecret)
app.get('/vaults/:key/:token', zValidator('param', visitSecretSchema), getSecret)

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
}
