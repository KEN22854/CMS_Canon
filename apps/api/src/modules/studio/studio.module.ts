import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { CanonModule } from '../canon/canon.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AgentsService } from './agents.service';
import { PromptsService } from './prompts.service';
import { activateBody, agentBody, playgroundBody, promptTestBody, promptVersionBody, runAgentBody, type AgentBody, type PlaygroundBody, type PromptTestBody, type PromptVersionBody, type RunAgentBody } from './studio.dto';

/**
 * AI Studio: Prompt Manager, Agent Builder and Playground. Everything here is tenant
 * configuration of AI behaviour, so writes need `manage`-level AI rights (admins), while
 * running prompts/agents only needs `invoke`.
 */
@ApiTags('ai-studio')
@ApiBearerAuth()
@Controller({ path: 'ai/studio', version: '1' })
export class StudioController {
  constructor(
    private readonly prompts: PromptsService,
    private readonly agents: AgentsService,
  ) {}

  @Get('prompts')
  @RequirePermission('read', 'AiPrompt')
  listPrompts(@TenantScope() p: TenantPrincipal) {
    return this.prompts.list(p.tenantId);
  }

  @Get('prompts/:name')
  @RequirePermission('read', 'AiPrompt')
  getPrompt(@Param('name') name: string, @TenantScope() p: TenantPrincipal) {
    return this.prompts.get(p.tenantId, name);
  }

  @Post('prompts/:name/versions')
  @RequirePermission('manage', 'Ai')
  @ApiOperation({ summary: 'Create a tenant version of a prompt (becomes active; variables are checked)' })
  createVersion(@Param('name') name: string, @Body(new ZodBody(promptVersionBody)) body: PromptVersionBody, @TenantScope() p: TenantPrincipal) {
    return this.prompts.createVersion(p, name, body);
  }

  @Post('prompts/:name/activate')
  @HttpCode(200)
  @RequirePermission('manage', 'Ai')
  @ApiOperation({ summary: 'Activate a tenant version, or scope=global to fall back to the platform prompt' })
  activate(@Param('name') name: string, @Body(new ZodBody(activateBody)) body: { version: number; scope: 'tenant' | 'global' }, @TenantScope() p: TenantPrincipal) {
    return this.prompts.activate(p, name, body.version, body.scope);
  }

  @Post('prompts/:name/test')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  test(@Param('name') name: string, @Body(new ZodBody(promptTestBody)) body: PromptTestBody, @TenantScope() p: TenantPrincipal) {
    return this.prompts.test(p, name, body);
  }

  @Post('playground')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Run one prompt against up to 3 models side by side (latency, tokens, cost)' })
  playground(@Body(new ZodBody(playgroundBody)) body: PlaygroundBody, @TenantScope() p: TenantPrincipal) {
    return this.prompts.playground(p, body);
  }

  @Get('agents')
  @RequirePermission('read', 'AiAgent')
  listAgents(@TenantScope() p: TenantPrincipal) {
    return this.agents.list(p.tenantId);
  }

  @Post('agents')
  @RequirePermission('manage', 'Ai')
  @ApiOperation({ summary: 'Create a custom agent (system prompt, model, whitelisted read-only tools); plan-limited' })
  createAgent(@Body(new ZodBody(agentBody)) body: AgentBody, @TenantScope() p: TenantPrincipal) {
    return this.agents.create(p, body);
  }

  @Patch('agents/:id')
  @RequirePermission('manage', 'Ai')
  updateAgent(@Param('id') id: string, @Body(new ZodBody(agentBody.partial())) body: Partial<AgentBody>, @TenantScope() p: TenantPrincipal) {
    return this.agents.update(p, id, body);
  }

  @Post('agents/:id/run')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Run an agent on an input (JSON ReAct loop over its tools); returns the run with steps' })
  runAgent(@Param('id') id: string, @Body(new ZodBody(runAgentBody)) body: RunAgentBody, @TenantScope() p: TenantPrincipal) {
    return this.agents.run(p, id, body);
  }

  @Get('runs')
  @RequirePermission('read', 'AiAgent')
  runs(@Query('agentId') agentId: string | undefined, @TenantScope() p: TenantPrincipal) {
    return this.agents.runs(p.tenantId, agentId);
  }

  @Get('runs/:id')
  @RequirePermission('read', 'AiAgent')
  run(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.agents.runDetail(p.tenantId, id);
  }
}

@Module({
  imports: [IntelligenceModule, CanonModule, KnowledgeModule, TenancyModule],
  controllers: [StudioController],
  providers: [PromptsService, AgentsService],
})
export class StudioModule {}
