import { All, Controller, HttpCode, Module, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RateLimit } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { CanonModule } from '../canon/canon.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PagesModule } from '../pages/pages.module';
import { SitesModule } from '../sites/sites.module';
import { McpFactory } from './mcp.server';

/* eslint-disable @typescript-eslint/no-require-imports */
type TransportModule = typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js', { with: { 'resolution-mode': 'import' } });
const { StreamableHTTPServerTransport }: TransportModule = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
/* eslint-enable @typescript-eslint/no-require-imports */

@ApiTags('mcp')
@ApiBearerAuth()
@Controller({ path: 'mcp', version: '1' })
export class McpController {
  constructor(private readonly factory: McpFactory) {}

  /**
   * Streamable HTTP, stateless: every POST carries its own JSON-RPC message(s) and credentials,
   * so any API replica can serve any call and there is no session to hijack.
   */
  @Post()
  @RateLimit({ bucket: 'mcp', limit: 120, windowSec: 60, by: 'principal' })
  @ApiOperation({ summary: 'Model Context Protocol endpoint (Streamable HTTP). Authenticate with an API key as a Bearer token.' })
  async handle(@TenantScope() p: TenantPrincipal, @Req() req: Request, @Res() res: Response): Promise<void> {
    const server = this.factory.create(p);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  @All()
  @HttpCode(405)
  notAllowed(@Res({ passthrough: true }) res: Response) {
    res.setHeader('allow', 'POST');
    return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST' }, id: null };
  }
}

@Module({
  imports: [SitesModule, PagesModule, KnowledgeModule, CanonModule],
  controllers: [McpController],
  providers: [McpFactory],
})
export class McpModule {}
