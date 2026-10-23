import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

@Module({ imports: [TenancyModule], controllers: [SitesController], providers: [SitesService], exports: [SitesService] })
export class SitesModule {}
