import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PerfisController } from './perfis.controller';

@Module({
  imports: [AuthModule],
  controllers: [PerfisController],
})
export class PerfisModule {}
