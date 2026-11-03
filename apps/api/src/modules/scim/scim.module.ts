import {
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
  VERSION_NEUTRAL,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { Public, RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { ScimError, ScimService, createScimTokenBody } from './scim.service';

const SCIM_JSON = 'application/scim+json';

declare module 'express' {
  interface Request {
    scim?: { tenantId: string; tokenId: string };
  }
}

@ApiTags('sso')
@ApiBearerAuth()
@Controller({ path: 'scim-tokens', version: '1' })
export class ScimTokensController {
  constructor(private readonly scim: ScimService) {}

  @Get()
  @RequirePermission('update', 'Tenant')
  @ApiOperation({ summary: 'SCIM base URL and active provisioning tokens' })
  list(@TenantScope() p: TenantPrincipal) {
    return this.scim.listTokens(p.tenantId);
  }

  @Post()
  @RequirePermission('update', 'Tenant')
  @ApiOperation({ summary: 'Create a SCIM bearer token for your identity provider (shown once)' })
  create(
    @Body(new ZodBody(createScimTokenBody)) body: z.infer<typeof createScimTokenBody>,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.scim.createToken(p, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('update', 'Tenant')
  async revoke(@Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.scim.revokeToken(p, id);
  }
}

@Injectable()
class ScimAuthGuard implements CanActivate {
  constructor(private readonly scim: ScimService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    req.scim = await this.scim.authenticate(
      /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : undefined,
    );
    return true;
  }
}

/** RFC 7644 §3.12 error bodies instead of Canon's `{ error }` envelope. */
@Catch()
class ScimExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status =
      err instanceof ScimError ? err.status : err instanceof HttpException ? err.getStatus() : 500;
    const detail =
      err instanceof ScimError ? err.message : err instanceof HttpException ? err.message : 'Internal error';
    res
      .status(status)
      .type(SCIM_JSON)
      .json({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: String(status),
        detail,
        ...(err instanceof ScimError && err.scimType ? { scimType: err.scimType } : {}),
      });
  }
}

const tenant = (req: Request) => req.scim!;

@Public()
@ApiExcludeController()
@UseGuards(ScimAuthGuard)
@UseFilters(ScimExceptionFilter)
@Controller({ path: 'scim/v2', version: VERSION_NEUTRAL })
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  private send(res: Response, status: number, body: unknown): void {
    res.status(status).type(SCIM_JSON).json(body);
  }

  @Get('ServiceProviderConfig')
  config(@Res() res: Response) {
    this.send(res, 200, this.scim.serviceProviderConfig());
  }

  @Get('ResourceTypes')
  resourceTypes(@Res() res: Response) {
    this.send(res, 200, this.scim.resourceTypes());
  }

  @Get('Schemas')
  schemas(@Res() res: Response) {
    this.send(res, 200, this.scim.schemas());
  }

  @Get('Users')
  async list(@Req() req: Request, @Query() q: Record<string, string>, @Res() res: Response) {
    this.send(res, 200, await this.scim.listUsers(tenant(req).tenantId, q));
  }

  @Get('Users/:id')
  async get(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    this.send(res, 200, await this.scim.getUser(tenant(req).tenantId, id));
  }

  @Post('Users')
  async create(@Req() req: Request, @Body() body: unknown, @Res() res: Response) {
    this.send(res, 201, await this.scim.createUser(tenant(req).tenantId, tenant(req).tokenId, body));
  }

  @Put('Users/:id')
  async replace(@Req() req: Request, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    this.send(res, 200, await this.scim.replaceUser(tenant(req).tenantId, tenant(req).tokenId, id, body));
  }

  @Patch('Users/:id')
  async patch(@Req() req: Request, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    this.send(res, 200, await this.scim.patchUser(tenant(req).tenantId, tenant(req).tokenId, id, body));
  }

  @Delete('Users/:id')
  async remove(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    await this.scim.deleteUser(tenant(req).tenantId, tenant(req).tokenId, id);
    res.status(204).end();
  }
}

@Module({ controllers: [ScimTokensController, ScimController], providers: [ScimService, ScimAuthGuard] })
export class ScimModule {}
