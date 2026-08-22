import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['debug', 'log', 'warn', 'error', 'verbose'],
  });
  app.enableCors({ origin: true }); // 本地开发用；上线前应改成白名单
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
