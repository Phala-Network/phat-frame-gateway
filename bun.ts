import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'

import { runJs, saveSecret, secretSchema, getSecret, visitSecretSchema } from './src/app'

const app = new Hono()

app.all('/run_js_from_ipfs/:cid/:key?', runJs)
app.all('/ipfs/:cid/:key?', runJs)
app.post('/vaults', zValidator('json', secretSchema), saveSecret)
app.get('/vaults/:key/:token', zValidator('param', visitSecretSchema), getSecret)

export default app
