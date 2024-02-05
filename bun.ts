import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { timing } from 'hono/timing'
import { zValidator } from '@hono/zod-validator'
import { ThirdwebStorage } from "@thirdweb-dev/storage"
import * as z from 'zod'

import { runJs, saveSecret, secretSchema, getSecret, visitSecretSchema } from './src/app'

const app = new Hono()

app.use('*', logger())
app.use('*', timing())
app.all('/run_js_from_ipfs/:cid{[a-zA-Z0-9\/]+}', runJs)
app.all('/ipfs/:cid{[a-zA-Z0-9\/]+}', runJs)
app.post('/vaults', zValidator('json', secretSchema), saveSecret)
app.get('/vaults/:key/:token', zValidator('param', visitSecretSchema), getSecret)


const uploadSchema = z.object({
  file: z
    .custom<File>(i => i instanceof File, 'You need upload a file with name "file"')
    .refine(
      // max file size: 500kb
      f => f.size < 1024 * 1024 * 500,
      { message: 'File size should be less than 500kb' }
    )
    .refine(
      // only allow text
      f => f.type.startsWith('text/'),
      { message: 'Only allow plain javascript file' }
    )
})

app.post('/ipfs', async (c) => {
  const body = await c.req.parseBody()
  const result = uploadSchema.safeParse(body)
  if (!result.success) {
    return c.json({ error: result.error?.flatten() }, 400)
  }
  const plain = await result.data.file.text()
  const storage = new ThirdwebStorage({
    secretKey: process.env.THIRDWEB_SECRET,
  })
  const uri = await storage.upload(plain);
  return c.json({ uri })
})

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
}
