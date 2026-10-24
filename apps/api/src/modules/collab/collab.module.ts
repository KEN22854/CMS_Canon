import { Module } from '@nestjs/common';
import { CollabServer } from './collab.server';

@Module({ providers: [CollabServer], exports: [CollabServer] })
export class CollabModule {}
