import { Module } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { MembersService } from './members.service';
import { InvitationsController, MembersController, TenantsController } from './tenancy.controllers';
import { TenantsService } from './tenants.service';

@Module({
  controllers: [TenantsController, MembersController, InvitationsController],
  providers: [TenantsService, MembersService, InvitationsService],
  exports: [TenantsService, InvitationsService],
})
export class TenancyModule {}
