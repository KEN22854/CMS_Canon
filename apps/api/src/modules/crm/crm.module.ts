import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { TelegramModule } from '../integrations/telegram.module';
import { SitesModule } from '../sites/sites.module';
import { automationBody, listContactsQuery, noteBody, updateAutomationBody, updateContactBody, type AutomationBody, type UpdateAutomationBody, type UpdateContactBody } from './crm.dto';
import { CrmService } from './crm.service';

@ApiTags('crm')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId', version: '1' })
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('contacts')
  @RequirePermission('read', 'Contact')
  @ApiOperation({ summary: 'Contacts built from form submissions and orders: search (email, name, phone), tag, customers only; tag counts' })
  contacts(@Param('siteId') siteId: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    return this.crm.list(p.tenantId, siteId, new ZodBody(listContactsQuery).transform(query));
  }

  @Get('contacts/:id')
  @RequirePermission('read', 'Contact')
  contact(@Param('siteId') siteId: string, @Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.crm.get(p.tenantId, siteId, id);
  }

  @Patch('contacts/:id')
  @RequirePermission('update', 'Contact')
  update(@Param('siteId') siteId: string, @Param('id') id: string, @Body(new ZodBody(updateContactBody)) body: UpdateContactBody, @TenantScope() p: TenantPrincipal) {
    return this.crm.update(p, siteId, id, body);
  }

  @Post('contacts/:id/notes')
  @HttpCode(200)
  @RequirePermission('update', 'Contact')
  note(@Param('siteId') siteId: string, @Param('id') id: string, @Body(new ZodBody(noteBody)) body: { text: string }, @TenantScope() p: TenantPrincipal) {
    return this.crm.note(p, siteId, id, body.text);
  }

  @Delete('contacts/:id')
  @HttpCode(204)
  @RequirePermission('delete', 'Contact')
  @ApiOperation({ summary: 'Erase a contact and its timeline (orders and submissions keep their own records)' })
  async remove(@Param('siteId') siteId: string, @Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.crm.remove(p, siteId, id);
  }

  @Get('automations')
  @RequirePermission('read', 'Automation')
  automations(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.crm.automations(p.tenantId, siteId);
  }

  @Post('automations')
  @RequirePermission('create', 'Automation')
  @ApiOperation({ summary: 'When form.submitted | order.placed | order.status (+ form, status, minimum total) → email the contact, email the team, add a tag' })
  create(@Param('siteId') siteId: string, @Body(new ZodBody(automationBody)) body: AutomationBody, @TenantScope() p: TenantPrincipal) {
    return this.crm.createAutomation(p, siteId, body);
  }

  @Patch('automations/:id')
  @RequirePermission('update', 'Automation')
  edit(@Param('siteId') siteId: string, @Param('id') id: string, @Body(new ZodBody(updateAutomationBody)) body: UpdateAutomationBody, @TenantScope() p: TenantPrincipal) {
    return this.crm.updateAutomation(p, siteId, id, body);
  }

  @Delete('automations/:id')
  @HttpCode(204)
  @RequirePermission('delete', 'Automation')
  async drop(@Param('siteId') siteId: string, @Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.crm.removeAutomation(p, siteId, id);
  }

  @Get('automations/:id/runs')
  @RequirePermission('read', 'Automation')
  runs(@Param('siteId') siteId: string, @Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.crm.runs(p.tenantId, siteId, id);
  }
}

@Module({
  imports: [SitesModule, TelegramModule],
  controllers: [CrmController],
  providers: [CrmService],
})
export class CrmModule {}
