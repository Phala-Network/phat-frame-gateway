import * as fs from 'node:fs'
import Redis from 'ioredis'

export type MemoizeAdapter = 'memory' | 'redis' | 'fs'

interface MemoizeOptions<TArgs extends Array<any>> {
  keyGen: (...args: TArgs) => string
  adapters: [MemoizeAdapter, ...MemoizeAdapter[]]
  ttl?: number
}

export function memoize<TResult = unknown, TArgs extends Array<any> = any[]>(
  options: MemoizeOptions<TArgs>,
  asyncFn: (...args: TArgs) => Promise<TResult>
) {
  const { keyGen, adapters, ttl = 3600 * 24 } = options

  const cache = new Map()

  return async function (...args: TArgs) {
    const key = keyGen.apply(null, args)

    let redis: Redis | undefined = undefined
    if (process.env.MEMOIZE_REDIS_URI) {
      redis = new Redis(process.env.MEMOIZE_REDIS_URI)
    }

    try {
      for (let adapter of adapters) {
        switch (adapter) {
          case 'memory':
            if (cache.has(key)) {
              console.log(`cache hit: ${key}`)
              return cache.get(key)
            }
            break

          case 'redis':
            if (!redis) {
              throw new Error('redis adapter requires setup environment variable MEMOIZE_REDIS_URI first.')
            }
            const result = await redis.get(key)
            if (result) {
              console.log(`cache hit: ${key}`)
              return JSON.parse(result).data
            }
            break

          case 'fs':
            const restrictPrefix = fs.realpathSync('./storage')
            const unsafePath = `./storage/${key}`
            if (!fs.existsSync(unsafePath)) {
              break
            }
            const fullpath = fs.realpathSync(unsafePath)
            if (!fullpath.startsWith(restrictPrefix)) {
              console.log(fullpath)
              console.log(unsafePath)
              throw new Error(`malformed key: ${key}`)
            }
            console.log(`cache hit: ${key}`)
            const raw = fs.readFileSync(fullpath, 'utf-8')
            return JSON.parse(raw)
        }
      }

      console.log(`cache miss: ${key}`)
      const result = await asyncFn.apply(null, args)

      for (let adapter of adapters) {
        switch (adapter) {
          case 'memory':
            cache.set(key, result)
            break

          case 'redis':
            if (!redis) {
              throw new Error('redis adapter requires setup environment variable MEMOIZE_REDIS_URI first.')
            }
            await redis.set(key, JSON.stringify({data: result}), 'EX', ttl)
            break

          case 'fs':
            fs.writeFileSync(`./storage/${key}`, JSON.stringify(result))
            break
        }
      }

      return result
    } finally {
      if (redis) {
        redis.disconnect()
        redis.quit()
      }
    }
  }
}

