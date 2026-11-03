import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { DomainsController, TlsAskController } from './domains.controller';
import { DomainsService } from './domains.service';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

@Module({
  imports: [TenancyModule],
  controllers: [SitesController, DomainsController, TlsAskController],
  providers: [SitesService, DomainsService],
  exports: [SitesService, DomainsService],
})
export class SitesModule {}
