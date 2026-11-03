import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import {
  ReviewsService,
  commentsQuery,
  createCommentBody,
  decideBody,
  requestReviewBody,
  reviewsQuery,
  updateCommentBody,
} from './reviews.service';

@ApiTags('reviews')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('sites/:siteId/reviews')
  @RequirePermission('read', 'Page')
  @ApiOperation({ summary: 'Review requests on this site (filter by status, item, or "waiting for me")' })
  list(
    @Param('siteId') siteId: string,
    @Query(new ZodBody(reviewsQuery)) q: z.infer<typeof reviewsQuery>,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.reviews.list(p.tenantId, siteId, q, p.userId);
  }

  @Post('sites/:siteId/reviews')
  @RequirePermission('read', 'Page')
  @ApiOperation({ summary: 'Ask for review of the current draft version of a page or entry' })
  request(
    @Param('siteId') siteId: string,
    @Body(new ZodBody(requestReviewBody)) body: z.infer<typeof requestReviewBody>,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.reviews.request(p, siteId, body);
  }

  @Post('reviews/:id/approve')
  @HttpCode(200)
  @RequirePermission('read', 'Page')
  approve(
    @Param('id') id: string,
    @Body(new ZodBody(decideBody)) body: z.infer<typeof decideBody>,
    @TenantScope() p: TenantPrincipal,
    @Req() req: Request,
  ) {
    return this.reviews.decide(p, abilityOf(req), id, 'APPROVED', body.note);
  }

  @Post('reviews/:id/request-changes')
  @HttpCode(200)
  @RequirePermission('read', 'Page')
  requestChanges(
    @Param('id') id: string,
    @Body(new ZodBody(decideBody)) body: z.infer<typeof decideBody>,
    @TenantScope() p: TenantPrincipal,
    @Req() req: Request,
  ) {
    return this.reviews.decide(p, abilityOf(req), id, 'CHANGES_REQUESTED', body.note);
  }

  @Post('reviews/:id/cancel')
  @HttpCode(200)
  @RequirePermission('read', 'Page')
  cancel(@Param('id') id: string, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.reviews.decide(p, abilityOf(req), id, 'CANCELLED');
  }

  @Get('comments')
  @RequirePermission('read', 'Page')
  @ApiOperation({ summary: 'Comment threads on a page or entry, optionally anchored to blocks' })
  comments(
    @Query(new ZodBody(commentsQuery)) q: z.infer<typeof commentsQuery>,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.reviews.comments(p.tenantId, q);
  }

  @Post('comments')
  @RequirePermission('read', 'Page')
  comment(
    @Body(new ZodBody(createCommentBody)) body: z.infer<typeof createCommentBody>,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.reviews.comment(p, body);
  }

  @Patch('comments/:id')
  @RequirePermission('read', 'Page')
  updateComment(
    @Param('id') id: string,
    @Body(new ZodBody(updateCommentBody)) body: z.infer<typeof updateCommentBody>,
    @TenantScope() p: TenantPrincipal,
    @Req() req: Request,
  ) {
    return this.reviews.updateComment(p, abilityOf(req), id, body);
  }

  @Delete('comments/:id')
  @HttpCode(204)
  @RequirePermission('read', 'Page')
  async deleteComment(
    @Param('id') id: string,
    @TenantScope() p: TenantPrincipal,
    @Req() req: Request,
  ): Promise<void> {
    await this.reviews.deleteComment(p, abilityOf(req), id);
  }
}

/** Global: the pages and entries controllers gate publishing through it. */
@Global()
@Module({ controllers: [ReviewsController], providers: [ReviewsService], exports: [ReviewsService] })
export class ReviewsModule {}
