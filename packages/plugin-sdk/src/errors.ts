import { PluginError } from '@jobforge/shared';

/** Thrown by ScopedHttp for non-2xx responses (after retries) and rejected hosts. */
export class HttpError extends PluginError {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
  ) {
    super(message);
  }

  /** 4xx other than 408/429 won't succeed on retry (e.g. a board token that doesn't exist). */
  get permanent(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export class DomainNotAllowedError extends PluginError {
  constructor(
    readonly host: string,
    readonly pluginId: string,
  ) {
    super(`plugin ${pluginId} is not permitted to reach ${host}`);
  }
}
