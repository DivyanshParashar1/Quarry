export class JobForgeError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = this.constructor.name;
  }
}

export class ConfigError extends JobForgeError {}
export class PluginError extends JobForgeError {}
export class LLMError extends JobForgeError {}
export class ValidationError extends JobForgeError {}
