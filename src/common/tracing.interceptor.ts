import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { requestContext } from './request-context';

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      identificadorRastreio?: string;
    }>();
    const id =
      req.headers['x-request-id'] ||
      req.headers['x-trace-id'] ||
      randomUUID();
    req.identificadorRastreio = id;
    return new Observable((subscriber) => {
      requestContext.run({ identificadorRastreio: id }, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
