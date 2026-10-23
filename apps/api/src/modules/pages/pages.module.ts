import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PagesController } from './pages.controller';
import { PagesService } from './pages.service';
import { PublishScheduler } from './publish-scheduler';
import { ScheduleStore } from './schedule-store';

@Module({ imports: [SitesModule, TenancyModule], controllers: [PagesController], providers: [PagesService, ScheduleStore, PublishScheduler], exports: [PagesService, PublishScheduler] })
export class PagesModule {}
