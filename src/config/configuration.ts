export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '3306', 10),
    username: process.env.DB_USERNAME ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'library_seat',
  },

  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  bullmq: {
    prefix: process.env.BULLMQ_PREFIX ?? 'library-seat',
  },

  notifyMode: process.env.NOTIFY_MODE ?? 'mock',

  libraryApi: {
    baseUrl:
      process.env.LIBRARY_API_BASE_URL ?? 'https://hdu.huitu.zhishulib.com',
  },
});