import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({ imports: [SitesModule, TenancyModule], controllers: [MediaController], providers: [MediaService], exports: [MediaService] })
export class MediaModule {}
