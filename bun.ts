import { Hono } from 'hono'

import { handle } from './src/app'

const app = new Hono()

app.all('/run_js_from_ipfs/:cid/:id?', handle)

export default app
