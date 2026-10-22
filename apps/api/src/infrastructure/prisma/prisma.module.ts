import { Global, Module } from '@nestjs/common';
import { PrismaService, SystemPrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, SystemPrismaService],
  exports: [PrismaService, SystemPrismaService],
})
export class PrismaModule {}
