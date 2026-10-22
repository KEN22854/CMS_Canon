import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Logical template id — lets tests and logs assert on intent, not on copy. */
  template: string;
}

export abstract class Mailer {
  abstract send(msg: MailMessage): Promise<void>;
}

@Injectable()
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(SmtpMailer.name);
    this.transport = nodemailer.createTransport(config.SMTP_URL);
  }

  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    this.logger.info({ template: msg.template }, 'mail sent');
  }
}

/** Test transport: keeps messages in memory so integration tests can read tokens from "emails". */
@Injectable()
export class MemoryMailer extends Mailer {
  readonly outbox: MailMessage[] = [];

  async send(msg: MailMessage): Promise<void> {
    this.outbox.push(msg);
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.to === email);
  }
}

@Global()
@Module({
  providers: [
    SmtpMailer,
    MemoryMailer,
    {
      provide: Mailer,
      inject: [APP_CONFIG, SmtpMailer, MemoryMailer],
      useFactory: (config: AppConfig, smtp: SmtpMailer, memory: MemoryMailer) => (config.MAIL_TRANSPORT === 'memory' ? memory : smtp),
    },
  ],
  exports: [Mailer, MemoryMailer],
})
export class MailModule {}
