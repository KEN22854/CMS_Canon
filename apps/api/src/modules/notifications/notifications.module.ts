import { Body, Controller, Get, Global, HttpCode, Module, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Principal, type RequestPrincipal } from '../../common/auth/principal';
import { forbidden } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { NotificationsService, prefsBody } from './notifications.service';

const listQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const readBody = z.union([
  z.object({ ids: z.array(z.string().max(40)).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);

const me = (p: RequestPrincipal) => {
  if (!p.userId || p.actorType !== 'user') throw forbidden('Notifications belong to people, not API keys');
  return p.userId;
};

@ApiTags('notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Your notifications, newest first, with the unread count' })
  list(@Query(new ZodBody(listQuery)) q: z.infer<typeof listQuery>, @Principal() p: RequestPrincipal) {
    return this.notifications.list(me(p), { unread: q.unread === 'true', cursor: q.cursor, limit: q.limit });
  }

  @Get('unread-count')
  async unread(@Principal() p: RequestPrincipal) {
    return { unread: await this.notifications.unreadCount(me(p)) };
  }

  @Post('read')
  @HttpCode(200)
  read(@Body(new ZodBody(readBody)) body: z.infer<typeof readBody>, @Principal() p: RequestPrincipal) {
    return this.notifications.markRead(me(p), 'all' in body ? 'all' : body.ids);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'E-mail delivery per notification type: instant, daily digest, or off' })
  prefs(@Principal() p: RequestPrincipal) {
    return this.notifications.preferences(me(p));
  }

  @Put('preferences')
  setPrefs(@Body(new ZodBody(prefsBody)) body: z.infer<typeof prefsBody>, @Principal() p: RequestPrincipal) {
    return this.notifications.setPreferences(me(p), body);
  }
}

/** Global: any module can notify people without importing this module. */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
