import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public, RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { DeliveryTokenGuard } from '../delivery/delivery.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { SitesModule } from '../sites/sites.module';
import {
  createFormBody,
  submissionsQuery,
  submitBody,
  updateFormBody,
  updateSubmissionBody,
  type CreateFormBody,
  type SubmissionsQuery,
  type SubmitBody,
  type UpdateFormBody,
} from './forms.dto';
import { FormsService } from './forms.service';

@ApiTags('forms')
@ApiBearerAuth()
@Controller({ version: '1' })
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get('sites/:siteId/forms')
  @RequirePermission('read', 'Form')
  list(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.forms.list(p.tenantId, siteId);
  }

  @Post('sites/:siteId/forms')
  @RequirePermission('create', 'Form')
  @ApiOperation({ summary: 'Create a form: fields, success message or redirect, notification e-mails' })
  create(
    @Param('siteId') siteId: string,
    @Body(new ZodBody(createFormBody)) body: CreateFormBody,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.forms.create(p, siteId, body);
  }

  @Get('forms/:formId')
  @RequirePermission('read', 'Form')
  async get(@Param('formId') formId: string, @TenantScope() p: TenantPrincipal) {
    return this.forms.present(await this.forms.get(p.tenantId, formId));
  }

  @Patch('forms/:formId')
  @RequirePermission('update', 'Form')
  update(
    @Param('formId') formId: string,
    @Body(new ZodBody(updateFormBody)) body: UpdateFormBody,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.forms.update(p, formId, body);
  }

  @Delete('forms/:formId')
  @HttpCode(204)
  @RequirePermission('delete', 'Form')
  async remove(@Param('formId') formId: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.forms.remove(p, formId);
  }

  @Get('forms/:formId/submissions')
  @RequirePermission('read', 'Form')
  @ApiOperation({ summary: 'Submissions inbox (spam hidden unless status=SPAM), with counts per status' })
  submissions(
    @Param('formId') formId: string,
    @Query(new ZodBody(submissionsQuery)) q: SubmissionsQuery,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.forms.submissions(p.tenantId, formId, q);
  }

  @Get('forms/:formId/submissions/export')
  @RequirePermission('read', 'Form')
  async export(
    @Param('formId') formId: string,
    @TenantScope() p: TenantPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.forms.exportCsv(p, formId);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="submissions-${formId}.csv"`);
    res.send(csv);
  }

  @Patch('form-submissions/:id')
  @RequirePermission('update', 'Form')
  setStatus(
    @Param('id') id: string,
    @Body(new ZodBody(updateSubmissionBody)) body: z.infer<typeof updateSubmissionBody>,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.forms.setStatus(p, id, body.status);
  }

  @Delete('form-submissions/:id')
  @HttpCode(204)
  @RequirePermission('delete', 'Form')
  @ApiOperation({ summary: 'Erase a submission (GDPR request)' })
  async erase(@Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.forms.deleteSubmission(p, id);
  }
}

/** Called only by the platform renderer, which proxies the visitor's post from the site's origin. */
@ApiExcludeController()
@Public()
@UseGuards(DeliveryTokenGuard)
@Controller({ path: 'delivery/forms', version: '1' })
export class FormSubmitController {
  constructor(private readonly forms: FormsService) {}

  @Post(':formId/submit')
  @HttpCode(202)
  submit(
    @Param('formId') formId: string,
    @Body(new ZodBody(submitBody)) body: SubmitBody,
    @Req() req: Request,
  ) {
    return this.forms.submit(formId, body, {
      ip: req.header('x-canon-ip') ?? null,
      userAgent: req.header('x-canon-ua') ?? null,
      host: req.header('x-canon-host') ?? null,
      country: (req.header('x-canon-country') ?? '').toUpperCase().slice(0, 2) || null,
    });
  }
}

@Module({
  imports: [SitesModule, DeliveryModule, IntelligenceModule],
  controllers: [FormsController, FormSubmitController],
  providers: [FormsService],
  exports: [FormsService],
})
export class FormsModule {}
