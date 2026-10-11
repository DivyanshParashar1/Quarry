export class QuarryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = this.constructor.name;
  }
}

export class ConfigError extends QuarryError {}
export class PluginError extends QuarryError {}
export class LLMError extends QuarryError {}
export class ValidationError extends QuarryError {}
